type GLLineItemRow {
  SourceLedger                : String;
  CompanyCode                 : String;
  FiscalYear                  : String;
  AccountingDocument          : String;
  LedgerGLLineItem            : String;
  AmountInTransactionCurrency : String;
  LastChangeDateTime          : String;
}

type GLMismatchDetail {
  GLAccount : String;
  s4Count   : Integer;
  dsCount   : Integer;
}

type ReconciliationResult {
  status           : String;
  attempt          : Integer;
  failedStep       : Integer;
  s4Count          : Integer;
  dsCount          : Integer;
  step1Passed      : Boolean;
  step2Passed      : Boolean;
  step3Passed      : Boolean;
  glMismatches     : Integer;
  glMismatchDetail : array of GLMismatchDetail;
  missingInDS      : Integer;
  extraInDS        : Integer;
  valueMismatches  : Integer;
  durationMs       : Integer;
  error            : String;
}

service ReconciliationService {

  action testS4ConnectionGLLineItem()   returns String;
  action testS4ConnectionJournalEntry() returns String;
  action testDatasphereConnection()     returns String;

  // Verifies the PostgreSQL connection by running SELECT 1.
  // Returns 'PostgreSQL connection successful' on success, or the error message on failure.
  action testDatabaseConnection() returns String;

  // Verifies real table access by returning the first 5 rows from the Summit job table.
  action testDatabaseTable()      returns String;

  // Local axios test — queries A_JournalEntryItemBasic for FiscalYearPeriod 012.2025 via
  // the BAS Cloud Connector proxy at 127.0.0.1:8887. Returns the record count.
  action testS4Count()            returns Integer;

  action startScheduler() returns String;

  // Runs the 3-step reconciliation for a given date and hour window.
  // date: run date in YYYY-MM-DD format, e.g. '2026-03-31'
  // startHour: end of the data window (0-23), e.g. 4 means 00:00-04:00
  action runReconciliation(
    date      : String,
    startHour : Integer
  ) returns ReconciliationResult;

  // Debug: fetch raw S4 records for a custom date/time range.
  // startDate and endDate must be ISO 8601 format, e.g. '2026-03-31T00:00:00'
  action getS4DataForPeriod(
    startDate : String,
    endDate   : String
  ) returns array of GLLineItemRow;

  // Debug: fetch raw Datasphere records for a custom date/time range.
  // startDate and endDate must be 14-digit format, e.g. '20260331000000'
  action getDSDataForPeriod(
    startDate : String,
    endDate   : String
  ) returns array of GLLineItemRow;

  // Test action — calls getS4CountByDate via the SAP_S4_ODATA destination.
  // Returns the total S4 record count for the given date/hour window.
  action testS4CountByDate(
    date      : String,
    startHour : Integer
  ) returns Integer;

  // Test action — calls getS4GLCountByDate via the SAP_S4_ODATA destination.
  // Returns per-GL-account record counts for the given date/hour window.
  action testS4GLCountByDate(
    date      : String,
    startHour : Integer
  ) returns array of {
    GLAccount   : String;
    RecordCount : Integer;
  };

  // Test action — calls getS4DataByDate via the SAP_S4_ODATA destination.
  // Returns all 6 reconciliation fields for every record in the given date/hour window.
  action testS4DataByDate(
    date      : String,
    startHour : Integer
  ) returns array of GLLineItemRow;

  // Temporary test action — verifies getDSCountByDate returns the correct total count.
  // Remove once DS count behaviour is confirmed.
  action testDSCount(
    date      : String,
    startHour : Integer
  ) returns Integer;

  // Temporary test action — verifies getDSGLCountByDate returns correct per-GL account counts.
  // Remove once DS GL count behaviour is confirmed.
  action testDSGLCount(
    date      : String,
    startHour : Integer
  ) returns array of {
    GLAccount   : String;
    RecordCount : Integer;
  };

  // Bulk load test — fetches S4 and DS data for a high-volume date and reports record counts,
  // GL account count, and elapsed time so you can confirm 5k+ records work correctly.
  action testBulkLoad(
    date      : String,
    startHour : Integer
  ) returns {
    s4Records   : Integer;
    dsRecords   : Integer;
    glAccounts  : Integer;
    countsMatch : Boolean;
    elapsedMs   : Integer;
  };

  // Temporary test action — verifies getDSDataByDate fetches all records via per-GL-account
  // iteration. Returns the total record count and a per-account breakdown so you can confirm
  // the fix bypasses the 1000-record single-query cap.
  // Remove once DS full-data pagination is confirmed on a high-volume day.
  action testDSData(
    date      : String,
    startHour : Integer
  ) returns {
    totalRecords     : Integer;
    totalFromGLCounts: Integer;
    matched          : Boolean;
    glAccountCount   : Integer;
    breakdown        : array of {
      GLAccount   : String;
      RecordCount : Integer;
    };
  };

  // Executes any SQL query against the connected PostgreSQL database and returns results as JSON.
  // Use for inspecting table columns, checking status values, previewing rows, etc.
  // Example: SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'db_accountingdata'
  action executeQuery(sql : String) returns String;

  // Sends a test APIM notification directly without running reconciliation.
  // Use to verify the APIM destination, subscription key, and Control-M event endpoint.
  // status: 'SUCCESS', 'FAILED', or 'NO_SUMMIT'
  action testAPIM(status : String) returns String;

}
