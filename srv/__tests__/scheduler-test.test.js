'use strict';

// scheduler-test.test.js
// Tests all 4 scenarios of the runSchedulerTest CDS action handler.
// runReconciliation and notifyAPIM are mocked so no real system calls are made.
// setTimeout (used for retry waits) is overridden to resolve immediately.

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
// Mutable mock state for compare-service and apim-service
// ---------------------------------------------------------------------------

const compareState = {
  result: {
    status: 'SUCCESS',
    attempt: 1,
    failedStep: null,
    s4Count: 22,
    dsCount: 22,
    step1Passed: true,
    step2Passed: true,
    step3Passed: true,
    glMismatches: 0,
    glMismatchDetail: [],
    missingInDS: 0,
    extraInDS: 0,
    valueMismatches: 0,
    durationMs: 120,
    error: null
  }
};

const apimCalls = [];

// Stable reference — scheduler-test.js captures it via destructuring at load time.
// Tests change compareState.result, never mockCompare.runReconciliation itself.
const mockCompare = {
  runReconciliation: async (_date, _startHour) => ({ ...compareState.result })
};

const mockAPIM = {
  notifyAPIM: async (status, details) => { apimCalls.push({ status, details }); }
};

// ---------------------------------------------------------------------------
// Captured CDS handler
// ---------------------------------------------------------------------------

let runSchedulerTest;
let originalLoad;
let originalSetTimeout;

before(() => {
  originalSetTimeout = global.setTimeout;
  // Override delay() to resolve immediately — avoids real wait between retries
  global.setTimeout = (fn, _ms) => { fn(); return 0; };

  originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@sap/cds') return {
      log: makeCdsLog,
      service: {
        impl: (fn) => {
          const captured = {};
          fn.call({ on: (event, handler) => { captured[event] = handler; } });
          return captured;
        }
      }
    };
    if (request === './services/compare-service') return mockCompare;
    if (request === './services/apim-service')    return mockAPIM;
    return originalLoad.apply(this, arguments);
  };

  // Path: srv/__tests__/ → ../scheduler-test.js (srv/)
  delete require.cache[require.resolve('../scheduler-test.js')];
  const loaded = require('../scheduler-test.js');
  runSchedulerTest = loaded['runSchedulerTest'];
});

after(() => {
  global.setTimeout = originalSetTimeout;
  Module._load = originalLoad;
});

function resetState() {
  capturedLogs.length = 0;
  apimCalls.length = 0;
  compareState.result = {
    status: 'SUCCESS',
    attempt: 1,
    failedStep: null,
    s4Count: 22,
    dsCount: 22,
    step1Passed: true,
    step2Passed: true,
    step3Passed: true,
    glMismatches: 0,
    glMismatchDetail: [],
    missingInDS: 0,
    extraInDS: 0,
    valueMismatches: 0,
    durationMs: 120,
    error: null
  };
}

beforeEach(resetState);

// ---------------------------------------------------------------------------
// Scenario 1 — SUCCESS on first real attempt
// ---------------------------------------------------------------------------

describe('Scenario 1 — SUCCESS on first attempt', () => {

  test('returns status=SUCCESS', async () => {
    const result = await runSchedulerTest({ data: { scenario: 1, retryWaitSeconds: 0 } });
    assert.equal(result.status, 'SUCCESS');
  });

  test('attempt number is 1', async () => {
    const result = await runSchedulerTest({ data: { scenario: 1, retryWaitSeconds: 0 } });
    assert.equal(result.attempt, 1);
  });

  test('all step flags are true', async () => {
    const result = await runSchedulerTest({ data: { scenario: 1, retryWaitSeconds: 0 } });
    assert.equal(result.step1Passed, true);
    assert.equal(result.step2Passed, true);
    assert.equal(result.step3Passed, true);
  });

  test('no APIM call at the scheduler-test layer (compare-service handles it internally)', async () => {
    await runSchedulerTest({ data: { scenario: 1, retryWaitSeconds: 0 } });
    assert.equal(apimCalls.length, 0,
      'scheduler-test must not double-notify APIM; compare-service handles it');
  });

  test('durationMs is a non-negative number overriding the inner value', async () => {
    const result = await runSchedulerTest({ data: { scenario: 1, retryWaitSeconds: 0 } });
    assert.ok(typeof result.durationMs === 'number');
    assert.ok(result.durationMs >= 0);
  });

  test('logs SCENARIO 1 header', async () => {
    await runSchedulerTest({ data: { scenario: 1, retryWaitSeconds: 0 } });
    const header = capturedLogs.find(l => l.msg.includes('SCENARIO 1'));
    assert.ok(header, 'Must log scenario header');
  });

  test('logs the known-good date 2026-03-31', async () => {
    await runSchedulerTest({ data: { scenario: 1, retryWaitSeconds: 0 } });
    const dateLine = capturedLogs.find(l => l.msg.includes('2026-03-31'));
    assert.ok(dateLine, 'Must log the known-good test date');
  });

});

// ---------------------------------------------------------------------------
// Scenario 2 — forced failures on attempts 1-2, SUCCESS on attempt 3
// ---------------------------------------------------------------------------

describe('Scenario 2 — retry then SUCCESS on attempt 3', () => {

  test('returns status=SUCCESS', async () => {
    const result = await runSchedulerTest({ data: { scenario: 2, retryWaitSeconds: 0 } });
    assert.equal(result.status, 'SUCCESS');
  });

  test('attempt number is 3 (2 forced fails + 1 real attempt)', async () => {
    const result = await runSchedulerTest({ data: { scenario: 2, retryWaitSeconds: 0 } });
    assert.equal(result.attempt, 3, 'Outer attempt counter must be 3 after 2 forced fails');
  });

  test('exactly 2 FORCED FAIL log lines appear (for attempts 1 and 2)', async () => {
    await runSchedulerTest({ data: { scenario: 2, retryWaitSeconds: 0 } });
    const forcedFails = capturedLogs.filter(l => l.msg.includes('FORCED FAIL'));
    assert.equal(forcedFails.length, 2, 'Exactly 2 forced-fail log lines expected');
  });

  test('forced fail logs mention simulated S4=100 and DS=95 counts', async () => {
    await runSchedulerTest({ data: { scenario: 2, retryWaitSeconds: 0 } });
    const mismatchLog = capturedLogs.find(l => l.msg.includes('100') && l.msg.includes('95'));
    assert.ok(mismatchLog, 'Forced-fail log must show S4=100 DS=95 simulated counts');
  });

  test('no APIM notification at the scheduler-test layer', async () => {
    await runSchedulerTest({ data: { scenario: 2, retryWaitSeconds: 0 } });
    assert.equal(apimCalls.length, 0);
  });

});

// ---------------------------------------------------------------------------
// Scenario 3 — all 3 attempts forced FAILED, notifies APIM
// ---------------------------------------------------------------------------

describe('Scenario 3 — all forced fails, final status=FAILED', () => {

  test('returns status=FAILED', async () => {
    const result = await runSchedulerTest({ data: { scenario: 3, retryWaitSeconds: 0 } });
    assert.equal(result.status, 'FAILED');
  });

  test('attempt number is 3', async () => {
    const result = await runSchedulerTest({ data: { scenario: 3, retryWaitSeconds: 0 } });
    assert.equal(result.attempt, 3);
  });

  test('failedStep is 1 (simulated Step 1 failure)', async () => {
    const result = await runSchedulerTest({ data: { scenario: 3, retryWaitSeconds: 0 } });
    assert.equal(result.failedStep, 1);
  });

  test('step1Passed / step2Passed / step3Passed are all false', async () => {
    const result = await runSchedulerTest({ data: { scenario: 3, retryWaitSeconds: 0 } });
    assert.equal(result.step1Passed, false);
    assert.equal(result.step2Passed, false);
    assert.equal(result.step3Passed, false);
  });

  test('s4Count = 100 and dsCount = 95 in result (simulated values)', async () => {
    const result = await runSchedulerTest({ data: { scenario: 3, retryWaitSeconds: 0 } });
    assert.equal(result.s4Count, 100);
    assert.equal(result.dsCount, 95);
  });

  test('notifyAPIM called exactly once with status=FAILED', async () => {
    await runSchedulerTest({ data: { scenario: 3, retryWaitSeconds: 0 } });
    assert.equal(apimCalls.length, 1);
    assert.equal(apimCalls[0].status, 'FAILED');
  });

  test('error field contains simulated failure message', async () => {
    const result = await runSchedulerTest({ data: { scenario: 3, retryWaitSeconds: 0 } });
    assert.ok(result.error, 'error field must be present');
    assert.ok(result.error.toLowerCase().includes('simulated'), 'error must mention it is a simulation');
  });

  test('exactly 3 FORCED FAIL log lines appear', async () => {
    await runSchedulerTest({ data: { scenario: 3, retryWaitSeconds: 0 } });
    const forcedFails = capturedLogs.filter(l => l.msg.includes('FORCED FAIL'));
    assert.equal(forcedFails.length, 3);
  });

});

// ---------------------------------------------------------------------------
// Scenario 4 — real attempt for today's date, expected NO_DATA
// ---------------------------------------------------------------------------

describe('Scenario 4 — today date, NO_DATA expected', () => {

  test('returns status=NO_DATA when runReconciliation returns NO_DATA', async () => {
    compareState.result = { ...compareState.result, status: 'NO_DATA', s4Count: 0, dsCount: 0 };
    const result = await runSchedulerTest({ data: { scenario: 4, retryWaitSeconds: 0 } });
    assert.equal(result.status, 'NO_DATA');
  });

  test('attempt number is 1 (real attempt on first try)', async () => {
    compareState.result = { ...compareState.result, status: 'NO_DATA', s4Count: 0, dsCount: 0 };
    const result = await runSchedulerTest({ data: { scenario: 4, retryWaitSeconds: 0 } });
    assert.equal(result.attempt, 1);
  });

  test('logs "today" or "no data expected" for scenario 4', async () => {
    compareState.result = { ...compareState.result, status: 'NO_DATA', s4Count: 0, dsCount: 0 };
    await runSchedulerTest({ data: { scenario: 4, retryWaitSeconds: 0 } });
    const todayLine = capturedLogs.find(l =>
      l.msg.toLowerCase().includes('today') || l.msg.toLowerCase().includes('no data expected')
    );
    assert.ok(todayLine, 'Must log that today is used or that no data is expected');
  });

  test('no APIM notification for NO_DATA status', async () => {
    compareState.result = { ...compareState.result, status: 'NO_DATA', s4Count: 0, dsCount: 0 };
    await runSchedulerTest({ data: { scenario: 4, retryWaitSeconds: 0 } });
    assert.equal(apimCalls.length, 0, 'APIM must not be notified for NO_DATA');
  });

  test('scenario 4 logs today date, scenario 1 logs 2026-03-31', async () => {
    const todayDate = new Date().toISOString().slice(0, 10);

    // Scenario 4
    compareState.result = { ...compareState.result, status: 'NO_DATA', s4Count: 0, dsCount: 0 };
    capturedLogs.length = 0;
    await runSchedulerTest({ data: { scenario: 4, retryWaitSeconds: 0 } });
    const dateLog4 = capturedLogs.find(l => l.msg.includes(todayDate));

    // Scenario 1
    compareState.result = { ...compareState.result, status: 'SUCCESS', s4Count: 22, dsCount: 22 };
    capturedLogs.length = 0;
    await runSchedulerTest({ data: { scenario: 1, retryWaitSeconds: 0 } });
    const dateLog1 = capturedLogs.find(l => l.msg.includes('2026-03-31'));

    assert.ok(dateLog4, "Scenario 4 must log today's date");
    assert.ok(dateLog1, 'Scenario 1 must log the known-good date 2026-03-31');
  });

  test('no forced-fail log lines for scenario 4', async () => {
    compareState.result = { ...compareState.result, status: 'NO_DATA', s4Count: 0, dsCount: 0 };
    await runSchedulerTest({ data: { scenario: 4, retryWaitSeconds: 0 } });
    const forcedFails = capturedLogs.filter(l => l.msg.includes('FORCED FAIL'));
    assert.equal(forcedFails.length, 0);
  });

});

// ---------------------------------------------------------------------------
// retryWaitSeconds parameter
// ---------------------------------------------------------------------------

describe('retryWaitSeconds parameter', () => {

  test('retry wait log appears for scenario 2 (uses retry wait)', async () => {
    await runSchedulerTest({ data: { scenario: 2, retryWaitSeconds: 0 } });
    const waitLog = capturedLogs.find(l => l.msg.includes('Waiting'));
    assert.ok(waitLog, 'Retry wait log must appear for scenario 2');
  });

  test('provided retryWaitSeconds value appears in the wait log', async () => {
    await runSchedulerTest({ data: { scenario: 2, retryWaitSeconds: 99 } });
    const waitLog = capturedLogs.find(l => l.msg.includes('99s'));
    assert.ok(waitLog, 'Wait log must include the provided retryWaitSeconds value');
  });

});
