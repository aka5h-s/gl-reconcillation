'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Module  = require('module');

// ---------------------------------------------------------------------------
// DB mock — controls what checkSummitJob finds in PostgreSQL
// ---------------------------------------------------------------------------

const dbState = {
  rows: [] // empty = no job complete; non-empty = job found
};

const mockDb = {
  run: async (_sql) => dbState.rows
};

// ---------------------------------------------------------------------------
// node-cron mock — captures the scheduled handler without actually scheduling
// ---------------------------------------------------------------------------

let capturedCronHandler = null;
const mockCron = {
  schedule: (_expr, handler) => {
    capturedCronHandler = handler;
    return { stop: () => {} };
  }
};

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
// Fake timers — override setInterval/clearInterval so polling doesn't actually
// repeat. Only the immediate checkSummitJob call (on polling window open)
// runs in tests.
// ---------------------------------------------------------------------------

let capturedIntervalCallback = null;
let originalSetInterval;
let originalClearInterval;

function installFakeTimers() {
  originalSetInterval = global.setInterval;
  originalClearInterval = global.clearInterval;
  global.setInterval  = (fn, _ms) => { capturedIntervalCallback = fn; return 9999; };
  global.clearInterval = (_id) => { capturedIntervalCallback = null; };
}

function uninstallFakeTimers() {
  global.setInterval  = originalSetInterval;
  global.clearInterval = originalClearInterval;
}

// ---------------------------------------------------------------------------
// Load postgres-service with mocks injected
// ---------------------------------------------------------------------------

let psService;
let originalLoad;

before(() => {
  installFakeTimers();

  originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@sap/cds') return {
      log: makeCdsLog,
      connect: { to: async () => mockDb }
    };
    if (request === 'node-cron') return mockCron;
    return originalLoad.apply(this, arguments);
  };

  delete require.cache[require.resolve('../postgres-service.js')];
  psService = require('../postgres-service.js');
});

after(() => {
  uninstallFakeTimers();
  Module._load = originalLoad;
  psService.destroyScheduler();
});

// ---------------------------------------------------------------------------
// Helper — reset polling state between tests by calling destroyScheduler
// ---------------------------------------------------------------------------

function resetPolling() {
  psService.destroyScheduler();
  capturedLogs.length = 0;
  capturedCronHandler = null;
  capturedIntervalCallback = null;
  dbState.rows = [];
}

// ---------------------------------------------------------------------------
// startPolling tests
// ---------------------------------------------------------------------------

describe('startPolling — polling window lifecycle', () => {

  test('logs polling window opened message', async () => {
    resetPolling();
    dbState.rows = [];
    const onJobComplete = async () => {};
    psService.startPolling(onJobComplete);
    await new Promise(r => setImmediate(r)); // let async checkSummitJob settle
    const opened = capturedLogs.find(l => l.msg.includes('polling window'));
    assert.ok(opened, 'Expected a log line about the polling window opening');
    psService.stopPolling();
  });

  test('logs expiry time when polling window opens', async () => {
    resetPolling();
    dbState.rows = [];
    psService.startPolling(async () => {});
    await new Promise(r => setImmediate(r));
    const expiryLog = capturedLogs.find(l => l.msg.includes('expire') || l.msg.includes('UTC'));
    assert.ok(expiryLog, 'Expected a log line mentioning the polling expiry time');
    psService.stopPolling();
  });

  test('calls onJobComplete immediately when DB already has a completion row', async () => {
    resetPolling();
    dbState.rows = [{ processingdate: '2026-03-31T23:00:00.000Z' }];

    let callbackDate = null;
    let callbackHour = null;
    await psService.startPolling(async (date, startHour) => {
      callbackDate = date;
      callbackHour = startHour;
    });

    // Give async checkSummitJob time to run
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    assert.ok(callbackDate !== null, 'onJobComplete must be called when DB has a completion row');
    assert.equal(callbackDate, '2026-03-31');
    assert.equal(typeof callbackHour, 'number');
  });

  test('does not call onJobComplete when DB has no completion row', async () => {
    resetPolling();
    dbState.rows = [];

    let called = false;
    psService.startPolling(async () => { called = true; });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    assert.equal(called, false, 'onJobComplete must NOT be called when DB has no row');
    psService.stopPolling();
  });

  test('duplicate startPolling call is silently ignored while already polling', async () => {
    resetPolling();
    dbState.rows = [];

    psService.startPolling(async () => {});
    psService.startPolling(async () => {}); // second call — must be ignored

    const duplicateLogs = capturedLogs.filter(l => l.msg.includes('already active'));
    assert.equal(duplicateLogs.length, 1, 'Exactly one "already active" log expected');
    psService.stopPolling();
  });

});

// ---------------------------------------------------------------------------
// stopPolling tests
// ---------------------------------------------------------------------------

describe('stopPolling — closing the polling window', () => {

  test('logs "polling window closed" message', async () => {
    resetPolling();
    dbState.rows = [];
    psService.startPolling(async () => {});
    await new Promise(r => setImmediate(r));
    capturedLogs.length = 0;

    psService.stopPolling();
    const closed = capturedLogs.find(l => l.msg.includes('Polling window closed'));
    assert.ok(closed, 'Expected "Polling window closed" log after stopPolling');
  });

  test('stopPolling on idle (no active poll) does not throw', () => {
    resetPolling();
    assert.doesNotThrow(() => psService.stopPolling());
  });

});

// ---------------------------------------------------------------------------
// expirePolling — triggered when timeout elapsed
// ---------------------------------------------------------------------------

describe('expirePolling — timeout after 6 hours with no data', () => {

  test('expiry fires when Date.now() is more than 6h after poll start', async () => {
    resetPolling();
    dbState.rows = [];

    const realDateNow = Date.now;
    // Start polling — pollingStartTime will be set to now
    psService.startPolling(async () => {});
    await new Promise(r => setImmediate(r));

    // Advance clock beyond 6-hour timeout
    Date.now = () => realDateNow() + 6 * 60 * 60 * 1000 + 1000;

    // Manually fire the interval callback (simulates next 5-min tick)
    capturedLogs.length = 0;
    if (capturedIntervalCallback) await capturedIntervalCallback();
    await new Promise(r => setImmediate(r));

    Date.now = realDateNow;

    const expiredLog = capturedLogs.find(l =>
      l.level === 'warn' && l.msg.includes('expired')
    );
    assert.ok(expiredLog, 'Expected a warn-level log about polling window expiry');
  });

  test('after expiry, a new startPolling call succeeds (state is cleared)', async () => {
    resetPolling();
    dbState.rows = [];

    const realDateNow = Date.now;
    psService.startPolling(async () => {});
    await new Promise(r => setImmediate(r));

    Date.now = () => realDateNow() + 6 * 60 * 60 * 1000 + 1000;
    if (capturedIntervalCallback) await capturedIntervalCallback();
    await new Promise(r => setImmediate(r));
    Date.now = realDateNow;

    // Should be able to start a new polling window without the "already active" guard firing
    capturedLogs.length = 0;
    psService.startPolling(async () => {});
    const alreadyActive = capturedLogs.find(l => l.msg.includes('already active'));
    assert.equal(alreadyActive, undefined, 'After expiry, a new startPolling must succeed');
    psService.stopPolling();
  });

});

// ---------------------------------------------------------------------------
// initScheduler — sets up daily cron
// ---------------------------------------------------------------------------

describe('initScheduler — daily cron registration', () => {

  test('registers a cron task and logs the scheduled time', () => {
    resetPolling();
    psService.initScheduler(async () => {});
    const scheduledLog = capturedLogs.find(l =>
      l.msg.includes('12:00') || l.msg.includes('scheduler initialised')
    );
    assert.ok(scheduledLog, 'initScheduler must log the daily polling schedule');
    psService.destroyScheduler();
  });

  test('cron handler opens a polling window when fired', async () => {
    resetPolling();
    dbState.rows = [];

    psService.initScheduler(async () => {});
    assert.ok(capturedCronHandler, 'Cron handler must be registered');

    capturedLogs.length = 0;
    capturedCronHandler(); // simulate cron firing at 12:00
    await new Promise(r => setImmediate(r));

    const windowOpened = capturedLogs.find(l => l.msg.includes('polling window'));
    assert.ok(windowOpened, 'Firing the cron handler must open a polling window');
    psService.destroyScheduler();
  });

});

// ---------------------------------------------------------------------------
// destroyScheduler
// ---------------------------------------------------------------------------

describe('destroyScheduler — graceful shutdown', () => {

  test('logs scheduler stopped', () => {
    resetPolling();
    psService.initScheduler(async () => {});
    capturedLogs.length = 0;
    psService.destroyScheduler();
    const stopped = capturedLogs.find(l => l.msg.includes('stopped'));
    assert.ok(stopped, 'destroyScheduler must log that the scheduler was stopped');
  });

  test('calling destroyScheduler twice does not throw', () => {
    resetPolling();
    psService.initScheduler(async () => {});
    assert.doesNotThrow(() => {
      psService.destroyScheduler();
      psService.destroyScheduler();
    });
  });

});
