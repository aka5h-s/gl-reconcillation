// scheduler-test.js
// TEMPORARY — delete srv/scheduler-test.cds and srv/scheduler-test.js after demo.
//
// Implements runSchedulerTest with 4 test scenarios:
//   1 — data matches on first real attempt
//   2 — forced failures on attempts 1-2, real runReconciliation on attempt 3
//   3 — forced failures on all 3 attempts (FAILED sent to APIM)
//   4 — real runReconciliation for today's date (expected: no data → NO_DATA result)

const cds = require('@sap/cds');
const { runReconciliation } = require('./services/compare-service');
const { notifyAPIM }        = require('./services/apim-service');

const log = cds.log('scheduler-test');

// --- Constants ---

const MAX_RETRIES          = 3;
const FORCED_FAIL_S4_COUNT = 100;  // simulated S4 count shown in forced-fail log lines
const FORCED_FAIL_DS_COUNT = 95;   // simulated DS count shown in forced-fail log lines

// Known-good date: has a completion row in db_accountingdataprocessstatus and 7 records in both systems.
const TEST_DATE_WITH_DATA = '2026-03-31';
const TEST_START_HOUR     = 23;   // covers the full business day (00:00-23:00)

const SCENARIO_LABELS = {
  1: 'Data matches on first attempt',
  2: 'Fails 2 times, matches on 3rd attempt',
  3: 'Never matches — all 3 attempts fail',
  4: 'No data in either system'
};

// --- Helpers ---

// Returns current time as HH:MM:SS string for log message prefixes
function ts() {
  return new Date().toTimeString().slice(0, 8);
}

// Returns today's date as YYYY-MM-DD using local calendar date (not UTC).
// Avoids off-by-one around midnight in non-UTC server environments.
function todayDate() {
  const now = new Date();
  const y   = now.getFullYear();
  const m   = String(now.getMonth() + 1).padStart(2, '0');
  const d   = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Returns a promise that resolves after ms milliseconds
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Builds a flat ReconciliationResult object matching the CDS type in reconciliation-service.cds.
function buildResult(
  status, attempt, failedStep, s4Count, dsCount,
  step1Passed, step2Passed, step3Passed,
  glMismatchDetail, missingInDS, extraInDS, valueMismatches,
  durationMs, error
) {
  return {
    status, attempt, failedStep,
    s4Count, dsCount,
    step1Passed, step2Passed, step3Passed,
    glMismatches:    (glMismatchDetail || []).length,
    glMismatchDetail: glMismatchDetail || [],
    missingInDS:     missingInDS     || 0,
    extraInDS:       extraInDS       || 0,
    valueMismatches: valueMismatches || 0,
    durationMs,
    error: error || null
  };
}

// --- Service handler ---

module.exports = cds.service.impl(function () {

  this.on('runSchedulerTest', async (req) => {
    const { scenario, retryWaitSeconds } = req.data;
    const retryWaitMs  = (retryWaitSeconds || 5) * 1000;
    const overallStart = Date.now();

    // Scenario 4 reconciles today's date — expected to have no data in either system.
    // All other scenarios use a known-good date (7 records confirmed in S4 and DS).
    const testDate  = (scenario === 4) ? todayDate() : TEST_DATE_WITH_DATA;
    const startHour = TEST_START_HOUR;

    // Number of attempts that must be forced to fail before a real attempt is made.
    // Scenario 1: 0  — real attempt immediately on attempt 1
    // Scenario 2: 2  — forced fails on attempts 1-2, real on attempt 3
    // Scenario 3: 3  — all 3 attempts forced to fail, never reaches a real attempt
    // Scenario 4: 0  — real attempt immediately on attempt 1 (expected: NO_DATA)
    const forcedFailAttempts = scenario === 2 ? 2 : scenario === 3 ? 3 : 0;

    log.info(`[${ts()}] ════════════ SCHEDULER TEST — SCENARIO ${scenario} ════════════`);
    log.info(`[${ts()}] Scenario: ${SCENARIO_LABELS[scenario] || 'Unknown'}`);

    if (scenario === 4) {
      log.info(`[${ts()}] Date: ${testDate} (today — no data expected)`);
    } else {
      log.info(`[${ts()}] Date: ${testDate}, startHour: ${startHour}, retryWait: ${retryWaitSeconds || 5}s`);
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      log.info(`[${ts()}] ─── Attempt ${attempt} of ${MAX_RETRIES} ─────────────────────────────────`);

      // Forced failure path — scenarios 2 (attempts 1-2) and 3 (all 3 attempts)
      if (attempt <= forcedFailAttempts) {
        log.info(`[${ts()}]   FORCED FAIL — simulating mismatch for test`);
        log.warn(`[${ts()}]   Step 1 FAILED (simulated): S4=${FORCED_FAIL_S4_COUNT}, DS=${FORCED_FAIL_DS_COUNT}`);

        if (attempt < MAX_RETRIES) {
          log.info(`[${ts()}]   Waiting ${retryWaitSeconds || 5}s before retry...`);
          await delay(retryWaitMs);
          continue;
        }

        // Scenario 3 — all forced failures exhausted, declare FAILED
        const durationMs = Date.now() - overallStart;
        const result = buildResult('FAILED', attempt, 1,
          FORCED_FAIL_S4_COUNT, FORCED_FAIL_DS_COUNT,
          false, false, false, [], 0, 0, 0, durationMs,
          'Simulated step 1 failure (test scenario)');
        log.info(`[${ts()}] ════ RESULT: FAILED (attempt ${attempt}/${MAX_RETRIES}, ${durationMs}ms) ════════`);
        log.info(`[${ts()}] APIM notified: FAILED`);
        await notifyAPIM('FAILED', result);
        return result;
      }

      // Real reconciliation attempt — calls the full runReconciliation path (3 steps, 1 attempt).
      // For scenario 2: this is attempt 3 of 3 after 2 forced failures.
      // For scenarios 1 and 4: this is attempt 1 of 3.
      const r          = await runReconciliation(testDate, startHour);
      const durationMs = Date.now() - overallStart;

      // Override the attempt number with the outer counter (runReconciliation always returns attempt=1
      // when it succeeds on its first internal try, but the test wrapper tracks the outer attempt).
      const result = { ...r, attempt, durationMs };

      const statusLabel = result.status;
      log.info(`[${ts()}] ════ RESULT: ${statusLabel} (attempt ${attempt}/${MAX_RETRIES}, ${durationMs}ms) ═════════`);

      if (result.status === 'FAILED') {
        log.info(`[${ts()}] APIM notified: FAILED`);
      }

      return result;
    }
  });

});
