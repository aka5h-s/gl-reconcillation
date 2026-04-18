// server.js
// CAP custom server entry point — loaded automatically before any services are served.
// This is the correct place to register startup hooks because it guarantees the
// cds.on('served') callback is registered before the event fires.
//
// Place this file at the root of the CAP project (same level as package.json).

const cds = require('@sap/cds');
const { initScheduler } = require('./srv/services/postgres-service');
const { runReconciliation } = require('./srv/services/compare-service');

const log = cds.log('server');

// Register the scheduler after all CAP services have been served.
// node-cron will open a polling window at POLL_START_HOUR (default 12:00) every day.
cds.on('served', () => {
  log.info('All services served — initialising daily GL reconciliation scheduler');

  initScheduler(async (date, startHour) => {
    log.info(`Scheduler triggered reconciliation: date=${date}, startHour=${startHour}`);
    await runReconciliation(date, startHour);
  });
});

// Export the standard CDS server so CAP's launch mechanism still works correctly.
module.exports = cds.server;
