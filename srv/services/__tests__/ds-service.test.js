'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Module  = require('module');

const capturedLogs = [];

function makeCdsLog() {
  return {
    info:  (...args) => capturedLogs.push({ level: 'info',  msg: args.join(' ') }),
    warn:  (...args) => capturedLogs.push({ level: 'warn',  msg: args.join(' ') }),
    error: (...args) => capturedLogs.push({ level: 'error', msg: args.join(' ') }),
  };
}

// Mutable DS connector mock — tests control dsResponses
const dsResponses = {
  handler: async () => ({ value: [] })
};

const mockDsClient = {
  get: async (url) => dsResponses.handler(url)
};

let dsService;
let originalLoad;

before(() => {
  originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@sap/cds') return {
      log: makeCdsLog,
      connect: { to: async () => mockDsClient }
    };
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../ds-service.js')];
  dsService = require('../ds-service.js');
});

after(() => {
  Module._load = originalLoad;
});

// ---------------------------------------------------------------------------
// formatDSDateTime — pure function (accessed via getDSCountByDate URL checks)
// ---------------------------------------------------------------------------

describe('formatDSDateTime — 14-digit datetime format', () => {

  test('hour 0 produces 000000 suffix', async () => {
    capturedLogs.length = 0;
    let capturedUrl = '';
    dsResponses.handler = async (url) => {
      capturedUrl = url;
      return { value: [{ TotalCount: '0' }] };
    };
    await dsService.getDSCountByDate('2026-03-31', 0);
    assert.ok(capturedUrl.includes('20260331000000'), 'Start (hour 0) must produce 20260331000000');
  });

  test('hour 23 produces 230000 suffix', async () => {
    capturedLogs.length = 0;
    let capturedUrl = '';
    dsResponses.handler = async (url) => {
      capturedUrl = url;
      return { value: [{ TotalCount: '0' }] };
    };
    await dsService.getDSCountByDate('2026-03-31', 23);
    assert.ok(capturedUrl.includes('20260331230000'), 'End (hour 23) must produce 20260331230000');
  });

  test('dashes are stripped from date part', async () => {
    capturedLogs.length = 0;
    let capturedUrl = '';
    dsResponses.handler = async (url) => {
      capturedUrl = url;
      return { value: [{ TotalCount: '0' }] };
    };
    await dsService.getDSCountByDate('2026-01-05', 12);
    assert.ok(capturedUrl.includes('20260105'), 'Date must be formatted without dashes');
  });

  test('single-digit hour is zero-padded', async () => {
    capturedLogs.length = 0;
    let capturedUrl = '';
    dsResponses.handler = async (url) => {
      capturedUrl = url;
      return { value: [{ TotalCount: '0' }] };
    };
    await dsService.getDSCountByDate('2026-03-31', 4);
    assert.ok(capturedUrl.includes('20260331040000'), 'Hour 4 must be padded to 040000');
  });

});

// ---------------------------------------------------------------------------
// extractSkiptoken — pure function tested via getDSDataForPeriod pagination
// ---------------------------------------------------------------------------

describe('extractSkiptoken — pagination cursor extraction', () => {

  test('returns null for null/undefined input', async () => {
    capturedLogs.length = 0;
    let paginationFired = false;
    let callN = 0;
    dsResponses.handler = async () => {
      callN++;
      if (callN === 1) {
        // No nextLink — extractSkiptoken(undefined) must return null → loop ends
        return { value: Array.from({ length: 5 }, (_, i) => ({ AccountingDocument: String(i) })) };
      }
      paginationFired = true;
      return { value: [] };
    };
    await dsService.getDSDataForPeriod('20260331000000', '20260331230000');
    assert.equal(paginationFired, false, 'No second page should be fetched when nextLink is absent');
  });

  test('extracts skiptoken from a nextLink URL and triggers second page fetch', async () => {
    capturedLogs.length = 0;
    let callN = 0;
    dsResponses.handler = async () => {
      callN++;
      if (callN === 1) {
        return {
          value: Array.from({ length: 1000 }, (_, i) => ({ AccountingDocument: String(i) })),
          '@odata.nextLink': 'https://datasphere.local/entity?$skiptoken=abc123'
        };
      }
      return { value: [{ AccountingDocument: '9999' }] };
    };
    const records = await dsService.getDSDataForPeriod('20260331000000', '20260331230000');
    assert.equal(callN, 2, 'Should make exactly 2 requests (page 1 + page 2 via skiptoken)');
    assert.equal(records.length, 1001);
  });

  test('handles malformed nextLink gracefully — falls back to regex extraction', async () => {
    capturedLogs.length = 0;
    let callN = 0;
    dsResponses.handler = async (url) => {
      callN++;
      if (callN === 1) {
        return {
          value: Array.from({ length: 1000 }, (_, i) => ({ AccountingDocument: String(i) })),
          '@odata.nextLink': 'not-a-valid-url?$skiptoken=fallbacktoken'
        };
      }
      return { value: [{ AccountingDocument: '9999' }] };
    };
    const records = await dsService.getDSDataForPeriod('20260331000000', '20260331230000');
    assert.equal(callN, 2, 'Fallback regex extraction should still trigger second page');
    assert.equal(records.length, 1001);
  });

});

// ---------------------------------------------------------------------------
// getDSCountByDate — total record count
// ---------------------------------------------------------------------------

describe('getDSCountByDate — total count from DS', () => {

  test('returns parsed integer count from TotalCount field', async () => {
    capturedLogs.length = 0;
    dsResponses.handler = async () => ({ value: [{ TotalCount: '22' }] });
    const count = await dsService.getDSCountByDate('2026-03-31', 23);
    assert.equal(count, 22);
  });

  test('parses TotalCount even when returned as string', async () => {
    capturedLogs.length = 0;
    dsResponses.handler = async () => ({ value: [{ TotalCount: '1500' }] });
    const count = await dsService.getDSCountByDate('2026-01-28', 24);
    assert.equal(typeof count, 'number');
    assert.equal(count, 1500);
  });

  test('returns 0 when value array is empty', async () => {
    capturedLogs.length = 0;
    dsResponses.handler = async () => ({ value: [] });
    const count = await dsService.getDSCountByDate('2026-03-31', 23);
    assert.equal(count, 0);
  });

  test('throws when DS connector fails', async () => {
    capturedLogs.length = 0;
    dsResponses.handler = async () => { throw new Error('DS timeout'); };
    await assert.rejects(
      () => dsService.getDSCountByDate('2026-03-31', 23),
      /DS count failed/
    );
  });

  test('filter uses correct start (00:00) and end (startHour:00) boundaries', async () => {
    capturedLogs.length = 0;
    let capturedUrl = '';
    dsResponses.handler = async (url) => {
      capturedUrl = url;
      return { value: [{ TotalCount: '0' }] };
    };
    await dsService.getDSCountByDate('2026-03-31', 12);
    assert.ok(capturedUrl.includes('20260331000000'), 'Start must be midnight');
    assert.ok(capturedUrl.includes('20260331120000'), 'End must be startHour');
    assert.ok(capturedUrl.includes('ge'), 'Filter must use ge for start');
    assert.ok(capturedUrl.includes(' lt '), 'Filter must use lt for end');
  });

});

// ---------------------------------------------------------------------------
// getDSGLCountByDate — per-GL account counts
// ---------------------------------------------------------------------------

describe('getDSGLCountByDate — per-GL account breakdown', () => {

  test('returns array of GLAccount + RecordCount pairs', async () => {
    capturedLogs.length = 0;
    dsResponses.handler = async () => ({
      value: [
        { GLAccount: '0000400000', RecordCount: '10' },
        { GLAccount: '0000400010', RecordCount: '12' }
      ]
    });
    const data = await dsService.getDSGLCountByDate('2026-03-31', 23);
    assert.equal(data.length, 2);
    assert.equal(data[0].GLAccount, '0000400000');
    assert.equal(data[0].RecordCount, 10);
    assert.equal(typeof data[0].RecordCount, 'number', 'RecordCount must be integer, not string');
  });

  test('normalises RecordCount from string to integer', async () => {
    capturedLogs.length = 0;
    dsResponses.handler = async () => ({
      value: [{ GLAccount: '0000400000', RecordCount: '999' }]
    });
    const data = await dsService.getDSGLCountByDate('2026-03-31', 23);
    assert.equal(data[0].RecordCount, 999);
    assert.equal(typeof data[0].RecordCount, 'number');
  });

  test('returns empty array when no GL accounts found', async () => {
    capturedLogs.length = 0;
    dsResponses.handler = async () => ({ value: [] });
    const data = await dsService.getDSGLCountByDate('2026-03-31', 23);
    assert.equal(data.length, 0);
  });

  test('throws when DS connector fails', async () => {
    capturedLogs.length = 0;
    dsResponses.handler = async () => { throw new Error('DS error'); };
    await assert.rejects(
      () => dsService.getDSGLCountByDate('2026-03-31', 23),
      /DS GL count failed/
    );
  });

});

// ---------------------------------------------------------------------------
// getDSDataByDate — per-GL account record fetch
// ---------------------------------------------------------------------------

describe('getDSDataByDate — 6-field row fetch per GL account', () => {

  test('returns all records across all GL accounts', async () => {
    capturedLogs.length = 0;
    dsResponses.handler = async (url) => {
      if (url.includes("GLAccount eq '0000400000'")) return { value: [{ AccountingDocument: '1' }, { AccountingDocument: '2' }] };
      if (url.includes("GLAccount eq '0000400010'")) return { value: [{ AccountingDocument: '3' }] };
      return { value: [] };
    };
    const glAccounts = [
      { GLAccount: '0000400000', RecordCount: 2 },
      { GLAccount: '0000400010', RecordCount: 1 }
    ];
    const records = await dsService.getDSDataByDate('2026-03-31', 23, glAccounts);
    assert.equal(records.length, 3);
  });

  test('zero-record GL account does not corrupt total', async () => {
    capturedLogs.length = 0;
    dsResponses.handler = async (url) => {
      if (url.includes("GLAccount eq '0000400000'")) return { value: [{ AccountingDocument: '1' }] };
      if (url.includes("GLAccount eq '0000999999'")) return { value: [] };
      return { value: [] };
    };
    const glAccounts = [
      { GLAccount: '0000400000', RecordCount: 1 },
      { GLAccount: '0000999999', RecordCount: 0 }
    ];
    const records = await dsService.getDSDataByDate('2026-03-31', 23, glAccounts);
    assert.equal(records.length, 1, 'Zero-record account must not change total');
  });

  test('inner pagination fires for GL account with more than 999 records', async () => {
    capturedLogs.length = 0;
    let bigAccountCallN = 0;
    dsResponses.handler = async (url) => {
      if (url.includes("GLAccount eq '0000500000'")) {
        bigAccountCallN++;
        const skip = parseInt(url.match(/\$skip=(\d+)/)?.[1] || '0', 10);
        if (skip === 0) {
          return { value: Array.from({ length: 999 }, (_, i) => ({ AccountingDocument: String(i) })) };
        }
        return { value: Array.from({ length: 300 }, (_, i) => ({ AccountingDocument: String(999 + i) })) };
      }
      return { value: [] };
    };
    const glAccounts = [{ GLAccount: '0000500000', RecordCount: 1299 }];
    const records = await dsService.getDSDataByDate('2026-03-31', 23, glAccounts);
    assert.equal(records.length, 1299, 'Inner pagination must fetch all pages and return 1299 records');
    assert.equal(bigAccountCallN, 2, 'Should make 2 requests for the high-volume account');
  });

  test('high-volume day: multiple accounts with many records returns correct total', async () => {
    capturedLogs.length = 0;
    const ACCOUNTS = [
      { GLAccount: '0000400000', count: 500 },
      { GLAccount: '0000400010', count: 300 },
      { GLAccount: '0000400020', count: 200 }
    ];
    const EXPECTED = ACCOUNTS.reduce((s, a) => s + a.count, 0); // 1000

    dsResponses.handler = async (url) => {
      for (const acc of ACCOUNTS) {
        if (url.includes(`GLAccount eq '${acc.GLAccount}'`)) {
          const skip = parseInt(url.match(/\$skip=(\d+)/)?.[1] || '0', 10);
          const slice = Array.from({ length: acc.count }, (_, i) => ({ AccountingDocument: String(i + skip) }));
          return { value: slice };
        }
      }
      return { value: [] };
    };

    const glAccounts = ACCOUNTS.map(a => ({ GLAccount: a.GLAccount, RecordCount: a.count }));
    const records = await dsService.getDSDataByDate('2026-03-31', 23, glAccounts);
    assert.equal(records.length, EXPECTED);
  });

  test('throws when DS connector fails on a GL account query', async () => {
    capturedLogs.length = 0;
    dsResponses.handler = async () => { throw new Error('DS unavailable'); };
    const glAccounts = [{ GLAccount: '0000400000', RecordCount: 5 }];
    await assert.rejects(
      () => dsService.getDSDataByDate('2026-03-31', 23, glAccounts),
      /DS data fetch failed/
    );
  });

  test('returns empty array when glAccounts list is empty', async () => {
    capturedLogs.length = 0;
    const records = await dsService.getDSDataByDate('2026-03-31', 23, []);
    assert.equal(records.length, 0);
  });

});
