// s4-service.js
// Handles all communication with SAP S/4HANA via OData v2 (API_GLACCOUNTLINEITEM and API_JOURNALENTRYITEMBASIC_SRV).
// All production calls use executeHttpRequest from @sap-cloud-sdk/http-client with the SAP_S4_ODATA
// BTP destination — this handles Proxy-Authorization and Cloud Connector routing automatically.
// getS4Count is kept as a raw axios call for local testing via the BAS Cloud Connector proxy.

const axios = require('axios');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const cds = require('@sap/cds');

const log = cds.log('s4-service');

const S4_DESTINATION  = 'SAP_S4_ODATA';
const S4_CLIENT = '110';

const S4_HEADERS = { Accept: 'application/json' };
const S4_TIMEOUT = 30000; // 30 seconds

// OData v2 entity paths — relative to the destination host
const GL_LINE_ITEM_PATH  = '/sap/opu/odata/sap/API_GLACCOUNTLINEITEM/GLAccountLineItem';
const JOURNAL_ENTRY_PATH = '/sap/opu/odata/sap/API_JOURNALENTRYITEMBASIC_SRV/A_JournalEntryItemBasic';

// Builds the OData $filter string for a given date and run hour.
// The data window always starts at 00:00 of the run date and ends at startHour:00.
// Example: date='2026-03-30', startHour=4 → filter covers 00:00 to 04:00 on March 30.
function buildS4DateFilter(date, startHour) {
  const startStr = `${date}T00:00:00`;
  const endStr   = `${date}T${String(startHour).padStart(2, '0')}:00:00`;
  return (
    `LastChangeDateTime ge datetimeoffset'${startStr}'` +
    ` and LastChangeDateTime lt datetimeoffset'${endStr}'`
  );
}

// Tests connectivity to API_GLACCOUNTLINEITEM using the SAP_S4_ODATA destination.
async function testS4ConnectionGLLineItem() {
  try {
    await executeHttpRequest(
      { destinationName: S4_DESTINATION },
      {
        method: 'get',
        url: `${GL_LINE_ITEM_PATH}?sap-client=${S4_CLIENT}&$top=1&$format=json`,
        headers: S4_HEADERS,
        timeout: S4_TIMEOUT
      }
    );

    log.info('S4 API_GLACCOUNTLINEITEM connectivity test passed');
    return 'S4 GL LINE ITEM CONNECTION SUCCESS';

  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    log.error('S4 GL LINE ITEM connection failed:', detail);
    return `FAILED: ${detail}`;
  }
}

// Tests connectivity to API_JOURNALENTRYITEMBASIC_SRV using the SAP_S4_ODATA destination.
async function testS4ConnectionJournalEntry() {
  try {
    await executeHttpRequest(
      { destinationName: S4_DESTINATION },
      {
        method: 'get',
        url: `${JOURNAL_ENTRY_PATH}?sap-client=${S4_CLIENT}&$top=1&$format=json`,
        headers: S4_HEADERS,
        timeout: S4_TIMEOUT
      }
    );

    log.info('S4 API_JOURNALENTRYITEMBASIC_SRV connectivity test passed');
    return 'S4 JOURNAL ENTRY CONNECTION SUCCESS';

  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    log.error('S4 JOURNAL ENTRY connection failed:', detail);
    return `FAILED: ${detail}`;
  }
}

// Raw axios test method — kept for local BAS testing via the Cloud Connector proxy at 127.0.0.1:8887.
// Filters by FiscalYearPeriod on A_JournalEntryItemBasic and returns the record count.
async function getS4Count() {
  try {
    const TARGET_PERIOD = '012.2025';

    const url = `http://ds4.pce.ebrd.com:44380/sap/opu/odata/sap/API_JOURNALENTRYITEMBASIC_SRV/A_JournalEntryItemBasic?sap-client=110&$filter=FiscalYearPeriod eq '${TARGET_PERIOD}'&$top=5000&$format=json`;

    const response = await axios.get(url, {
      proxy: {
        protocol: 'http',
        host: '127.0.0.1',
        port: 8887
      },
      auth: {
        username: 'FI_JE_ACD',
        password: 'FI_JE_ACD@Logon26!'
      },
      headers: { Accept: 'application/json' },
      timeout: 20000
    });

    const results = response.data?.d?.results || [];

    console.log(`✅ S4 COUNT (${TARGET_PERIOD}):`, results.length);

    return results.length;

  } catch (err) {
    const detail = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;

    console.error('❌ S4 ERROR:', detail);
    return 0;
  }
}

// Returns the total record count for the given date window using $top=0 and $inlinecount=allpages.
// Used in reconciliation Step 1.
async function getS4CountByDate(date, startHour) {
  try {
    const filter = buildS4DateFilter(date, startHour);

    const response = await executeHttpRequest(
      { destinationName: S4_DESTINATION },
      {
        method: 'get',
        url: `${GL_LINE_ITEM_PATH}?sap-client=${S4_CLIENT}&$filter=${filter}&$top=0&$inlinecount=allpages&$format=json`,
        headers: S4_HEADERS,
        timeout: S4_TIMEOUT
      }
    );

    const count = parseInt(response.data?.d?.__count || '0', 10);
    log.info(`S4 count for ${date} (hour 00:00-${String(startHour).padStart(2, '0')}:00): ${count}`);
    return count;

  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    log.error('S4 getS4CountByDate failed:', detail);
    throw new Error(`S4 count failed: ${detail}`);
  }
}

// Fetches only the GLAccount field for all records in the window, then groups by GL account in JS
// to produce a count per GL account. Used in reconciliation Step 2.
async function getS4GLCountByDate(date, startHour) {
  try {
    const filter = buildS4DateFilter(date, startHour);
    const top  = 1000;
    let   skip = 0;
    const glMap = {};

    while (true) {
      const response = await executeHttpRequest(
        { destinationName: S4_DESTINATION },
        {
          method: 'get',
          url: `${GL_LINE_ITEM_PATH}?sap-client=${S4_CLIENT}&$select=GLAccount,AccountingDocument,LedgerGLLineItem&$filter=${filter}&$skip=${skip}&$top=${top}&$format=json`,
          headers: S4_HEADERS,
          timeout: S4_TIMEOUT
        }
      );

      const records = response.data?.d?.results || [];

      for (const r of records) {
        if (r.GLAccount) {
          glMap[r.GLAccount] = (glMap[r.GLAccount] || 0) + 1;
        }
      }

      log.info(`S4 GL count batch: ${records.length}, skip: ${skip}`);

      if (records.length < top) break;
      skip += top;
    }

    const result = Object.entries(glMap).map(([GLAccount, RecordCount]) => ({
      GLAccount,
      RecordCount
    }));

    log.info(`S4 GL accounts found: ${result.length}`);
    return result;

  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    log.error('S4 getS4GLCountByDate failed:', detail);
    throw new Error(`S4 GL count failed: ${detail}`);
  }
}

// Fetches the 6 reconciliation fields for all records in the data window using $skip pagination.
// Used in reconciliation Step 3.
async function getS4DataByDate(date, startHour) {
  try {
    const filter = buildS4DateFilter(date, startHour);
    const top  = 1000;
    let   skip = 0;
    const allRecords = [];

    while (true) {
      const response = await executeHttpRequest(
        { destinationName: S4_DESTINATION },
        {
          method: 'get',
          url: `${GL_LINE_ITEM_PATH}?sap-client=${S4_CLIENT}&$select=SourceLedger,CompanyCode,FiscalYear,AccountingDocument,LedgerGLLineItem,AmountInTransactionCurrency&$filter=${filter}&$skip=${skip}&$top=${top}&$format=json`,
          headers: S4_HEADERS,
          timeout: S4_TIMEOUT
        }
      );

      const records = response.data?.d?.results || [];
      allRecords.push(...records);
      log.info(`S4 data batch: ${records.length}, total: ${allRecords.length}`);

      if (records.length < top) break;
      skip += top;
    }

    log.info(`S4 getS4DataByDate complete: ${allRecords.length} records`);
    return allRecords;

  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    log.error('S4 getS4DataByDate failed:', detail);
    throw new Error(`S4 data fetch failed: ${detail}`);
  }
}

// Debug method — fetches all 6 fields plus LastChangeDateTime for a custom date/time range.
// start and end must be ISO 8601 datetime strings, e.g. '2026-03-31T00:00:00'.
// Not used in normal reconciliation — call via the getS4DataForPeriod action for ad hoc checks.
async function getS4DataForPeriod(start, end) {
  try {
    const top  = 1000;
    let   skip = 0;
    const allRecords = [];

    while (true) {
      const filter =
        `LastChangeDateTime ge datetimeoffset'${start}' and LastChangeDateTime lt datetimeoffset'${end}'`;

      const response = await executeHttpRequest(
        { destinationName: S4_DESTINATION },
        {
          method: 'get',
          url: `${GL_LINE_ITEM_PATH}?sap-client=${S4_CLIENT}&$select=SourceLedger,CompanyCode,FiscalYear,AccountingDocument,LedgerGLLineItem,AmountInTransactionCurrency,LastChangeDateTime&$filter=${filter}&$skip=${skip}&$top=${top}&$format=json`,
          headers: S4_HEADERS,
          timeout: S4_TIMEOUT
        }
      );

      const records = response.data?.d?.results || [];
      allRecords.push(...records);
      log.info(`S4 debug batch: ${records.length}, total: ${allRecords.length}`);

      if (records.length < top) break;
      skip += top;
    }

    log.info(`S4 getS4DataForPeriod complete: ${allRecords.length} records`);
    return allRecords;

  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    log.error('S4 getS4DataForPeriod failed:', detail);
    throw new Error(`S4 period fetch failed: ${detail}`);
  }
}

module.exports = {
  testS4ConnectionGLLineItem,
  testS4ConnectionJournalEntry,
  getS4Count,
  getS4CountByDate,
  getS4GLCountByDate,
  getS4DataByDate,
  getS4DataForPeriod
};
