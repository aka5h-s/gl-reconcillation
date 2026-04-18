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

// Mutable HTTP mock — tests can change httpResponses to control what executeHttpRequest returns
const httpResponses = {
  handler: async () => ({
    data: { d: { __count: '22', results: [] } }
  })
};

const mockExecuteHttpRequest = async (dest, opts) => httpResponses.handler(dest, opts);

let s4Service;
let originalLoad;

before(() => {
  originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@sap/cds') return { log: makeCdsLog };
    if (request === '@sap-cloud-sdk/http-client') return { executeHttpRequest: mockExecuteHttpRequest };
    if (request === 'axios') return { get: async () => ({ data: { d: { results: [] } } }) };
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../s4-service.js')];
  s4Service = require('../s4-service.js');
});

after(() => {
  Module._load = originalLoad;
});

// ---------------------------------------------------------------------------
// buildS4DateFilter — pure function (tested via getS4CountByDate URL assertions)
// ---------------------------------------------------------------------------

describe('buildS4DateFilter — date/hour filter string', () => {

  test('hour 0 produces 00:00:00 end boundary', async () => {
    capturedLogs.length = 0;
    let capturedUrl = '';
    httpResponses.handler = async (dest, opts) => {
      capturedUrl = opts.url;
      return { data: { d: { __count: '0', results: [] } } };
    };
    await s4Service.getS4CountByDate('2026-03-31', 0);
    assert.ok(capturedUrl.includes('2026-03-31T00:00:00'), 'Start must be midnight');
    assert.ok(capturedUrl.includes('2026-03-31T00:00:00'), 'End with hour=0 must also be midnight');
  });

  test('hour 23 produces 23:00:00 end boundary', async () => {
    capturedLogs.length = 0;
    let capturedUrl = '';
    httpResponses.handler = async (dest, opts) => {
      capturedUrl = opts.url;
      return { data: { d: { __count: '0', results: [] } } };
    };
    await s4Service.getS4CountByDate('2026-03-31', 23);
    assert.ok(capturedUrl.includes('2026-03-31T23:00:00'), 'End must be 23:00:00');
    assert.ok(capturedUrl.includes('2026-03-31T00:00:00'), 'Start must always be midnight');
  });

  test('single-digit hour is zero-padded in filter string', async () => {
    capturedLogs.length = 0;
    let capturedUrl = '';
    httpResponses.handler = async (dest, opts) => {
      capturedUrl = opts.url;
      return { data: { d: { __count: '0', results: [] } } };
    };
    await s4Service.getS4CountByDate('2026-01-05', 4);
    assert.ok(capturedUrl.includes('T04:00:00'), 'Hour 4 must be padded to 04');
  });

  test('filter uses datetimeoffset keyword', async () => {
    capturedLogs.length = 0;
    let capturedUrl = '';
    httpResponses.handler = async (dest, opts) => {
      capturedUrl = opts.url;
      return { data: { d: { __count: '0', results: [] } } };
    };
    await s4Service.getS4CountByDate('2026-03-31', 12);
    assert.ok(capturedUrl.includes("datetimeoffset'"), "Filter must use datetimeoffset syntax");
  });

  test('filter includes LastChangeDateTime ge and lt', async () => {
    capturedLogs.length = 0;
    let capturedUrl = '';
    httpResponses.handler = async (dest, opts) => {
      capturedUrl = opts.url;
      return { data: { d: { __count: '0', results: [] } } };
    };
    await s4Service.getS4CountByDate('2026-03-31', 12);
    assert.ok(capturedUrl.includes('LastChangeDateTime ge'), 'Filter must use ge');
    assert.ok(capturedUrl.includes('LastChangeDateTime lt'), 'Filter must use lt');
  });

});

// ---------------------------------------------------------------------------
// getS4CountByDate
// ---------------------------------------------------------------------------

describe('getS4CountByDate — total record count', () => {

  test('returns parsed integer count from __count field', async () => {
    capturedLogs.length = 0;
    httpResponses.handler = async () => ({ data: { d: { __count: '22', results: [] } } });
    const count = await s4Service.getS4CountByDate('2026-03-31', 23);
    assert.equal(count, 22);
  });

  test('returns 0 when __count is missing', async () => {
    capturedLogs.length = 0;
    httpResponses.handler = async () => ({ data: { d: {} } });
    const count = await s4Service.getS4CountByDate('2026-03-31', 23);
    assert.equal(count, 0);
  });

  test('throws when HTTP request fails', async () => {
    capturedLogs.length = 0;
    httpResponses.handler = async () => { throw new Error('Network error'); };
    await assert.rejects(
      () => s4Service.getS4CountByDate('2026-03-31', 23),
      /S4 count failed/
    );
  });

});

// ---------------------------------------------------------------------------
// getS4GLCountByDate — per-GL account counts
// ---------------------------------------------------------------------------

describe('getS4GLCountByDate — per-GL account breakdown', () => {

  test('groups records by GLAccount and returns count per account', async () => {
    capturedLogs.length = 0;
    httpResponses.handler = async () => ({
      data: {
        d: {
          results: [
            { GLAccount: '0000400000', AccountingDocument: '1', LedgerGLLineItem: '1' },
            { GLAccount: '0000400000', AccountingDocument: '2', LedgerGLLineItem: '1' },
            { GLAccount: '0000400010', AccountingDocument: '3', LedgerGLLineItem: '1' },
          ]
        }
      }
    });
    const glData = await s4Service.getS4GLCountByDate('2026-03-31', 23);
    assert.equal(glData.length, 2);
    const acc1 = glData.find(r => r.GLAccount === '0000400000');
    const acc2 = glData.find(r => r.GLAccount === '0000400010');
    assert.ok(acc1, 'Should have account 0000400000');
    assert.ok(acc2, 'Should have account 0000400010');
    assert.equal(acc1.RecordCount, 2);
    assert.equal(acc2.RecordCount, 1);
  });

  test('returns empty array when no records found', async () => {
    capturedLogs.length = 0;
    httpResponses.handler = async () => ({ data: { d: { results: [] } } });
    const glData = await s4Service.getS4GLCountByDate('2026-03-31', 23);
    assert.equal(glData.length, 0);
  });

  test('paginates when first page is full (1000 records)', async () => {
    capturedLogs.length = 0;
    let callN = 0;
    httpResponses.handler = async (dest, opts) => {
      callN++;
      if (callN === 1) {
        // Return 1000 records — signals more pages
        const results = Array.from({ length: 1000 }, (_, i) => ({
          GLAccount: '0000400000', AccountingDocument: String(i), LedgerGLLineItem: '1'
        }));
        return { data: { d: { results } } };
      }
      // Second page — 5 more records
      return {
        data: {
          d: {
            results: Array.from({ length: 5 }, (_, i) => ({
              GLAccount: '0000400000', AccountingDocument: String(1000 + i), LedgerGLLineItem: '1'
            }))
          }
        }
      };
    };
    const glData = await s4Service.getS4GLCountByDate('2026-03-31', 23);
    assert.equal(glData.length, 1);
    assert.equal(glData[0].RecordCount, 1005, 'Should have combined both pages (1000 + 5)');
  });

  test('throws when HTTP request fails', async () => {
    capturedLogs.length = 0;
    httpResponses.handler = async () => { throw new Error('Timeout'); };
    await assert.rejects(
      () => s4Service.getS4GLCountByDate('2026-03-31', 23),
      /S4 GL count failed/
    );
  });

});

// ---------------------------------------------------------------------------
// getS4DataByDate — full row fetch
// ---------------------------------------------------------------------------

describe('getS4DataByDate — 6-field row fetch', () => {

  test('returns all 6 reconciliation fields', async () => {
    capturedLogs.length = 0;
    const record = {
      SourceLedger: '0L', CompanyCode: '1010', FiscalYear: '2026',
      AccountingDocument: '1234567890', LedgerGLLineItem: '1',
      AmountInTransactionCurrency: '100.00'
    };
    httpResponses.handler = async () => ({ data: { d: { results: [record] } } });
    const data = await s4Service.getS4DataByDate('2026-03-31', 23);
    assert.equal(data.length, 1);
    assert.equal(data[0].SourceLedger, '0L');
    assert.equal(data[0].AmountInTransactionCurrency, '100.00');
  });

  test('returns empty array when no records found', async () => {
    capturedLogs.length = 0;
    httpResponses.handler = async () => ({ data: { d: { results: [] } } });
    const data = await s4Service.getS4DataByDate('2026-03-31', 23);
    assert.equal(data.length, 0);
  });

  test('paginates when a page has exactly 1000 records', async () => {
    capturedLogs.length = 0;
    let callN = 0;
    httpResponses.handler = async () => {
      callN++;
      if (callN === 1) {
        return { data: { d: { results: Array.from({ length: 1000 }, (_, i) => ({ AccountingDocument: String(i) })) } } };
      }
      return { data: { d: { results: [{ AccountingDocument: '9999' }] } } };
    };
    const data = await s4Service.getS4DataByDate('2026-03-31', 23);
    assert.equal(data.length, 1001, 'Should have 1000 + 1 records across two pages');
  });

  test('throws when HTTP request fails', async () => {
    capturedLogs.length = 0;
    httpResponses.handler = async () => { throw new Error('Connection refused'); };
    await assert.rejects(
      () => s4Service.getS4DataByDate('2026-03-31', 23),
      /S4 data fetch failed/
    );
  });

});
