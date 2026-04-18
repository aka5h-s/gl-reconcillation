// ds-service-highvolume.test.js
// Unit tests verifying that getDSDataByDate correctly returns all records on a high-volume day
// by iterating per GL account, bypassing the 1000-record single-query cap in Datasphere.
//
// Scenario modelled on January 28 2026, where the old single-query approach returned only a
// partial result. The new per-GL-account approach should aggregate the true total across
// all GL accounts.
//
// Run with: node --test gl-reconciliation-clean/srv/services/__tests__/ds-service-highvolume.test.js

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Module  = require('module');

// ---------------------------------------------------------------------------
// Helpers to build mock Datasphere response pages
// ---------------------------------------------------------------------------

function makeRecords(glAccount, count, startIndex = 0) {
  return Array.from({ length: count }, (_, i) => ({
    SourceLedger:                '0L',
    CompanyCode:                 '1010',
    FiscalYear:                  '2026',
    AccountingDocument:          String(1000000 + startIndex + i),
    LedgerGLLineItem:            String(i + 1),
    AmountInTransactionCurrency: String((Math.random() * 10000).toFixed(2)),
    GLAccount:                   glAccount,
    LastChangeDateTime:          '20260128120000'
  }));
}

// ---------------------------------------------------------------------------
// High-volume scenario fixture — simulates Jan 28 2026 data
//
// 12 GL accounts, each with 120-180 records.  Total = 1 860 records.
// A single-query cap of 1000 would miss 860 of these records.
// ---------------------------------------------------------------------------

const GL_ACCOUNTS_FIXTURE = [
  { GLAccount: '0000400000', count: 180 },
  { GLAccount: '0000400010', count: 165 },
  { GLAccount: '0000400020', count: 155 },
  { GLAccount: '0000400030', count: 148 },
  { GLAccount: '0000400040', count: 140 },
  { GLAccount: '0000400050', count: 138 },
  { GLAccount: '0000400060', count: 175 },
  { GLAccount: '0000400070', count: 125 },
  { GLAccount: '0000400080', count: 190 },
  { GLAccount: '0000400090', count: 162 },
  { GLAccount: '0000400100', count: 143 },
  { GLAccount: '0000400110', count: 139 },
];

const EXPECTED_TOTAL = GL_ACCOUNTS_FIXTURE.reduce((sum, a) => sum + a.count, 0); // 1 860

// Build the per-account record map that the mock DS connector will serve
const ACCOUNT_RECORDS = {};
let offset = 0;
for (const { GLAccount, count } of GL_ACCOUNTS_FIXTURE) {
  ACCOUNT_RECORDS[GLAccount] = makeRecords(GLAccount, count, offset);
  offset += count;
}

// ---------------------------------------------------------------------------
// Log capture — replace cds.log so we can assert on emitted messages
// ---------------------------------------------------------------------------

const capturedLogs = [];

function makeCdsLog(_name) {
  return {
    info:  (...args) => capturedLogs.push({ level: 'info',  msg: args.join(' ') }),
    warn:  (...args) => capturedLogs.push({ level: 'warn',  msg: args.join(' ') }),
    error: (...args) => capturedLogs.push({ level: 'error', msg: args.join(' ') }),
  };
}

// ---------------------------------------------------------------------------
// Mock @sap/cds
//
// cds.connect.to('DATASPHERE') returns a mock DS client whose .get() method
// parses the OData filter and returns the appropriate fixture records.
// ---------------------------------------------------------------------------

function parseDSFilter(url) {
  // Extract GLAccount from filters like: GLAccount eq '0000400000' and ...
  const glMatch = url.match(/GLAccount eq '([^']+)'/);
  return glMatch ? glMatch[1] : null;
}

// Default handler: per-account queries return all fixture records; no-GL queries are capped at 1000.
// Tests can temporarily replace this with mockDSClient._getHandler to exercise different paths.
function defaultGetHandler(url) {
  const glAccount = parseDSFilter(url);

  if (!glAccount) {
    // No GL account filter — single-query path (getDSDataForPeriod).
    // Return only 1000 records (simulating Datasphere's cap, no nextLink).
    const allFlat = Object.values(ACCOUNT_RECORDS).flat();
    return { value: allFlat.slice(0, 1000) };
  }

  // Per-account path — return all records for that account (each account < 1000).
  const records = ACCOUNT_RECORDS[glAccount] || [];
  return { value: records };
}

const mockDSClient = {
  _getHandler: defaultGetHandler,
  get: async (url) => mockDSClient._getHandler(url),
};

const mockCds = {
  log:        makeCdsLog,
  connect:    { to: async () => mockDSClient },
};

// ---------------------------------------------------------------------------
// Module interception: inject mockCds before requiring ds-service.js
// ---------------------------------------------------------------------------

let originalLoad;
let dsService;

before(() => {
  originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@sap/cds') return mockCds;
    return originalLoad.apply(this, arguments);
  };

  // Clear cache so the mock is picked up cleanly
  const svcPath = require.resolve('../ds-service.js');
  delete require.cache[svcPath];

  dsService = require('../ds-service.js');
});

after(() => {
  Module._load = originalLoad;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getDSDataByDate — high-volume day verification (Jan 28 2026 scenario)', () => {

  // glAccounts list mirrors what getDSGLCountByDate would return in Step 2
  const glAccountsInput = GL_ACCOUNTS_FIXTURE.map(({ GLAccount, count }) => ({
    GLAccount,
    RecordCount: count
  }));

  test('returns more than 1000 records across all GL accounts', async () => {
    capturedLogs.length = 0;

    const records = await dsService.getDSDataByDate(
      '2026-01-28',
      24,               // full day: 00:00-24:00
      glAccountsInput
    );

    assert.ok(
      records.length > 1000,
      `Expected more than 1000 records but got ${records.length}. ` +
      'The per-GL-account approach must exceed the single-query cap of 1000.'
    );
    assert.equal(
      records.length,
      EXPECTED_TOTAL,
      `Expected exactly ${EXPECTED_TOTAL} records but got ${records.length}.`
    );
  });

  test('emits one "DS account XXXXXXXX: N records" log line per GL account', async () => {
    capturedLogs.length = 0;

    await dsService.getDSDataByDate('2026-01-28', 24, glAccountsInput);

    const perAccountLines = capturedLogs.filter(
      l => l.level === 'info' && /^DS account \d+: \d+ records$/.test(l.msg)
    );

    assert.equal(
      perAccountLines.length,
      GL_ACCOUNTS_FIXTURE.length,
      `Expected one log line per GL account (${GL_ACCOUNTS_FIXTURE.length}) ` +
      `but found ${perAccountLines.length}. Per-account iteration is not logging correctly.`
    );
  });

  test('sum of per-account log counts matches total returned records', async () => {
    capturedLogs.length = 0;

    const records = await dsService.getDSDataByDate('2026-01-28', 24, glAccountsInput);

    const perAccountLines = capturedLogs.filter(
      l => l.level === 'info' && /^DS account \d+: \d+ records$/.test(l.msg)
    );

    const loggedSum = perAccountLines.reduce((sum, l) => {
      const match = l.msg.match(/: (\d+) records$/);
      return sum + (match ? parseInt(match[1], 10) : 0);
    }, 0);

    assert.equal(
      loggedSum,
      records.length,
      `Sum of per-account logged counts (${loggedSum}) does not match ` +
      `total records returned (${records.length}).`
    );
  });

  test('sum of per-account log counts matches getDSCountByDate aggregate total', async () => {
    capturedLogs.length = 0;

    // getDSCountByDate uses $apply=filter/aggregate which the mock does not implement
    // natively. We verify instead that per-account sum = fixture total, which matches
    // what a real getDSCountByDate call would return.
    const glInputForCount = GL_ACCOUNTS_FIXTURE.map(({ GLAccount, count }) => ({
      GLAccount,
      RecordCount: count
    }));

    const records = await dsService.getDSDataByDate('2026-01-28', 24, glInputForCount);

    // The GL account list itself encodes the expected total (from getDSGLCountByDate / Step 2)
    const expectedFromStep2 = glInputForCount.reduce((s, a) => s + a.RecordCount, 0);

    assert.equal(
      records.length,
      expectedFromStep2,
      `getDSDataByDate returned ${records.length} records but Step-2 count was ${expectedFromStep2}. ` +
      'Per-account fetch total must equal the Step-2 aggregate count.'
    );
  });

  test('single-query path (getDSDataForPeriod) is capped at 1000 — confirming why per-account is needed', async () => {
    capturedLogs.length = 0;

    // getDSDataForPeriod uses no GL account filter — mock returns only 1000 records,
    // simulating the Datasphere cap.  This confirms that the old approach would miss records.
    const periodicRecords = await dsService.getDSDataForPeriod(
      '20260128000000',
      '20260129000000'
    );

    assert.equal(
      periodicRecords.length,
      1000,
      `getDSDataForPeriod should be capped at 1000 by the mock (simulating Datasphere behaviour) ` +
      `but returned ${periodicRecords.length}.`
    );

    assert.ok(
      EXPECTED_TOTAL > periodicRecords.length,
      `Total fixture records (${EXPECTED_TOTAL}) should exceed the single-query cap ` +
      `(${periodicRecords.length}) to demonstrate that per-account iteration is necessary.`
    );
  });

  test('each GL account receives exactly the correct record count', async () => {
    capturedLogs.length = 0;

    await dsService.getDSDataByDate('2026-01-28', 24, glAccountsInput);

    const perAccountLines = capturedLogs.filter(
      l => l.level === 'info' && /^DS account \d+: \d+ records$/.test(l.msg)
    );

    for (const { GLAccount, count } of GL_ACCOUNTS_FIXTURE) {
      const line = perAccountLines.find(l => l.msg.startsWith(`DS account ${GLAccount}:`));
      assert.ok(line, `No log line found for GL account ${GLAccount}`);

      const match = line.msg.match(/: (\d+) records$/);
      const logged = match ? parseInt(match[1], 10) : -1;
      assert.equal(
        logged,
        count,
        `GL account ${GLAccount}: logged count (${logged}) differs from fixture count (${count})`
      );
    }
  });

  test('handles an account with zero records without corrupting the total', async () => {
    capturedLogs.length = 0;

    const inputWithEmpty = [
      ...glAccountsInput,
      { GLAccount: '0000999999', RecordCount: 0 }
    ];
    ACCOUNT_RECORDS['0000999999'] = [];

    const records = await dsService.getDSDataByDate('2026-01-28', 24, inputWithEmpty);

    assert.equal(
      records.length,
      EXPECTED_TOTAL,  // total must not change — zero-record account adds nothing
      `Adding a zero-record GL account changed the total to ${records.length} (expected ${EXPECTED_TOTAL}).`
    );

    // Clean up fixture addition
    delete ACCOUNT_RECORDS['0000999999'];
  });

  test('inner per-account pagination: a single GL account with >999 records is fully fetched via $skip offset', async () => {
    // Verify the while(true) inner pagination loop in getDSDataByDate fires correctly
    // when a single GL account returns exactly PAGE_SIZE (999) records on the first
    // page, triggering a second fetch with $skip=999.
    //
    // getDSDataByDate uses $top/$skip offset pagination (not $skiptoken / nextLink)
    // because Datasphere does not return @odata.nextLink for per-account ACDOCA queries.
    // The loop breaks when a page returns fewer records than PAGE_SIZE (999).
    //
    // Scenario: account '0000500000' has 1 500 records split across two pages.
    //   Page 1: $skip=0   → 999 records (== PAGE_SIZE, so loop continues)
    //   Page 2: $skip=999 → 501 records (<  PAGE_SIZE, so loop stops)
    //
    // All other accounts return their normal fixture data (< 999 records each).

    const BIG_ACCOUNT = '0000500000';
    const PAGE_SIZE   = 999;          // must match ds-service.js constant
    const PAGE1_SIZE  = PAGE_SIZE;    // full page → triggers a second fetch
    const PAGE2_SIZE  = 501;
    const BIG_TOTAL   = PAGE1_SIZE + PAGE2_SIZE; // 1 500

    const page1Records = makeRecords(BIG_ACCOUNT, PAGE1_SIZE, 9000000);
    const page2Records = makeRecords(BIG_ACCOUNT, PAGE2_SIZE, 9001000);

    const bigAccountInput = [
      { GLAccount: BIG_ACCOUNT, RecordCount: BIG_TOTAL },
      ...glAccountsInput,
    ];

    mockDSClient._getHandler = (url) => {
      const glAccount = parseDSFilter(url);

      if (!glAccount) {
        const allFlat = Object.values(ACCOUNT_RECORDS).flat();
        return { value: allFlat.slice(0, 1000) };
      }

      if (glAccount !== BIG_ACCOUNT) {
        return { value: ACCOUNT_RECORDS[glAccount] || [] };
      }

      // Big account: detect which page by reading $skip from the URL.
      // $skip=0 (or absent) → page 1 (PAGE_SIZE records, loop continues).
      // $skip=PAGE_SIZE     → page 2 (remainder, loop stops).
      const skipMatch = url.match(/\$skip=(\d+)/);
      const skip = skipMatch ? parseInt(skipMatch[1], 10) : 0;

      return { value: skip === 0 ? page1Records : page2Records };
    };

    capturedLogs.length = 0;

    let records;
    try {
      records = await dsService.getDSDataByDate('2026-01-28', 24, bigAccountInput);
    } finally {
      // Always restore the default handler so later tests are unaffected
      mockDSClient._getHandler = defaultGetHandler;
    }

    const expectedGrandTotal = BIG_TOTAL + EXPECTED_TOTAL;

    assert.equal(
      records.length,
      expectedGrandTotal,
      `Expected ${expectedGrandTotal} total records (${BIG_TOTAL} from big account + ` +
      `${EXPECTED_TOTAL} from normal accounts) but got ${records.length}.`
    );

    // The log for the big account should show 1500 (both pages combined)
    const bigAccountLog = capturedLogs.find(
      l => l.level === 'info' && l.msg.startsWith(`DS account ${BIG_ACCOUNT}:`)
    );
    assert.ok(bigAccountLog, `No log line found for big account ${BIG_ACCOUNT}`);

    const loggedCount = parseInt(bigAccountLog.msg.match(/: (\d+) records$/)?.[1] ?? '-1', 10);
    assert.equal(
      loggedCount,
      BIG_TOTAL,
      `Big-account log shows ${loggedCount} records but expected ${BIG_TOTAL} ` +
      '(inner $skip offset pagination should combine both pages before logging).'
    );
  });

});
