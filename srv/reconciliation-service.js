// reconciliation-service.js
// CAP service implementation for the ReconciliationService defined in reconciliation-service.cds.
// Wires all CDS actions to their corresponding service functions.
// The daily scheduler is initialised automatically when the CDS server is ready (cds.on('served')).

const cds = require('@sap/cds');

const {
  testS4ConnectionGLLineItem,
  testS4ConnectionJournalEntry,
  getS4Count,
  getS4CountByDate,
  getS4GLCountByDate,
  getS4DataByDate,
  getS4DataForPeriod
} = require('./services/s4-service');

const {
  testDatasphereConnection,
  getDSDataForPeriod,
  getDSCountByDate,
  getDSGLCountByDate,
  getDSDataByDate
} = require('./services/ds-service');

const { runReconciliation }            = require('./services/compare-service');
const { initScheduler, startPolling } = require('./services/postgres-service');

const log = cds.log('reconciliation-service');

module.exports = cds.service.impl(function () {

  // Tests connectivity to API_GLACCOUNTLINEITEM (the API used for all GL line item data)
  this.on('testS4ConnectionGLLineItem', async () => {
    return await testS4ConnectionGLLineItem();
  });

  // Tests connectivity to API_JOURNALENTRYITEMBASIC_SRV (connectivity check only)
  this.on('testS4ConnectionJournalEntry', async () => {
    return await testS4ConnectionJournalEntry();
  });

  // Tests connectivity to Datasphere
  this.on('testDatasphereConnection', async () => {
    return await testDatasphereConnection();
  });

  // Tests the PostgreSQL database connection by running SELECT 1.
  // Returns a success message or the error text so the connection can be verified via curl.
  this.on('testDatabaseConnection', async () => {
    try {
      const db = await cds.connect.to('db');
      await db.run('SELECT 1');
      return 'PostgreSQL connection successful';
    } catch (err) {
      return `PostgreSQL connection FAILED: ${err.message}`;
    }
  });

  // Verifies real table access — returns the first 5 rows from the Summit job table as JSON.
  this.on('testDatabaseTable', async () => {
    try {
      const db   = await cds.connect.to('db');
      const rows = await db.run(
        `SELECT appdate, processingstatus_id, modifiedat
           FROM summitaccountingdata.db_accountingdata
          LIMIT 5`
      );
      return JSON.stringify(rows);
    } catch (err) {
      return `testDatabaseTable FAILED: ${err.message}`;
    }
  });

  // Local axios test — queries S4 Journal Entry API for FiscalYearPeriod 012.2025
  // via the BAS Cloud Connector proxy. Returns the record count.
  this.on('testS4Count', async () => {
    return await getS4Count();
  });

  // Manually opens a polling window immediately (bypasses the daily 12:00 schedule).
  // Useful for testing or for manually triggering the scheduler out of the normal window.
  this.on('startScheduler', async () => {
    startPolling(async (date, startHour) => {
      log.info(`Manual scheduler triggered reconciliation: date=${date}, startHour=${startHour}`);
      await runReconciliation(date, startHour);
    });
    return 'Polling window opened — checking PostgreSQL for Summit job every 5 minutes';
  });

  // Manually triggers a reconciliation run for a specific date and hour.
  // Useful for testing or rerunning a missed reconciliation.
  // Parameters: date (YYYY-MM-DD), startHour (0-23)
  this.on('runReconciliation', async (req) => {
    const { date, startHour } = req.data;
    return await runReconciliation(date, startHour);
  });

  // Debug action: fetches raw S4 data for a custom date/time range.
  // startDate and endDate must be ISO 8601 format, e.g. '2026-03-31T00:00:00'.
  this.on('getS4DataForPeriod', async (req) => {
    const { startDate, endDate } = req.data;
    return await getS4DataForPeriod(startDate, endDate);
  });

  // Test action — returns the total S4 record count for a date/hour window via the destination.
  this.on('testS4CountByDate', async (req) => {
    const { date, startHour } = req.data;
    return await getS4CountByDate(date, startHour);
  });

  // Test action — returns the per-GL account record counts from S4 for a date/hour window.
  this.on('testS4GLCountByDate', async (req) => {
    const { date, startHour } = req.data;
    return await getS4GLCountByDate(date, startHour);
  });

  // Test action — returns the total DS record count for a date/hour window.
  this.on('testDSCount', async (req) => {
    const { date, startHour } = req.data;
    return await getDSCountByDate(date, startHour);
  });

  // Test action — returns the per-GL account record counts from DS for a date/hour window.
  this.on('testDSGLCount', async (req) => {
    const { date, startHour } = req.data;
    return await getDSGLCountByDate(date, startHour);
  });

  // Test action — returns all 6 reconciliation fields for every S4 record in the date/hour window.
  this.on('testS4DataByDate', async (req) => {
    const { date, startHour } = req.data;
    return await getS4DataByDate(date, startHour);
  });

  // Temporary test action — verifies the per-GL-account pagination fix in getDSDataByDate.
  // Fetches the GL account list then calls getDSDataByDate with it, exactly as Step 3 does.
  // Returns total record count, number of GL accounts, and a per-account breakdown.
  // Compare totalRecords against testDSCount for the same date/startHour — they must match.
  // Remove once high-volume DS pagination is confirmed.
  this.on('testDSData', async (req) => {
    const { date, startHour } = req.data;

    // Step A: get the GL account list (same as Step 2 in reconciliation)
    const glAccounts = await getDSGLCountByDate(date, startHour);

    // Step B: fetch all records via per-GL-account iteration (same as Step 3)
    const allRecords = await getDSDataByDate(date, startHour, glAccounts);

    // Step C: the glAccounts list from Step A already carries the correct per-account counts.
    // The totalRecords from Step B must match their sum.
    const sumFromGLCounts = glAccounts.reduce((sum, a) => sum + a.RecordCount, 0);

    return {
      totalRecords:      allRecords.length,
      totalFromGLCounts: sumFromGLCounts,
      matched:           allRecords.length === sumFromGLCounts,
      glAccountCount:    glAccounts.length,
      breakdown:         glAccounts
    };
  });

  // Bulk load test action — fetches full S4 and DS data for a date/hour window without
  // running the comparison. Use to verify pagination at scale before a full reconciliation run.
  this.on('testBulkLoad', async (req) => {
    const { date, startHour } = req.data;
    const t0 = Date.now();

    const glAccounts = await getDSGLCountByDate(date, startHour);
    const [s4Data, dsData] = await Promise.all([
      getS4DataByDate(date, startHour),
      getDSDataByDate(date, startHour, glAccounts)
    ]);

    return {
      s4Records:    s4Data.length,
      dsRecords:    dsData.length,
      glAccounts:   glAccounts.length,
      countsMatch:  s4Data.length === dsData.length,
      elapsedMs:    Date.now() - t0
    };
  });

  // Debug action: fetches raw Datasphere data for a custom date/time range.
  // startDate and endDate must be 14-digit Datasphere format, e.g. '20260331000000'.
  this.on('getDSDataForPeriod', async (req) => {
    const { startDate, endDate } = req.data;
    return await getDSDataForPeriod(startDate, endDate);
  });

  // Executes any SQL query against the connected PostgreSQL database.
  // Returns results as a JSON string, or an error message if the query fails.
  // Useful for inspecting the Summit job table when pgAdmin is unavailable.
  // Note: use standard PostgreSQL SQL (SELECT, information_schema queries, etc.)
  //       not psql meta-commands (e.g. \d, \dt) — those are client-only shortcuts.
  this.on('executeQuery', async (req) => {
    const { sql } = req.data;
    if (!sql || !sql.trim()) return 'ERROR: No SQL provided';
    try {
      const db     = await cds.connect.to('db');
      const result = await db.run(sql);
      // Normalise to a consistent envelope so output shape is always predictable:
      //   array results  → { rows: [...], count: N }
      //   non-array      → { result: <value> }
      const payload = Array.isArray(result)
        ? { rows: result, count: result.length }
        : { result: result ?? null };
      return JSON.stringify(payload, null, 2);
    } catch (err) {
      return `ERROR: ${err.message}`;
    }
  });

});

// Scheduler initialisation is handled in server.js at the project root,
// which CAP loads before serving any services — ensuring correct timing.
