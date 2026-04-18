'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module  = require('module');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides = {}) {
  return {
    SourceLedger: '0L',
    CompanyCode: '1010',
    FiscalYear: '2026',
    AccountingDocument: '0000000001',
    LedgerGLLineItem: '1',
    AmountInTransactionCurrency: '100.00',
    ...overrides
  };
}

const capturedLogs = [];

function makeCdsLog() {
  return {
    info:  (...args) => capturedLogs.push({ level: 'info',  msg: args.join(' ') }),
    warn:  (...args) => capturedLogs.push({ level: 'warn',  msg: args.join(' ') }),
    error: (...args) => capturedLogs.push({ level: 'error', msg: args.join(' ') }),
  };
}

// ---------------------------------------------------------------------------
// Mutable state objects — the mock functions always READ from these.
// Tests change properties here; they must NEVER replace the mock function
// references themselves (compare-service.js captures them via destructuring
// at load time, so replacing mockS4.getS4CountByDate has no effect).
// ---------------------------------------------------------------------------

const s4State = {
  count: 22,
  _countCallN: 0, _countFn: null,
  glData: [{ GLAccount: '0000400000', RecordCount: 22 }],
  _glDataCallN: 0, _glDataFn: null,
  data: [makeRecord()],
  _dataCallN: 0, _dataFn: null
};

const dsState = {
  count: 22,
  _countCallN: 0, _countFn: null,
  glData: [{ GLAccount: '0000400000', RecordCount: 22 }],
  _glDataCallN: 0, _glDataFn: null,
  data: [makeRecord()],
  _dataCallN: 0, _dataFn: null
};

const apimCalls = [];

// Stable function references captured by compare-service.js at load time.
// They delegate to state objects so tests can control behaviour per-call.
const mockS4 = {
  getS4CountByDate: async () => {
    s4State._countCallN++;
    if (s4State._countFn) return s4State._countFn(s4State._countCallN);
    return s4State.count;
  },
  getS4GLCountByDate: async () => {
    s4State._glDataCallN++;
    if (s4State._glDataFn) return s4State._glDataFn(s4State._glDataCallN);
    return s4State.glData;
  },
  getS4DataByDate: async () => {
    s4State._dataCallN++;
    if (s4State._dataFn) return s4State._dataFn(s4State._dataCallN);
    return s4State.data;
  }
};

const mockDS = {
  getDSCountByDate: async () => {
    dsState._countCallN++;
    if (dsState._countFn) return dsState._countFn(dsState._countCallN);
    return dsState.count;
  },
  getDSGLCountByDate: async () => {
    dsState._glDataCallN++;
    if (dsState._glDataFn) return dsState._glDataFn(dsState._glDataCallN);
    return dsState.glData;
  },
  getDSDataByDate: async () => {
    dsState._dataCallN++;
    if (dsState._dataFn) return dsState._dataFn(dsState._dataCallN);
    return dsState.data;
  }
};

const mockAPIM = {
  notifyAPIM: async (status, details) => { apimCalls.push({ status, details }); }
};

let compareService;
let originalLoad;
let originalSetTimeout;

before(() => {
  originalSetTimeout = global.setTimeout;
  // Make delay() resolve immediately — bypass the 30-min RETRY_WAIT_MS in tests
  global.setTimeout = (fn, _ms) => { fn(); return 0; };

  originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@sap/cds')           return { log: makeCdsLog };
    if (request === './s4-service')       return mockS4;
    if (request === './ds-service')       return mockDS;
    if (request === './apim-service')     return mockAPIM;
    return originalLoad.apply(this, arguments);
  };

  delete require.cache[require.resolve('../compare-service.js')];
  compareService = require('../compare-service.js');
});

after(() => {
  global.setTimeout = originalSetTimeout;
  Module._load = originalLoad;
});

// Reset all mutable state before each test
beforeEach(() => {
  capturedLogs.length = 0;
  apimCalls.length = 0;

  s4State.count = 22;
  s4State._countCallN = 0; s4State._countFn = null;
  s4State.glData = [{ GLAccount: '0000400000', RecordCount: 22 }];
  s4State._glDataCallN = 0; s4State._glDataFn = null;
  s4State.data = [makeRecord()];
  s4State._dataCallN = 0; s4State._dataFn = null;

  dsState.count = 22;
  dsState._countCallN = 0; dsState._countFn = null;
  dsState.glData = [{ GLAccount: '0000400000', RecordCount: 22 }];
  dsState._glDataCallN = 0; dsState._glDataFn = null;
  dsState.data = [makeRecord()];
  dsState._dataCallN = 0; dsState._dataFn = null;
});

// ---------------------------------------------------------------------------
// compareStep1Count
// ---------------------------------------------------------------------------

describe('compareStep1Count — total count comparison', () => {

  test('passes when S4 count equals DS count', () => {
    const r = compareService.compareStep1Count(22, 22);
    assert.equal(r.passed, true);
    assert.equal(r.s4Count, 22);
    assert.equal(r.dsCount, 22);
  });

  test('fails when S4 count is greater than DS count', () => {
    const r = compareService.compareStep1Count(22, 20);
    assert.equal(r.passed, false);
  });

  test('fails when DS count is greater than S4 count', () => {
    const r = compareService.compareStep1Count(20, 22);
    assert.equal(r.passed, false);
  });

  test('passes when both counts are zero', () => {
    const r = compareService.compareStep1Count(0, 0);
    assert.equal(r.passed, true);
  });

  test('fails when S4 is 0 and DS is non-zero', () => {
    const r = compareService.compareStep1Count(0, 5);
    assert.equal(r.passed, false);
  });

});

// ---------------------------------------------------------------------------
// compareStep2GLCounts
// ---------------------------------------------------------------------------

describe('compareStep2GLCounts — per-GL account comparison', () => {

  test('passes when all GL accounts match in count', () => {
    const s4 = [{ GLAccount: '0000400000', RecordCount: 10 }];
    const ds = [{ GLAccount: '0000400000', RecordCount: 10 }];
    const r = compareService.compareStep2GLCounts(s4, ds);
    assert.equal(r.passed, true);
    assert.equal(r.mismatches.length, 0);
  });

  test('fails when DS has fewer records for a GL account', () => {
    const s4 = [{ GLAccount: '0000400000', RecordCount: 10 }];
    const ds = [{ GLAccount: '0000400000', RecordCount: 8 }];
    const r = compareService.compareStep2GLCounts(s4, ds);
    assert.equal(r.passed, false);
    assert.equal(r.mismatches.length, 1);
    assert.equal(r.mismatches[0].GLAccount, '0000400000');
    assert.equal(r.mismatches[0].s4Count, 10);
    assert.equal(r.mismatches[0].dsCount, 8);
  });

  test('fails when S4 has a GL account absent in DS (DS count treated as 0)', () => {
    const s4 = [{ GLAccount: '0000400000', RecordCount: 5 }];
    const ds = [];
    const r = compareService.compareStep2GLCounts(s4, ds);
    assert.equal(r.passed, false);
    assert.equal(r.mismatches[0].dsCount, 0);
  });

  test('fails when DS has a GL account absent in S4 (S4 count treated as 0)', () => {
    const s4 = [];
    const ds = [{ GLAccount: '0000400000', RecordCount: 3 }];
    const r = compareService.compareStep2GLCounts(s4, ds);
    assert.equal(r.passed, false);
    assert.equal(r.mismatches[0].s4Count, 0);
  });

  test('normalises GL accounts — unpadded S4 GL matches padded DS GL', () => {
    const s4 = [{ GLAccount: '400000', RecordCount: 5 }];
    const ds = [{ GLAccount: '0000400000', RecordCount: 5 }];
    const r = compareService.compareStep2GLCounts(s4, ds);
    assert.equal(r.passed, true, 'normalizeGL must make unpadded and padded GL accounts equal');
  });

  test('passes when both GL account lists are empty', () => {
    const r = compareService.compareStep2GLCounts([], []);
    assert.equal(r.passed, true);
    assert.equal(r.totalGLs, 0);
  });

  test('multiple GL accounts — some match, some do not', () => {
    const s4 = [
      { GLAccount: '0000400000', RecordCount: 10 },
      { GLAccount: '0000400010', RecordCount: 5 }
    ];
    const ds = [
      { GLAccount: '0000400000', RecordCount: 10 },
      { GLAccount: '0000400010', RecordCount: 4 }
    ];
    const r = compareService.compareStep2GLCounts(s4, ds);
    assert.equal(r.passed, false);
    assert.equal(r.mismatches.length, 1);
    assert.equal(r.mismatches[0].GLAccount, '0000400010');
  });

  test('reports totalGLs as union of S4 and DS accounts', () => {
    const s4 = [{ GLAccount: '0000400000', RecordCount: 5 }];
    const ds = [{ GLAccount: '0000400010', RecordCount: 5 }];
    const r = compareService.compareStep2GLCounts(s4, ds);
    assert.equal(r.totalGLs, 2);
  });

});

// ---------------------------------------------------------------------------
// compareStep3FullData
// ---------------------------------------------------------------------------

describe('compareStep3FullData — row-level 6-field comparison', () => {

  test('passes when all records match on key and amount', () => {
    const rec = makeRecord({ AccountingDocument: '1', AmountInTransactionCurrency: '100.00' });
    const r = compareService.compareStep3FullData([rec], [rec]);
    assert.equal(r.passed, true);
    assert.equal(r.missingInDS.length, 0);
    assert.equal(r.extraInDS.length, 0);
    assert.equal(r.mismatches.length, 0);
  });

  test('detects record present in S4 but missing in DS', () => {
    const rec = makeRecord({ AccountingDocument: '1' });
    const r = compareService.compareStep3FullData([rec], []);
    assert.equal(r.passed, false);
    assert.equal(r.missingInDS.length, 1);
    assert.equal(r.extraInDS.length, 0);
  });

  test('detects record present in DS but not in S4', () => {
    const rec = makeRecord({ AccountingDocument: '1' });
    const r = compareService.compareStep3FullData([], [rec]);
    assert.equal(r.passed, false);
    assert.equal(r.extraInDS.length, 1);
    assert.equal(r.missingInDS.length, 0);
  });

  test('detects amount mismatch on a matched key', () => {
    const s4 = makeRecord({ AccountingDocument: '1', AmountInTransactionCurrency: '100.00' });
    const ds = makeRecord({ AccountingDocument: '1', AmountInTransactionCurrency: '99.00' });
    const r = compareService.compareStep3FullData([s4], [ds]);
    assert.equal(r.passed, false);
    assert.equal(r.mismatches.length, 1);
    assert.equal(r.mismatches[0].s4Amount, 100);
    assert.equal(r.mismatches[0].dsAmount, 99);
  });

  test('AccountingDocument zero-padding in key: 123 and 0000000123 match', () => {
    const s4 = makeRecord({ AccountingDocument: '123' });
    const ds = makeRecord({ AccountingDocument: '0000000123' });
    const r = compareService.compareStep3FullData([s4], [ds]);
    assert.equal(r.passed, true, 'buildKey must zero-pad AccountingDocument to 10 digits');
  });

  test('passes when both data arrays are empty', () => {
    const r = compareService.compareStep3FullData([], []);
    assert.equal(r.passed, true);
  });

  test('reports all three failure types simultaneously', () => {
    const inBoth   = makeRecord({ AccountingDocument: '1', AmountInTransactionCurrency: '50.00' });
    const dsVersion = { ...inBoth, AmountInTransactionCurrency: '49.00' };
    const onlyInS4 = makeRecord({ AccountingDocument: '2' });
    const onlyInDS = makeRecord({ AccountingDocument: '3' });
    const r = compareService.compareStep3FullData([inBoth, onlyInS4], [dsVersion, onlyInDS]);
    assert.equal(r.passed, false);
    assert.equal(r.mismatches.length, 1, 'One amount mismatch');
    assert.equal(r.missingInDS.length, 1, 'One record missing in DS');
    assert.equal(r.extraInDS.length, 1, 'One extra record in DS');
  });

});

// ---------------------------------------------------------------------------
// runReconciliation — full orchestration with mocked services
// ---------------------------------------------------------------------------

describe('runReconciliation — orchestration and retry logic', () => {

  test('returns SUCCESS on first attempt when all steps pass', async () => {
    const result = await compareService.runReconciliation('2026-03-31', 23);
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.attempt, 1);
    assert.equal(result.step1Passed, true);
    assert.equal(result.step2Passed, true);
    assert.equal(result.step3Passed, true);
    assert.equal(result.s4Count, 22);
    assert.equal(result.dsCount, 22);
  });

  test('notifyAPIM is called with SUCCESS on a passing reconciliation', async () => {
    await compareService.runReconciliation('2026-03-31', 23);
    assert.equal(apimCalls.length, 1);
    assert.equal(apimCalls[0].status, 'SUCCESS');
  });

  test('returns NO_DATA when both S4 and DS return 0 — no APIM notification', async () => {
    s4State.count = 0;
    dsState.count = 0;
    const result = await compareService.runReconciliation('2026-04-18', 23);
    assert.equal(result.status, 'NO_DATA');
    assert.equal(apimCalls.length, 0, 'APIM must not be notified on NO_DATA');
  });

  test('retries on Step 1 failure and succeeds on attempt 3', async () => {
    // DS count returns 20 (mismatch) for calls 1-2, then 22 (match) on call 3
    dsState._countFn = (n) => n <= 2 ? 20 : 22;

    const result = await compareService.runReconciliation('2026-03-31', 23);
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.attempt, 3);
  });

  test('returns FAILED with failedStep=1 after all retries exhausted on Step 1', async () => {
    dsState.count = 20; // permanent mismatch — all 3 attempts fail
    const result = await compareService.runReconciliation('2026-03-31', 23);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.failedStep, 1);
    assert.equal(result.attempt, 3);
    assert.equal(apimCalls[0].status, 'FAILED');
  });

  test('returns FAILED with failedStep=2 after all retries exhausted on Step 2', async () => {
    // S4 GL count = 22 for the account; DS GL count = 10 — permanent mismatch
    dsState.glData = [{ GLAccount: '0000400000', RecordCount: 10 }];
    const result = await compareService.runReconciliation('2026-03-31', 23);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.failedStep, 2);
    assert.equal(apimCalls[0].status, 'FAILED');
  });

  test('returns FAILED with failedStep=3 after all retries exhausted on Step 3', async () => {
    // DS data record has a different AccountingDocument — key mismatch causes Step 3 to fail
    dsState.data = [makeRecord({ AccountingDocument: '9999', AmountInTransactionCurrency: '1.00' })];
    const result = await compareService.runReconciliation('2026-03-31', 23);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.failedStep, 3);
    assert.equal(apimCalls[0].status, 'FAILED');
  });

  test('retries on Step 2 failure and succeeds on attempt 2', async () => {
    // DS GL count returns a mismatch on call 1, then the correct value from call 2 onward
    dsState._glDataFn = (n) =>
      n === 1
        ? [{ GLAccount: '0000400000', RecordCount: 5 }]   // mismatch on attempt 1
        : [{ GLAccount: '0000400000', RecordCount: 22 }];  // match on attempt 2

    const result = await compareService.runReconciliation('2026-03-31', 23);
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.attempt, 2);
  });

  test('handles unexpected error thrown by S4 — returns FAILED after all retries', async () => {
    // Use _countFn so the SAME function reference throws (replace pattern does not work in CJS)
    s4State._countFn = (_n) => { throw new Error('S4 unreachable'); };

    const result = await compareService.runReconciliation('2026-03-31', 23);
    assert.equal(result.status, 'FAILED');
    assert.ok(result.error, 'Error message must be present');
    assert.equal(apimCalls[0].status, 'FAILED');
  });

  test('result includes durationMs as a non-negative number', async () => {
    const result = await compareService.runReconciliation('2026-03-31', 23);
    assert.ok(typeof result.durationMs === 'number');
    assert.ok(result.durationMs >= 0);
  });

  test('glMismatchDetail is populated when Step 2 fails on final attempt', async () => {
    dsState.glData = [{ GLAccount: '0000400000', RecordCount: 10 }];
    const result = await compareService.runReconciliation('2026-03-31', 23);
    assert.equal(result.status, 'FAILED');
    assert.ok(Array.isArray(result.glMismatchDetail));
    assert.equal(result.glMismatches, result.glMismatchDetail.length);
  });

});
