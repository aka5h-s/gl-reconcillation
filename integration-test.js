'use strict';

// ---------------------------------------------------------------------------
// GL Reconciliation — Integration Test
//
// Runs real HTTP calls against your deployed CF app. No mocking.
//
// Usage:
//   APP_URL=https://your-app.cfapps.eu10.hana.ondemand.com \
//   TOKEN=<bearer-token> \
//   TEST_DATE=2026-01-28 \
//   TEST_HOUR=24 \
//   node integration-test.js
//
// TOKEN is optional — omit if your app does not require auth.
// TEST_DATE and TEST_HOUR default to 2026-01-28 and 24.
// ---------------------------------------------------------------------------

const APP_URL   = (process.env.APP_URL   || '').replace(/\/$/, '');
const TOKEN     = process.env.TOKEN      || '';
const TEST_DATE = process.env.TEST_DATE  || '2026-01-28';
const TEST_HOUR = parseInt(process.env.TEST_HOUR || '24', 10);
const SVC       = `${APP_URL}/odata/v4/reconciliation`;

if (!APP_URL) {
  console.error('ERROR: APP_URL environment variable is required.');
  console.error('  Example: APP_URL=https://your-app.cfapps.eu10.hana.ondemand.com node integration-test.js');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function post(action, body = {}) {
  const url = `${SVC}/${action}`;
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

  const res = await fetch(url, {
    method:  'POST',
    headers,
    body:    JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${action}: ${text.slice(0, 300)}`);
  }

  try {
    const json = JSON.parse(text);
    return json.value !== undefined ? json.value : json;
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

async function run(label, fn) {
  const start = Date.now();
  try {
    const info = await fn();
    const ms   = Date.now() - start;
    const extra = info ? ` — ${info}` : '';
    console.log(`  PASS  ${label}${extra} (${ms}ms)`);
    passed++;
  } catch (err) {
    const ms = Date.now() - start;
    console.log(`  FAIL  ${label} (${ms}ms)`);
    console.log(`        ${err.message}`);
    failed++;
    failures.push({ label, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Test groups
// ---------------------------------------------------------------------------

async function testConnections() {
  console.log('\nConnections');

  await run('S4 GL line item connection', async () => {
    const r = await post('testS4ConnectionGLLineItem');
    if (String(r).includes('FAILED')) throw new Error(r);
    return r;
  });

  await run('S4 journal entry connection', async () => {
    const r = await post('testS4ConnectionJournalEntry');
    if (String(r).includes('FAILED')) throw new Error(r);
    return r;
  });

  await run('Datasphere connection', async () => {
    const r = await post('testDatasphereConnection');
    if (String(r).includes('FAILED')) throw new Error(r);
    return r;
  });

  await run('PostgreSQL connection', async () => {
    const r = await post('testDatabaseConnection');
    if (String(r).includes('FAILED')) throw new Error(r);
    return r;
  });

  await run('PostgreSQL table access', async () => {
    const r = await post('testDatabaseTable');
    if (String(r).includes('FAILED') || String(r).includes('Error')) throw new Error(r);
    return 'rows returned';
  });
}

async function testCounts() {
  console.log(`\nRecord Counts  (date=${TEST_DATE}  hour=${TEST_HOUR})`);

  let s4Count, dsCount;

  await run('S4 total count', async () => {
    s4Count = await post('testS4CountByDate', { date: TEST_DATE, startHour: TEST_HOUR });
    if (typeof s4Count !== 'number') throw new Error(`Unexpected response: ${s4Count}`);
    return `${s4Count} records`;
  });

  await run('DS total count', async () => {
    dsCount = await post('testDSCount', { date: TEST_DATE, startHour: TEST_HOUR });
    if (typeof dsCount !== 'number') throw new Error(`Unexpected response: ${dsCount}`);
    return `${dsCount} records`;
  });

  await run('S4 vs DS count match', async () => {
    if (s4Count === undefined || dsCount === undefined) throw new Error('One or both counts failed — skipping comparison');
    if (s4Count !== dsCount) throw new Error(`S4=${s4Count} does not match DS=${dsCount}`);
    return `both ${s4Count}`;
  });

  await run('S4 per-GL account breakdown', async () => {
    const r = await post('testS4GLCountByDate', { date: TEST_DATE, startHour: TEST_HOUR });
    if (!Array.isArray(r)) throw new Error(`Unexpected response: ${JSON.stringify(r)}`);
    return `${r.length} GL accounts`;
  });

  await run('DS per-GL account breakdown', async () => {
    const r = await post('testDSGLCount', { date: TEST_DATE, startHour: TEST_HOUR });
    if (!Array.isArray(r)) throw new Error(`Unexpected response: ${JSON.stringify(r)}`);
    return `${r.length} GL accounts`;
  });
}

async function testBulkLoad() {
  console.log(`\nBulk Load  (date=${TEST_DATE}  hour=${TEST_HOUR})`);

  await run('Fetch all S4 and DS records and compare counts', async () => {
    const r = await post('testBulkLoad', { date: TEST_DATE, startHour: TEST_HOUR });
    const info = `S4=${r.s4Records}  DS=${r.dsRecords}  GL accounts=${r.glAccounts}  match=${r.countsMatch}  elapsed=${r.elapsedMs}ms`;
    if (!r.countsMatch) throw new Error(`Count mismatch — ${info}`);
    return info;
  });
}

async function testReconciliation() {
  console.log(`\nFull Reconciliation  (date=${TEST_DATE}  hour=${TEST_HOUR})`);

  await run('runReconciliation end-to-end', async () => {
    const r = await post('runReconciliation', { date: TEST_DATE, startHour: TEST_HOUR });
    const info =
      `status=${r.status}  attempt=${r.attempt}  ` +
      `step1=${r.step1Passed}  step2=${r.step2Passed}  step3=${r.step3Passed}  ` +
      `duration=${r.durationMs}ms`;
    if (r.status === 'FAILED') throw new Error(`Reconciliation FAILED — ${info}  error=${r.error || '-'}`);
    return info;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log('GL Reconciliation — Integration Test');
  console.log(`App : ${APP_URL}`);
  console.log(`Date: ${TEST_DATE}  Hour: ${TEST_HOUR}`);
  console.log(`Auth: ${TOKEN ? 'Bearer token provided' : 'none'}`);

  await testConnections();
  await testCounts();
  await testBulkLoad();
  await testReconciliation();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Tests: ${passed + failed}  Pass: ${passed}  Fail: ${failed}`);

  if (failures.length > 0) {
    console.log('\nFailed tests:');
    for (const f of failures) {
      console.log(`  - ${f.label}`);
      console.log(`    ${f.error}`);
    }
    process.exit(1);
  }
})();
