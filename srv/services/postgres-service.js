// postgres-service.js
// Handles the daily scheduling and PostgreSQL polling logic for GL reconciliation.
//
// Schedule:
//   - At POLL_START_HOUR:POLL_START_MINUTE (default 12:00) each day, node-cron opens a polling window.
//   - Every POLL_INTERVAL_MS (5 minutes), PostgreSQL is queried for a completed Summit job.
//   - When a completed job is found, polling stops and reconciliation runs immediately.
//   - If no job is found within POLL_TIMEOUT_HOURS (default 6), polling stops automatically
//     and a NO_SUMMIT notification is sent to APIM.
//   - After reconciliation finishes, the scheduler automatically arms itself for the
//     next day's polling window at POLL_START_HOUR.
//
// Configuration (hardcoded):
//   POLL_START_HOUR    = 12  — polling window opens at 12:00 UTC daily
//   POLL_START_MINUTE  = 0
//   POLL_TIMEOUT_HOURS = 6   — polling window closes after 6 hours if no job is detected

const cds  = require('@sap/cds');
const cron = require('node-cron');
const { notifyAPIM } = require('./apim-service');

const log = cds.log('postgres-service');

// --- Constants ---

// How often to check PostgreSQL for a completed Summit job while in the polling window
const POLL_INTERVAL_MS = 300000; // 5 minutes

// New polling table: a row is written here when both Summit and Framework data are
// successfully processed, indicated by 'X' in each flag column.
const PROCESS_STATUS_TABLE = 'summitaccountingdata.db_accountingdataprocessstatus';
const PROCESS_DATE_COL     = 'processingdate';
const SUMMIT_FLAG_COL      = 'summitdataprocessedsuccessfully';
const FRAMEWORK_FLAG_COL   = 'frameworksdataprocessedsuccessfully';

// Old polling constants — kept for reference next to the commented-out old query below.
// const SUMMIT_JOB_TABLE  = process.env.SUMMIT_JOB_TABLE  || 'summitaccountingdata.db_accountingdata';
// const STATUS_COLUMN     = process.env.SUMMIT_STATUS_COL || 'processingstatus_id';
// const COMPLETED_VALUE   = process.env.SUMMIT_DONE_VALUE || '04';
// const TIMESTAMP_COLUMN  = process.env.SUMMIT_TIME_COL   || 'modifiedat';
// const DATE_COLUMN       = process.env.SUMMIT_DATE_COL   || 'appdate';

// Hour and minute at which the daily polling window opens — 12:00 UTC.
const POLL_START_HOUR   = 12;
const POLL_START_MINUTE = 0;

// Maximum hours to keep the polling window open before giving up for the day.
const POLL_TIMEOUT_HOURS = 6;
const POLL_TIMEOUT_MS    = POLL_TIMEOUT_HOURS * 60 * 60 * 1000;

// --- State ---

// Holds the setInterval reference for the active polling window
let pollingInterval  = null;

// Timestamp when the current polling window was opened (used for timeout check)
let pollingStartTime = null;

// Holds the node-cron task so it can be destroyed if needed
let cronTask = null;

// --- Helpers ---

// Returns current time as HH:MM:SS string for log message prefixes
function ts() {
  return new Date().toTimeString().slice(0, 8);
}

// --- Polling ---

// Queries PostgreSQL for a completed Summit job row in today's process status table.
// On finding a completed job: stops polling and runs reconciliation immediately.
// onJobComplete(date, startHour) is called when reconciliation should start.
// After onJobComplete resolves, the daily cron re-arms automatically for tomorrow.
async function checkSummitJob(onJobComplete) {
  // Stop polling if the window has been open longer than POLL_TIMEOUT_HOURS
  if (pollingStartTime && (Date.now() - pollingStartTime) >= POLL_TIMEOUT_MS) {
    await expirePolling();
    return;
  }

  try {
    const db = await cds.connect.to('db');

    // ── Poll db_accountingdataprocessstatus ────────────────────────────────────
    // A row is present for today when both summitdataprocessedsuccessfully and
    // frameworksdataprocessedsuccessfully are 'X', meaning the daily job is done.
    const rows = await db.run(
      `SELECT ${PROCESS_DATE_COL}
       FROM ${PROCESS_STATUS_TABLE}
       WHERE ${PROCESS_DATE_COL}::date = CURRENT_DATE
         AND ${SUMMIT_FLAG_COL}   = 'X'
         AND ${FRAMEWORK_FLAG_COL} = 'X'
       LIMIT 1`
    );

    const row = rows && rows[0];

    if (!row || !row[PROCESS_DATE_COL]) {
      log.info(`[${ts()}] Summit job not yet complete — will check again in ${POLL_INTERVAL_MS / 60000} min`);
      return;
    }

    // processingdate is an ISO timestamp (e.g. '2026-04-17T14:32:00.000Z').
    // Extract YYYY-MM-DD for the reconciliation date.
    // Derive startHour as the next full hour after the completion timestamp.
    // Example: completed at 14:32 → startHour = 15 (covers 00:00-15:00 of the posting date).
    const completionTime = new Date(row[PROCESS_DATE_COL]);
    const postingDate    = completionTime.toISOString().slice(0, 10);
    const startHour      = (completionTime.getHours() + 1) % 24;

    log.info(`[${ts()}] Summit job detected — processingdate: ${row[PROCESS_DATE_COL]}, postingDate: ${postingDate}, startHour: ${startHour}`);

    stopPolling();

    log.info(`[${ts()}] Running reconciliation immediately for ${postingDate}`);
    await onJobComplete(postingDate, startHour);

  } catch (err) {
    // Transient DB error — log and keep polling
    log.error(`[${ts()}] checkSummitJob error: ${err.message}`);
  }
}

// Starts polling PostgreSQL every POLL_INTERVAL_MS.
// Safe to call multiple times — will not start a second interval if already running.
function startPolling(onJobComplete) {
  if (pollingInterval) {
    log.info(`[${ts()}] Polling already active — skipping duplicate start`);
    return;
  }

  pollingStartTime = Date.now();
  const expiryTime = new Date(pollingStartTime + POLL_TIMEOUT_MS).toTimeString().slice(0, 8);

  log.info(`[${ts()}] Daily polling window opened — checking PostgreSQL every ${POLL_INTERVAL_MS / 60000} min`);
  log.info(`[${ts()}] Polling window will expire at ${expiryTime} UTC if no Summit job is detected (${POLL_TIMEOUT_HOURS}h timeout)`);
  log.info(`[${ts()}] Table: ${PROCESS_STATUS_TABLE}, flags: ${SUMMIT_FLAG_COL}, ${FRAMEWORK_FLAG_COL}`);

  // Immediately check on window open, then repeat on interval
  checkSummitJob(onJobComplete);

  pollingInterval = setInterval(() => {
    checkSummitJob(onJobComplete);
  }, POLL_INTERVAL_MS);
}

// Stops the active polling interval after a successful Summit job detection.
function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval  = null;
    pollingStartTime = null;
    log.info(`[${ts()}] Polling window closed — Summit job detected`);
  }
}

// Stops the active polling interval after the timeout window has elapsed with no data.
// Sends NO_SUMMIT to APIM to signal that Summit did not run today.
async function expirePolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval  = null;
    pollingStartTime = null;

    const today = new Date().toISOString().slice(0, 10);
    log.warn(`[${ts()}] Polling window expired — no Summit job detected after ${POLL_TIMEOUT_HOURS}h. Next window tomorrow at ${String(POLL_START_HOUR).padStart(2, '0')}:${String(POLL_START_MINUTE).padStart(2, '0')}`);

    try {
      await notifyAPIM('NO_SUMMIT', {
        message: `Summit job did not run today — no completion signal received within ${POLL_TIMEOUT_HOURS}h polling window`,
        date:    today
      });
    } catch (err) {
      log.error(`[${ts()}] Failed to send NO_SUMMIT notification to APIM: ${err.message}`);
    }
  }
}

// --- Daily scheduler ---

// Initialises the daily scheduler using node-cron.
// The cron expression fires at POLL_START_MINUTE of POLL_START_HOUR every day
// (e.g. "0 12 * * *" for 12:00, "15 14 * * *" for 14:15).
// This function is exported and called once by the CAP service handler on startup.
function initScheduler(onJobComplete) {
  const cronExpr = `${POLL_START_MINUTE} ${POLL_START_HOUR} * * *`;

  log.info(`[${ts()}] GL Reconciliation scheduler initialised — polling window starts daily at ${String(POLL_START_HOUR).padStart(2, '0')}:${String(POLL_START_MINUTE).padStart(2, '0')} (cron: "${cronExpr}")`);

  cronTask = cron.schedule(cronExpr, () => {
    log.info(`[${ts()}] node-cron fired — opening daily polling window`);
    startPolling(async (date, startHour) => {
      await onJobComplete(date, startHour);
      // Cron will re-fire automatically tomorrow — just log completion
      log.info(`[${ts()}] Done — next polling window tomorrow at ${String(POLL_START_HOUR).padStart(2, '0')}:${String(POLL_START_MINUTE).padStart(2, '0')}`);
    });
  });

  log.info(`[${ts()}] Next polling window starts at ${String(POLL_START_HOUR).padStart(2, '0')}:${String(POLL_START_MINUTE).padStart(2, '0')}`);
}

// Destroys the cron task and clears any active polling interval.
// Intended for graceful shutdown.
function destroyScheduler() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval  = null;
    pollingStartTime = null;
  }
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    log.info(`[${ts()}] Scheduler stopped`);
  }
}

module.exports = {
  initScheduler,
  destroyScheduler,
  startPolling,
  stopPolling
};
