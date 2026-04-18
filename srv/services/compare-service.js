// compare-service.js
// Implements the 3-step reconciliation comparison logic between S4 and Datasphere.
//
// S4 is always the source of truth:
//   - S4 data is fetched first at every step.
//   - DS data is fetched only after S4 succeeds.
//   - DS values must equal S4 values.
//
// Log format:
//   Every message is prefixed with [HH:MM:SS] so timestamps are visible in CF logs
//   without decoding the CF JSON envelope.
//   Step boundaries are marked with divider lines.
//   Per-step elapsed time is appended after each step result.
//   GL mismatches are printed as a single formatted block.

const cds = require('@sap/cds');
const { getS4CountByDate, getS4GLCountByDate, getS4DataByDate } = require('./s4-service');
const { getDSCountByDate, getDSGLCountByDate, getDSDataByDate } = require('./ds-service');
const { notifyAPIM } = require('./apim-service');

const log = cds.log('compare-service');

// Retry configuration
const MAX_RETRIES   = 3;  // total number of attempts before declaring FAILED

// Wait between retry attempts. Override via env var for testing (e.g. RETRY_WAIT_MS=10000).
// Default: 1800000ms (30 minutes).
const RETRY_WAIT_MS = 1800000;

// --- Helpers ---

// Returns current time as HH:MM:SS string for log message prefixes
function ts() {
  return new Date().toTimeString().slice(0, 8);
}

// Returns a promise that resolves after ms milliseconds
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Normalises a GL account string to 10 digits with leading zeros.
// S4 returns GL accounts without leading zeros (e.g. '10010010'),
// while Datasphere stores them zero-padded to 10 digits (e.g. '0010010010').
function normalizeGL(gl) {
  return String(gl || '').padStart(10, '0');
}

// Builds the composite key used to match S4 and Datasphere records in Step 3.
// Key fields: SourceLedger, CompanyCode, FiscalYear, AccountingDocument, LedgerGLLineItem.
// AccountingDocument is zero-padded to 10 digits to handle leading-zero differences.
function buildKey(r) {
  return [
    r.SourceLedger,
    r.CompanyCode,
    r.FiscalYear,
    String(r.AccountingDocument || '').padStart(10, '0'),
    r.LedgerGLLineItem
  ].join('|');
}

// --- Step comparison functions ---

// Step 1: Total record count comparison.
// Returns { passed, s4Count, dsCount }.
function compareStep1Count(s4Count, dsCount) {
  const passed = s4Count === dsCount;
  return { passed, s4Count, dsCount };
}

// Step 2: Per-GL account record count comparison.
// Input: arrays of { GLAccount, RecordCount } from each system.
// Returns { passed, mismatches[] } where each mismatch has { GLAccount, s4Count, dsCount }.
// A GL present in one system but absent from the other counts as 0 on the missing side.
function compareStep2GLCounts(s4GLData, dsGLData) {
  const s4Map = {};
  const dsMap = {};

  for (const r of s4GLData) {
    if (r.GLAccount) s4Map[normalizeGL(r.GLAccount)] = r.RecordCount;
  }
  for (const r of dsGLData) {
    if (r.GLAccount) dsMap[normalizeGL(r.GLAccount)] = r.RecordCount;
  }

  const allGLs     = new Set([...Object.keys(s4Map), ...Object.keys(dsMap)]);
  const mismatches = [];

  for (const gl of allGLs) {
    const s4Count = s4Map[gl] ?? 0;
    const dsCount = dsMap[gl] ?? 0;
    if (s4Count !== dsCount) mismatches.push({ GLAccount: gl, s4Count, dsCount });
  }

  const passed = mismatches.length === 0;
  return { passed, mismatches, totalGLs: allGLs.size };
}

// Step 3: Full row-level data comparison on 6 fields.
// Matches records by 5-field composite key, then checks AmountInTransactionCurrency.
// Returns { passed, missingInDS[], extraInDS[], mismatches[] }.
function compareStep3FullData(s4Data, dsData) {
  const s4Map = new Map();
  const dsMap = new Map();

  for (const r of s4Data) s4Map.set(buildKey(r), r);
  for (const r of dsData) dsMap.set(buildKey(r), r);

  const missingInDS = [];
  const extraInDS   = [];
  const mismatches  = [];

  for (const [key, s4] of s4Map) {
    const ds = dsMap.get(key);
    if (!ds) {
      missingInDS.push(key);
      continue;
    }
    const s4Amount = Number(s4.AmountInTransactionCurrency);
    const dsAmount = Number(ds.AmountInTransactionCurrency);
    if (s4Amount !== dsAmount) mismatches.push({ recordKey: key, s4Amount, dsAmount });
  }

  for (const [key] of dsMap) {
    if (!s4Map.has(key)) extraInDS.push(key);
  }

  const passed =
    missingInDS.length === 0 &&
    extraInDS.length   === 0 &&
    mismatches.length  === 0;

  return { passed, missingInDS, extraInDS, mismatches };
}

// --- Main orchestrator ---

// Runs all 3 reconciliation steps in order with retry and APIM notification.
//
// S4 is fetched first at every step. DS is only fetched after S4 succeeds.
// On any step failure: waits RETRY_WAIT_MS and retries, up to MAX_RETRIES attempts.
// On final failure: calls notifyAPIM('FAILED') and returns the result object.
// On success:        calls notifyAPIM('SUCCESS') and returns the result object.
// If both systems have zero records: returns status=NO_DATA without retrying or notifying APIM.
//
// Returns a ReconciliationResult object matching the CDS type in reconciliation-service.cds.
async function runReconciliation(date, startHour) {
  const overallStart = Date.now();

  log.info(`[${ts()}] ════════════════════════════════════════`);
  log.info(`[${ts()}] GL Reconciliation started — date=${date}, startHour=${startHour}`);
  log.info(`[${ts()}] Max attempts: ${MAX_RETRIES}, retry wait: ${RETRY_WAIT_MS / 60000} min`);
  log.info(`[${ts()}] ════════════════════════════════════════`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      log.info(`[${ts()}] ─── Retry attempt ${attempt} of ${MAX_RETRIES} ──────────────────`);
    }

    try {

      // ── Step 1: Total record count ─────────────────────────────────────────
      log.info(`[${ts()}] ─── Step 1: Total Count ───────────────────────────────`);
      const step1Start = Date.now();

      log.info(`[${ts()}] Fetching S4 total count...`);
      const s4Count = await getS4CountByDate(date, startHour);

      log.info(`[${ts()}] S4 count: ${s4Count} — fetching DS count...`);
      const dsCount = await getDSCountByDate(date, startHour);

      // NO_DATA check — if both systems have zero records there is nothing to reconcile.
      // Return immediately without retrying or notifying APIM.
      if (s4Count === 0 && dsCount === 0) {
        log.warn(`[${ts()}] No data found in either system for date=${date} — skipping reconciliation`);
        return buildResult('NO_DATA', attempt, 0, 0, 0,
          false, false, false, [], 0, 0, 0,
          Date.now() - overallStart, 'No data in S4 or DS for this date');
      }

      const step1  = compareStep1Count(s4Count, dsCount);
      const step1Ms = Date.now() - step1Start;

      if (!step1.passed) {
        log.warn(`[${ts()}] Step 1 FAILED: S4=${s4Count}, DS=${dsCount} — counts differ (${step1Ms}ms)`);

        if (attempt < MAX_RETRIES) {
          log.info(`[${ts()}] Waiting ${RETRY_WAIT_MS / 60000} min before retry...`);
          await delay(RETRY_WAIT_MS);
          continue;
        }

        const result = buildResult('FAILED', attempt, 1, s4Count, dsCount,
          false, false, false, [], 0, 0, 0, Date.now() - overallStart, null);
        await notifyAPIM('FAILED', result);
        return result;
      }

      log.info(`[${ts()}] Step 1 PASSED: S4=${s4Count}, DS=${dsCount} (${step1Ms}ms)`);

      // ── Step 2: Per-GL account counts ─────────────────────────────────────
      log.info(`[${ts()}] ─── Step 2: GL Account Counts ────────────────────────`);
      const step2Start = Date.now();

      log.info(`[${ts()}] Fetching S4 GL breakdown...`);
      const s4GLData = await getS4GLCountByDate(date, startHour);

      log.info(`[${ts()}] S4 GL accounts: ${s4GLData.length} — fetching DS GL breakdown...`);
      const dsGLData = await getDSGLCountByDate(date, startHour);

      const step2   = compareStep2GLCounts(s4GLData, dsGLData);
      const step2Ms = Date.now() - step2Start;

      if (!step2.passed) {
        const mismatchLines = step2.mismatches
          .map(m => `  GL ${m.GLAccount}  S4=${m.s4Count}  DS=${m.dsCount}`)
          .join('\n');
        log.warn(
          `[${ts()}] Step 2 FAILED — ${step2.mismatches.length} GL mismatch(es) (${step2Ms}ms):\n${mismatchLines}`
        );

        if (attempt < MAX_RETRIES) {
          log.info(`[${ts()}] Waiting ${RETRY_WAIT_MS / 60000} min before retry...`);
          await delay(RETRY_WAIT_MS);
          continue;
        }

        const result = buildResult('FAILED', attempt, 2, s4Count, dsCount,
          true, false, false,
          step2.mismatches.map(m => ({ GLAccount: m.GLAccount, s4Count: m.s4Count, dsCount: m.dsCount })),
          0, 0, 0, Date.now() - overallStart, null);
        await notifyAPIM('FAILED', result);
        return result;
      }

      log.info(`[${ts()}] Step 2 PASSED: ${step2.totalGLs} GL accounts all match (${step2Ms}ms)`);

      // ── Step 3: Full row-level comparison ─────────────────────────────────
      log.info(`[${ts()}] ─── Step 3: Full Row Comparison ──────────────────────`);
      const step3Start = Date.now();

      log.info(`[${ts()}] Fetching S4 full data...`);
      const s4Data = await getS4DataByDate(date, startHour);

      log.info(`[${ts()}] S4 records: ${s4Data.length} — fetching DS full data...`);
      const dsData = await getDSDataByDate(date, startHour, dsGLData);

      log.info(`[${ts()}] DS records: ${dsData.length} — running row comparison...`);
      const step3   = compareStep3FullData(s4Data, dsData);
      const step3Ms = Date.now() - step3Start;

      if (!step3.passed) {
        log.warn(
          `[${ts()}] Step 3 FAILED (${step3Ms}ms): ` +
          `missingInDS=${step3.missingInDS.length}, extraInDS=${step3.extraInDS.length}, ` +
          `valueMismatches=${step3.mismatches.length}`
        );

        if (attempt < MAX_RETRIES) {
          log.info(`[${ts()}] Waiting ${RETRY_WAIT_MS / 60000} min before retry...`);
          await delay(RETRY_WAIT_MS);
          continue;
        }

        const result = buildResult('FAILED', attempt, 3, s4Count, dsCount,
          true, true, false, [],
          step3.missingInDS.length, step3.extraInDS.length, step3.mismatches.length,
          Date.now() - overallStart, null);
        await notifyAPIM('FAILED', result);
        return result;
      }

      log.info(`[${ts()}] Step 3 PASSED: ${s4Data.length} records compared (${step3Ms}ms)`);

      // ── All steps passed ───────────────────────────────────────────────────
      const totalMs = Date.now() - overallStart;
      log.info(`[${ts()}] ════════════════════════════════════════`);
      log.info(`[${ts()}] Reconciliation SUCCEEDED — attempt ${attempt}/${MAX_RETRIES}, total: ${totalMs}ms`);
      log.info(`[${ts()}] ════════════════════════════════════════`);

      const result = buildResult('SUCCESS', attempt, 0, s4Count, dsCount,
        true, true, true, [], 0, 0, 0, totalMs, null);
      await notifyAPIM('SUCCESS', result);
      return result;

    } catch (err) {
      log.error(`[${ts()}] Attempt ${attempt} threw an unexpected error: ${err.message}`);

      if (attempt < MAX_RETRIES) {
        log.info(`[${ts()}] Waiting ${RETRY_WAIT_MS / 60000} min before retry...`);
        await delay(RETRY_WAIT_MS);
        continue;
      }

      const result = buildResult('FAILED', attempt, 0, 0, 0,
        false, false, false, [], 0, 0, 0,
        Date.now() - overallStart, err.message);
      await notifyAPIM('FAILED', result);
      return result;
    }
  }
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
    glMismatches: glMismatchDetail.length,
    glMismatchDetail,
    missingInDS, extraInDS, valueMismatches,
    durationMs,
    error
  };
}

module.exports = {
  compareStep1Count,
  compareStep2GLCounts,
  compareStep3FullData,
  runReconciliation
};
