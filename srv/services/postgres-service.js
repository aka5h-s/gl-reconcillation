// postgres-service.js
// Handles the daily scheduling and PostgreSQL polling logic for GL reconciliation.
//
// Schedule:
//   - At POLL_START_HOUR:POLL_START_MINUTE (default 12:00) each day, node-cron opens a polling window.
//   - Every POLL_INTERVAL_MS (5 minutes), PostgreSQL is queried for Summit job completion.
//   - Polling is 2-stage:
//       Stage 1 — wait until S4H records for today arrive in db_accountingdata.
//       Stage 2 — wait until all those records are in a terminal state (04/02/05).
//   - When Stage 2 completes, reconciliation runs immediately.
//   - If no completion is detected within POLL_TIMEOUT_HOURS (default 6), polling stops
//     and a NO_SUMMIT notification is sent to APIM.
//   - After reconciliation, the scheduler arms itself for tomorrow automatically.
//
// Configuration (hardcoded):
//   POLL_START_HOUR    = 12  — polling window opens at 12:00 UTC daily
//   POLL_START_MINUTE  = 0
//   POLL_TIMEOUT_HOURS = 6   — polling window closes after 6 hours if no completion

const cds  = require('@sap/cds');
const cron = require('node-cron');
const { notifyAPIM } = require('./apim-service');

const log = cds.log('postgres-service');

// --- Constants ---

// How often to check PostgreSQL while in the polling window
const POLL_INTERVAL_MS = 300000; // 5 minutes

// Table and column references for db_accountingdata
const ACCOUNTING_DATA_TABLE = 'summitaccountingdata.db_accountingdata';
const STATUS_COL            = 'processingstatus_id';
const JEGROUPING_COL        = 'jegrouping';
const CREATEDAT_COL         = 'createdat';
const MODIFIEDAT_COL        = 'modifiedat';

// Jegrouping prefix that identifies S4HANA records (excludes ECC)
const S4H_PREFIX = 'S4H-%';

// Terminal processing statuses — a record in any of these is no longer in progress
// 04 = completed successfully, 02 = error, 05 = error variant
const TERMINAL_STATUSES = ['04', '02', '05'];

// Hour and minute at which the daily polling window opens — 12:00 UTC
const POLL_START_HOUR   = 6;
const POLL_START_MINUTE = 30;

// Maximum hours to keep the polling window open before giving up for the day
const POLL_TIMEOUT_HOURS = 6;
const POLL_TIMEOUT_MS    = POLL_TIMEOUT_HOURS * 60 * 60 * 1000;

// --- State ---

// Holds the setInterval reference for the active polling window
let pollingInterval  = null;

// Timestamp when the current polling window was opened (used for timeout check)
let pollingStartTime = null;

// Tracks whether Stage 1 (records arrived) has been satisfied
let stage1Complete = false;

// Holds the node-cron task so it can be destroyed if needed
let cronTask = null;

// --- Helpers ---

// Returns current time as HH:MM:SS string for log message prefixes
function ts() {
  return new Date().toTimeString().slice(0, 8);
}

// Builds an SQL IN clause from an array of quoted strings
function sqlIn(values) {
  return values.map(v => `'${v}'`).join(', ');
}

// --- Stage 1: wait for S4H records to arrive ---

// Returns true when at least one S4H record for today exists in db_accountingdata.
async function checkRecordsArrived(db) {
  const rows = await db.run(
    `SELECT COUNT(*) AS cnt
     FROM ${ACCOUNTING_DATA_TABLE}
     WHERE DATE(${CREATEDAT_COL}) = CURRENT_DATE
       AND ${JEGROUPING_COL} LIKE '${S4H_PREFIX}'`
  );
  const count = parseInt(rows[0]?.cnt || '0', 10);
  return count > 0;
}

// --- Stage 2: wait for all S4H records to reach a terminal state ---

// Queries db_accountingdata for:
//   - totalS4H    : total S4H records created today
//   - inProgress  : S4H records not yet in a terminal state
//   - maxModified : latest modifiedat timestamp across all S4H records today
// Returns null on unexpected DB error (caller keeps polling).
async function querySummitStatus(db) {
  const terminalIn = sqlIn(TERMINAL_STATUSES);

  const rows = await db.run(
    `SELECT
       COUNT(*)                                                          AS total,
       COUNT(*) FILTER (WHERE ${STATUS_COL} NOT IN (${terminalIn}))    AS in_progress,
       MAX(${MODIFIEDAT_COL})                                           AS max_modified
     FROM ${ACCOUNTING_DATA_TABLE}
     WHERE DATE(${CREATEDAT_COL}) = CURRENT_DATE
       AND ${JEGROUPING_COL} LIKE '${S4H_PREFIX}'`
  );

  const row = rows && rows[0];
  if (!row) return null;

  return {
    totalS4H:    parseInt(row.total       || '0', 10),
    inProgress:  parseInt(row.in_progress || '0', 10),
    maxModified: row.max_modified
  };
}

// --- Polling ---

// Called on every poll tick.
// Stage 1: waits for S4H records to appear in db_accountingdata for today.
// Stage 2: waits until all those records are in a terminal state (04/02/05).
// On Stage 2 completion: derives postingDate and startHour, stops polling, triggers reconciliation.
async function checkSummitJob(onJobComplete) {
  // Stop polling if the window has been open longer than POLL_TIMEOUT_HOURS
  if (pollingStartTime && (Date.now() - pollingStartTime) >= POLL_TIMEOUT_MS) {
    await expirePolling();
    return;
  }

  try {
    const db = await cds.connect.to('db');

    // ── Stage 1: wait for S4H records to arrive ───────────────────────────────
    if (!stage1Complete) {
      const arrived = await checkRecordsArrived(db);

      if (!arrived) {
        log.info(`[${ts()}] Stage 1 — no S4H records yet for today; will check again in ${POLL_INTERVAL_MS / 60000} min`);
        return;
      }

      stage1Complete = true;
      log.info(`[${ts()}] Stage 1 complete — S4H records have arrived in db_accountingdata`);
    }

    // ── Stage 2: wait for all S4H records to reach a terminal state ───────────
    const status = await querySummitStatus(db);

    if (!status) {
      log.warn(`[${ts()}] Stage 2 — unexpected empty result from DB; will check again in ${POLL_INTERVAL_MS / 60000} min`);
      return;
    }

    log.info(`[${ts()}] Stage 2 — total S4H: ${status.totalS4H}, still in progress: ${status.inProgress}`);

    if (status.inProgress > 0) {
      log.info(`[${ts()}] Stage 2 — Summit not yet complete; will check again in ${POLL_INTERVAL_MS / 60000} min`);
      return;
    }

    if (status.totalS4H === 0) {
      log.warn(`[${ts()}] Stage 2 — total S4H records is 0 after Stage 1 passed; will check again in ${POLL_INTERVAL_MS / 60000} min`);
      return;
    }

    // All S4H records are in a terminal state — Summit job is complete.
    // Both postingDate and startHour are derived from MAX(modifiedat) for UTC consistency.
    // startHour = completionUTCHour + 1, capped at 24 (covers the full posting day if
    // the last record completed at 23:xx, rather than wrapping incorrectly to hour 0).
    if (!status.maxModified) {
      log.warn(`[${ts()}] Stage 2 — MAX(modifiedat) is null despite inProgress=0; will check again in ${POLL_INTERVAL_MS / 60000} min`);
      return;
    }
    const completionTime = new Date(status.maxModified);
    const postingDate    = completionTime.toISOString().slice(0, 10);
    const completionHour = completionTime.getUTCHours();
    const startHour      = completionHour + 1 < 24 ? completionHour + 1 : 24;

    log.info(`[${ts()}] Stage 2 complete — Summit job done. maxModifiedAt: ${status.maxModified}, postingDate: ${postingDate}, startHour: ${startHour}`);
    log.info(`[${ts()}] Total S4H records completed: ${status.totalS4H}`);

    stopPolling();

    log.info(`[${ts()}] Running reconciliation for ${postingDate} (data window 00:00-${String(startHour).padStart(2, '0')}:00)`);
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
  stage1Complete   = false;

  const expiryTime = new Date(pollingStartTime + POLL_TIMEOUT_MS).toTimeString().slice(0, 8);

  log.info(`[${ts()}] Daily polling window opened — checking every ${POLL_INTERVAL_MS / 60000} min`);
  log.info(`[${ts()}] Polling window expires at ${expiryTime} UTC if no Summit job detected (${POLL_TIMEOUT_HOURS}h timeout)`);
  log.info(`[${ts()}] Table: ${ACCOUNTING_DATA_TABLE}, Stage 1: S4H records arrive, Stage 2: all terminal (${TERMINAL_STATUSES.join('/')})`);

  // Immediately check on window open, then repeat on interval
  checkSummitJob(onJobComplete);

  pollingInterval = setInterval(() => {
    checkSummitJob(onJobComplete);
  }, POLL_INTERVAL_MS);
}

// Stops the active polling interval after a successful Stage 2 completion.
function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval  = null;
    pollingStartTime = null;
    stage1Complete   = false;
    log.info(`[${ts()}] Polling window closed — Summit job detected`);
  }
}

// Stops the active polling interval after the timeout window has elapsed with no completion.
// Sends NO_SUMMIT to APIM to signal that Summit did not complete today.
async function expirePolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval  = null;
    pollingStartTime = null;
    stage1Complete   = false;

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
// Fires at POLL_START_MINUTE of POLL_START_HOUR every day.
// Called once by the CAP service handler on startup.
function initScheduler(onJobComplete) {
  const cronExpr = `${POLL_START_MINUTE} ${POLL_START_HOUR} * * *`;

  log.info(`[${ts()}] GL Reconciliation scheduler initialised — polling window starts daily at ${String(POLL_START_HOUR).padStart(2, '0')}:${String(POLL_START_MINUTE).padStart(2, '0')} (cron: "${cronExpr}")`);

  cronTask = cron.schedule(cronExpr, () => {
    log.info(`[${ts()}] node-cron fired — opening daily polling window`);
    startPolling(async (date, startHour) => {
      await onJobComplete(date, startHour);
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
    stage1Complete   = false;
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
