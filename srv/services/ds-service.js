// ds-service.js
// Handles all communication with SAP Datasphere via OData v4 using the CDS REST connector.
// The connection is configured in package.json under cds.requires.DATASPHERE and resolves
// to the BTP destination named DATASPHERE_TEST at runtime.

const cds = require('@sap/cds');

const log = cds.log('ds-service');

// Base path for the Datasphere view used in all queries
const DS_ENTITY = '/api/v1/dwc/consumption/relational/02_DATAWAREHOUSE/02_DWH_ACDOCA/_02_DWH_ACDOCA';

// Converts a date string and hour into the 14-digit format required by Datasphere filters.
// Example: formatDSDateTime('2026-03-30', 4) → '20260330040000'
// Example: formatDSDateTime('2026-03-30', 0) → '20260330000000'
function formatDSDateTime(date, hour = 0) {
  const datePart = date.replace(/-/g, '');
  const hourPart = String(hour).padStart(2, '0');
  return `${datePart}${hourPart}0000`;
}

// Extracts the $skiptoken value from an OData nextLink URL for pagination.
// Datasphere uses cursor-based pagination via $skiptoken instead of $skip/$top offset.
function extractSkiptoken(nextLink) {
  if (!nextLink) return null;
  try {
    const parsed = new URL(nextLink, 'https://datasphere.local');
    return parsed.searchParams.get('$skiptoken');
  } catch {
    // Fallback regex-based extraction if URL parsing fails
    const match = nextLink.match(/[?&]\$skiptoken=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
}

// Tests connectivity to Datasphere by fetching the catalog of spaces.
// Returns a plain string result suitable for returning directly from a CDS action.
async function testDatasphereConnection() {
  try {
    const ds = await cds.connect.to('DATASPHERE');
    await ds.get('/api/v1/dwc/catalog/spaces');
    log.info('Datasphere connectivity test passed');
    return 'DATASPHERE CONNECTION SUCCESS';
  } catch (err) {
    log.error('Datasphere connectivity test failed:', err.message);
    return `FAILED: ${err.message}`;
  }
}

// Returns the total record count for the given date window using OData $apply aggregate.
// The filter covers 00:00 to startHour:00 on the run date.
// Datasphere date filter uses 14-digit numbers, not ISO strings.
// FiscalYear is intentionally excluded — see comment in s4-service.js buildS4DateFilter.
// Used in reconciliation Step 1.
async function getDSCountByDate(date, startHour) {
  try {
    const ds = await cds.connect.to('DATASPHERE');
    const start = formatDSDateTime(date, 0);
    const end   = formatDSDateTime(date, startHour);

    const filter =
      `LastChangeDateTime ge ${start}` +
      ` and LastChangeDateTime lt ${end}`;

    // $apply=filter(...)/aggregate($count as TotalCount) returns a single row with the count
    const url = `${DS_ENTITY}?$apply=filter(${filter})/aggregate($count as TotalCount)`;

    const result = await ds.get(url);

    // Datasphere may return TotalCount as a string; parseInt ensures numeric comparison works
    const count = parseInt(result?.value?.[0]?.TotalCount ?? 0, 10);
    log.info(`DS count for ${date} (hour 00:00-${String(startHour).padStart(2, '0')}:00): ${count}`);
    return count;

  } catch (err) {
    log.error('DS getDSCountByDate failed:', err.message);
    throw new Error(`DS count failed: ${err.message}`);
  }
}

// Returns a count per GL account for the given date window using OData $apply groupby.
// Datasphere supports server-side groupby so no client-side aggregation is needed.
// Returns an array of { GLAccount, RecordCount }. Used in reconciliation Step 2.
async function getDSGLCountByDate(date, startHour) {
  try {
    const ds = await cds.connect.to('DATASPHERE');
    const start = formatDSDateTime(date, 0);
    const end   = formatDSDateTime(date, startHour);

    const filter =
      `LastChangeDateTime ge ${start}` +
      ` and LastChangeDateTime lt ${end}`;

    // Groups all matching records by GLAccount and counts records per account
    const url =
      `${DS_ENTITY}` +
      `?$apply=filter(${filter})/groupby((GLAccount),aggregate($count as RecordCount))`;

    const result = await ds.get(url);
    const data = result?.value || [];

    log.info(`DS GL accounts found: ${data.length}`);

    // RecordCount may come back as a string from Datasphere; normalize to integer
    return data.map(r => ({
      GLAccount: r.GLAccount,
      RecordCount: parseInt(r.RecordCount ?? 0, 10)
    }));

  } catch (err) {
    log.error('DS getDSGLCountByDate failed:', err.message);
    throw new Error(`DS GL count failed: ${err.message}`);
  }
}

// Fetches the 6 reconciliation fields for all records in the data window, iterating by GL account.
// WHY PER-ACCOUNT: Datasphere does not return @odata.nextLink for the ACDOCA entity, so a single
// large date-window query is silently capped at 1000 records. On days with 5000-6000 records that
// limit will be hit. By fetching one GL account at a time — using the account list already retrieved
// in Step 2 — each individual query stays well under 1000 records even on high-volume days.
// glAccounts: array of { GLAccount, RecordCount } from getDSGLCountByDate (Step 2).
// Fields fetched: SourceLedger, CompanyCode, FiscalYear, AccountingDocument, LedgerGLLineItem,
// AmountInTransactionCurrency.
async function getDSDataByDate(date, startHour, glAccounts) {
  try {
    const ds = await cds.connect.to('DATASPHERE');
    const start = formatDSDateTime(date, 0);
    const end   = formatDSDateTime(date, startHour);

    // Date-window portion of the filter — reused for every GL account query
    const dateFilter =
      `LastChangeDateTime ge ${start}` +
      ` and LastChangeDateTime lt ${end}`;

    const allRecords = [];

    for (const { GLAccount } of glAccounts) {
      // Combine the GL account equality check with the date window for this account
      const filter = `GLAccount eq '${GLAccount}' and ${dateFilter}`;
      let accountTotal = 0;
      let skip = 0;

      // Inner pagination loop using $skip/$top offset pagination.
      // Datasphere does not return @odata.nextLink ($skiptoken) even for per-account queries,
      // so we use standard OData offset pagination instead: fetch pages of PAGE_SIZE until
      // fewer than PAGE_SIZE records are returned, which signals the last page.
      const PAGE_SIZE = 999;

      while (true) {
        const url =
          `${DS_ENTITY}` +
          `?$select=SourceLedger,CompanyCode,FiscalYear,AccountingDocument,LedgerGLLineItem,AmountInTransactionCurrency` +
          `&$filter=${filter}` +
          `&$orderby=AccountingDocument,LedgerGLLineItem` +
          `&$top=${PAGE_SIZE}` +
          `&$skip=${skip}`;

        const result = await ds.get(url);
        const records = result?.value || [];

        allRecords.push(...records);
        accountTotal += records.length;
        skip += records.length;

        // Fewer records than requested means this is the last page
        if (records.length < PAGE_SIZE) break;
      }

      log.info(`DS account ${GLAccount}: ${accountTotal} records`);
    }

    log.info(`DS getDSDataByDate complete: ${allRecords.length} records across ${glAccounts.length} GL accounts`);
    return allRecords;

  } catch (err) {
    log.error('DS getDSDataByDate failed:', err.message);
    throw new Error(`DS data fetch failed: ${err.message}`);
  }
}

// Debug method — fetches all 6 fields plus LastChangeDateTime for a custom date/time range.
// start and end must be 14-digit Datasphere format, e.g. '20260331000000'.
// Not used in normal reconciliation — call via the getDSDataForPeriod action for ad hoc checks.
// WARNING: This function is capped at 1000 records per query because Datasphere does not return
// @odata.nextLink for the ACDOCA entity and this debug function has no GL account list to iterate
// with. For date ranges with more than 1000 records, split into smaller ranges (e.g. per day or
// per GL account) when exploring data. The reconciliation itself uses getDSDataByDate which avoids
// this limit by fetching per GL account.
async function getDSDataForPeriod(start, end) {
  try {
    const ds = await cds.connect.to('DATASPHERE');
    const allRecords = [];
    let skiptoken = null;

    while (true) {
      const baseUrl =
        `${DS_ENTITY}` +
        `?$select=SourceLedger,CompanyCode,FiscalYear,AccountingDocument,LedgerGLLineItem,AmountInTransactionCurrency,LastChangeDateTime` +
        `&$filter=LastChangeDateTime ge ${start} and LastChangeDateTime lt ${end}` +
        `&$top=1000`;

      const url = skiptoken
        ? `${baseUrl}&$skiptoken=${encodeURIComponent(skiptoken)}`
        : baseUrl;

      const result = await ds.get(url);
      const records = result?.value || [];

      allRecords.push(...records);
      log.info(`DS debug batch: ${records.length}, total: ${allRecords.length}`);

      skiptoken = extractSkiptoken(result?.['@odata.nextLink']);
      if (!skiptoken) break;
    }

    log.info(`DS getDSDataForPeriod complete: ${allRecords.length} records`);
    return allRecords;

  } catch (err) {
    log.error('DS getDSDataForPeriod failed:', err.message);
    throw new Error(`DS period fetch failed: ${err.message}`);
  }
}

module.exports = {
  testDatasphereConnection,
  getDSCountByDate,
  getDSGLCountByDate,
  getDSDataByDate,
  getDSDataForPeriod
};
