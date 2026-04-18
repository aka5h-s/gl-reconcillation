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

let apimService;
let originalLoad;

before(() => {
  originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@sap/cds') return { log: makeCdsLog };
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../apim-service.js')];
  apimService = require('../apim-service.js');
});

after(() => {
  Module._load = originalLoad;
});

describe('apim-service — notifyAPIM', () => {

  test('notifyAPIM SUCCESS completes without throwing', async () => {
    capturedLogs.length = 0;
    const details = { status: 'SUCCESS', attempt: 1, s4Count: 22, dsCount: 22 };
    await assert.doesNotReject(() => apimService.notifyAPIM('SUCCESS', details));
  });

  test('notifyAPIM SUCCESS logs status=SUCCESS', async () => {
    capturedLogs.length = 0;
    await apimService.notifyAPIM('SUCCESS', { s4Count: 22 });
    const line = capturedLogs.find(l => l.msg.includes('status=SUCCESS'));
    assert.ok(line, 'Expected a log line containing status=SUCCESS');
  });

  test('notifyAPIM FAILED completes without throwing', async () => {
    capturedLogs.length = 0;
    const details = { status: 'FAILED', attempt: 3, failedStep: 1, s4Count: 100, dsCount: 95 };
    await assert.doesNotReject(() => apimService.notifyAPIM('FAILED', details));
  });

  test('notifyAPIM FAILED logs status=FAILED', async () => {
    capturedLogs.length = 0;
    await apimService.notifyAPIM('FAILED', { failedStep: 1 });
    const line = capturedLogs.find(l => l.msg.includes('status=FAILED'));
    assert.ok(line, 'Expected a log line containing status=FAILED');
  });

  test('notifyAPIM works with empty details object', async () => {
    capturedLogs.length = 0;
    await assert.doesNotReject(() => apimService.notifyAPIM('SUCCESS', {}));
  });

});
