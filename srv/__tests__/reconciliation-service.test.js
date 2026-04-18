'use strict';

// reconciliation-service.test.js
// Tests every CDS action handler registered in reconciliation-service.js.
// The module is loaded with all service dependencies mocked via Module._load.
// Handlers are captured by intercepting cds.service.impl's `this.on(...)` calls
// and then invoked directly to verify response shapes and error surfacing.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module  = require('module');

// ---------------------------------------------------------------------------
// Log capture
// ---------------------------------------------------------------------------

const capturedLogs = [];

function makeCdsLog() {
  return {
    info:  (...args) => capturedLogs.push({ level: 'info',  msg: args.join(' ') }),
    warn:  (...args) => capturedLogs.push({ level: 'warn',  msg: args.join(' ') }),
    error: (...args) => capturedLogs.push({ level: 'error', msg: args.join(' ') }),
  };
}

// ---------------------------------------------------------------------------
// DB mock — used by testDatabaseConnection, testDatabaseTable, executeQuery
// ---------------------------------------------------------------------------

const dbState = {
  shouldFail: false,
  rows: [{ appdate: '2026-03-31', processingdate: '2026-03-31T23:00:00.000Z' }]
};

const mockDb = {
  run: async (sql) => {
    if (dbState.shouldFail) throw new Error('DB unreachable');
    if (sql.trim() === 'SELECT 1') return [{ '?column?': 1 }];
    return dbState.rows;
  }
};

// ---------------------------------------------------------------------------
// Service mocks — each returns a canned value the tests can adjust
// ---------------------------------------------------------------------------

const mockS4State = {
  connectionGLResult: 'S4 GL LINE ITEM CONNECTION SUCCESS',
  connectionJEResult: 'S4 JOURNAL ENTRY CONNECTION SUCCESS',
  count: 22
};

const mockS4 = {
  testS4ConnectionGLLineItem:   async () => mockS4State.connectionGLResult,
  testS4ConnectionJournalEntry: async () => mockS4State.connectionJEResult,
  getS4Count:                   async () => 5,
  getS4CountByDate:             async () => mockS4State.count,
  getS4GLCountByDate:           async () => [{ GLAccount: '0000400000', RecordCount: mockS4State.count }],
  getS4DataByDate:              async () => [],
  getS4DataForPeriod:           async () => []
};

const mockDSState = {
  connectionResult: 'DATASPHERE CONNECTION SUCCESS',
  count: 22
};

const mockDS = {
  testDatasphereConnection: async () => mockDSState.connectionResult,
  getDSDataForPeriod:       async () => [],
  getDSCountByDate:         async () => mockDSState.count,
  getDSGLCountByDate:       async () => [{ GLAccount: '0000400000', RecordCount: mockDSState.count }],
  getDSDataByDate:          async () => []
};

const recoState = {
  result: { status: 'SUCCESS', attempt: 1, s4Count: 22, dsCount: 22 },
  _runFn: null
};

const mockCompare = {
  runReconciliation: async (date, startHour) => {
    if (recoState._runFn) return recoState._runFn(date, startHour);
    return { ...recoState.result };
  }
};

const mockPostgres = {
  initScheduler: () => {},
  startPolling:  () => {}
};

// ---------------------------------------------------------------------------
// Captured CDS action handlers
// ---------------------------------------------------------------------------

const handlers = {};

const mockCds = {
  log: makeCdsLog,
  connect: { to: async () => mockDb },
  service: {
    impl: (fn) => {
      fn.call({ on: (event, handler) => { handlers[event] = handler; } });
      return handlers;
    }
  }
};

let originalLoad;

before(() => {
  originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@sap/cds')                   return mockCds;
    if (request === './services/s4-service')       return mockS4;
    if (request === './services/ds-service')       return mockDS;
    if (request === './services/compare-service')  return mockCompare;
    if (request === './services/postgres-service') return mockPostgres;
    return originalLoad.apply(this, arguments);
  };

  // Path: srv/__tests__/ → ../reconciliation-service.js (srv/)
  delete require.cache[require.resolve('../reconciliation-service.js')];
  require('../reconciliation-service.js');
});

after(() => {
  Module._load = originalLoad;
});

beforeEach(() => {
  capturedLogs.length = 0;
  dbState.shouldFail = false;
  dbState.rows = [{ appdate: '2026-03-31', processingdate: '2026-03-31T23:00:00.000Z' }];
  mockS4State.connectionGLResult = 'S4 GL LINE ITEM CONNECTION SUCCESS';
  mockS4State.connectionJEResult = 'S4 JOURNAL ENTRY CONNECTION SUCCESS';
  mockDSState.connectionResult   = 'DATASPHERE CONNECTION SUCCESS';
  recoState.result = { status: 'SUCCESS', attempt: 1, s4Count: 22, dsCount: 22 };
  recoState._runFn = null;
});

// ---------------------------------------------------------------------------
// testS4ConnectionGLLineItem
// ---------------------------------------------------------------------------

describe('testS4ConnectionGLLineItem action', () => {

  test('returns success string on healthy connection', async () => {
    const result = await handlers['testS4ConnectionGLLineItem']();
    assert.equal(result, 'S4 GL LINE ITEM CONNECTION SUCCESS');
  });

  test('returns FAILED string when service returns a FAILED message', async () => {
    mockS4State.connectionGLResult = 'FAILED: destination not found';
    const result = await handlers['testS4ConnectionGLLineItem']();
    assert.ok(result.startsWith('FAILED'));
  });

});

// ---------------------------------------------------------------------------
// testS4ConnectionJournalEntry
// ---------------------------------------------------------------------------

describe('testS4ConnectionJournalEntry action', () => {

  test('returns success string on healthy connection', async () => {
    const result = await handlers['testS4ConnectionJournalEntry']();
    assert.equal(result, 'S4 JOURNAL ENTRY CONNECTION SUCCESS');
  });

  test('returns FAILED string when service returns a FAILED message', async () => {
    mockS4State.connectionJEResult = 'FAILED: timeout';
    const result = await handlers['testS4ConnectionJournalEntry']();
    assert.ok(result.startsWith('FAILED'));
  });

});

// ---------------------------------------------------------------------------
// testDatasphereConnection
// ---------------------------------------------------------------------------

describe('testDatasphereConnection action', () => {

  test('returns DS connection result string', async () => {
    const result = await handlers['testDatasphereConnection']();
    assert.equal(result, 'DATASPHERE CONNECTION SUCCESS');
  });

  test('returns FAILED string when DS service returns FAILED', async () => {
    mockDSState.connectionResult = 'FAILED: network error';
    const result = await handlers['testDatasphereConnection']();
    assert.ok(result.startsWith('FAILED'));
  });

});

// ---------------------------------------------------------------------------
// testDatabaseConnection
// ---------------------------------------------------------------------------

describe('testDatabaseConnection action', () => {

  test('returns success message when SELECT 1 succeeds', async () => {
    const result = await handlers['testDatabaseConnection']();
    assert.ok(result.toLowerCase().includes('success'));
  });

  test('returns FAILED message when DB throws', async () => {
    dbState.shouldFail = true;
    const result = await handlers['testDatabaseConnection']();
    assert.ok(result.includes('FAILED'));
    assert.ok(result.includes('DB unreachable'));
  });

});

// ---------------------------------------------------------------------------
// testDatabaseTable
// ---------------------------------------------------------------------------

describe('testDatabaseTable action', () => {

  test('returns JSON string of rows on success', async () => {
    const result = await handlers['testDatabaseTable']();
    const parsed = JSON.parse(result);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 1);
  });

  test('returns error string when DB throws', async () => {
    dbState.shouldFail = true;
    const result = await handlers['testDatabaseTable']();
    assert.ok(result.includes('FAILED'));
  });

});

// ---------------------------------------------------------------------------
// testS4CountByDate
// ---------------------------------------------------------------------------

describe('testS4CountByDate action', () => {

  test('returns count from getS4CountByDate', async () => {
    mockS4State.count = 55;
    const result = await handlers['testS4CountByDate']({
      data: { date: '2026-03-31', startHour: 23 }
    });
    assert.equal(result, 55);
  });

});

// ---------------------------------------------------------------------------
// testDSCount
// ---------------------------------------------------------------------------

describe('testDSCount action', () => {

  test('returns count from getDSCountByDate', async () => {
    mockDSState.count = 77;
    const result = await handlers['testDSCount']({
      data: { date: '2026-03-31', startHour: 23 }
    });
    assert.equal(result, 77);
  });

});

// ---------------------------------------------------------------------------
// executeQuery
// ---------------------------------------------------------------------------

describe('executeQuery action', () => {

  test('returns ERROR message when no SQL is provided', async () => {
    const result = await handlers['executeQuery']({ data: { sql: '' } });
    assert.ok(result.includes('ERROR'));
  });

  test('returns ERROR message when SQL is only whitespace', async () => {
    const result = await handlers['executeQuery']({ data: { sql: '   ' } });
    assert.ok(result.includes('ERROR'));
  });

  test('returns JSON envelope with rows and count for array results', async () => {
    const result = await handlers['executeQuery']({
      data: { sql: 'SELECT appdate FROM summitaccountingdata.db_accountingdata LIMIT 5' }
    });
    const parsed = JSON.parse(result);
    assert.ok('rows' in parsed, 'Envelope must have rows key');
    assert.ok('count' in parsed, 'Envelope must have count key');
    assert.equal(parsed.count, parsed.rows.length);
  });

  test('rows count equals the number of DB rows returned', async () => {
    dbState.rows = [
      { appdate: '2026-03-31' },
      { appdate: '2026-04-01' }
    ];
    const result = await handlers['executeQuery']({
      data: { sql: 'SELECT appdate FROM summitaccountingdata.db_accountingdata LIMIT 5' }
    });
    const parsed = JSON.parse(result);
    assert.equal(parsed.count, 2);
  });

  test('returns ERROR string when DB throws', async () => {
    dbState.shouldFail = true;
    const result = await handlers['executeQuery']({ data: { sql: 'SELECT 1' } });
    assert.ok(result.startsWith('ERROR: '));
    assert.ok(result.includes('DB unreachable'));
  });

});

// ---------------------------------------------------------------------------
// runReconciliation action
// ---------------------------------------------------------------------------

describe('runReconciliation action', () => {

  test('delegates to compare-service and returns SUCCESS result', async () => {
    recoState.result = { status: 'SUCCESS', attempt: 1, s4Count: 22, dsCount: 22 };
    const result = await handlers['runReconciliation']({
      data: { date: '2026-03-31', startHour: 23 }
    });
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.attempt, 1);
  });

  test('returns FAILED result when compare-service returns FAILED', async () => {
    recoState.result = { status: 'FAILED', attempt: 3, failedStep: 1, s4Count: 22, dsCount: 20 };
    const result = await handlers['runReconciliation']({
      data: { date: '2026-03-31', startHour: 23 }
    });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.failedStep, 1);
  });

  test('passes date and startHour from request data to compare-service', async () => {
    let calledWith = null;
    recoState._runFn = async (date, startHour) => {
      calledWith = { date, startHour };
      return { status: 'SUCCESS', attempt: 1 };
    };

    await handlers['runReconciliation']({ data: { date: '2026-03-31', startHour: 23 } });

    assert.deepEqual(calledWith, { date: '2026-03-31', startHour: 23 });
  });

});
