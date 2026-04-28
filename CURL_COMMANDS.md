# GL Reconciliation — curl Command Reference

All actions are OData v4 POST requests.
Use `jq` to format the output. If `jq` is not installed, remove the `| jq` part.

---

## Base URLs

| Environment | URL |
|---|---|
| Localhost | `http://localhost:4004/odata/v4/reconciliation` |
| Deployed  | `https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation` |

---

## 1. Test S4 GL Line Item Connection

Tests connectivity to the S/4HANA GL Line Item OData entity via the SAP_S4_ODATA destination.

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/testS4ConnectionGLLineItem" \
  -H "Content-Type: application/json" -d '{}' | jq '.value'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/testS4ConnectionGLLineItem" \
  -H "Content-Type: application/json" -d '{}' | jq '.value'
```

---

## 2. Test S4 Journal Entry Connection

Tests connectivity to the S/4HANA Journal Entry OData entity via the SAP_S4_ODATA destination.

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/testS4ConnectionJournalEntry" \
  -H "Content-Type: application/json" -d '{}' | jq '.value'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/testS4ConnectionJournalEntry" \
  -H "Content-Type: application/json" -d '{}' | jq '.value'
```

---

## 3. Test Datasphere Connection

Tests connectivity to the SAP Datasphere ACDOCA entity via the SAP_DS_ODATA destination.

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/testDatasphereConnection" \
  -H "Content-Type: application/json" -d '{}' | jq '.value'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/testDatasphereConnection" \
  -H "Content-Type: application/json" -d '{}' | jq '.value'
```

---

## 4. Test Database Connection

Verifies the PostgreSQL connection by running SELECT 1. Returns success or the error message.

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/testDatabaseConnection" \
  -H "Content-Type: application/json" -d '{}' | jq '.value'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/testDatabaseConnection" \
  -H "Content-Type: application/json" -d '{}' | jq '.value'
```

---

## 5. Test Database Table

Returns the first 5 rows from the Summit status table to confirm real table access.

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/testDatabaseTable" \
  -H "Content-Type: application/json" -d '{}' | jq '.value'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/testDatabaseTable" \
  -H "Content-Type: application/json" -d '{}' | jq '.value'
```

---

## 6. Test S4 Count

Returns the total S/4HANA record count for a fixed period (FiscalYearPeriod 012.2025) via the BAS Cloud Connector proxy.

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/testS4Count" \
  -H "Content-Type: application/json" -d '{}' | jq '.value'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/testS4Count" \
  -H "Content-Type: application/json" -d '{}' | jq '.value'
```

---

## 7. Start Scheduler

Starts the daily scheduler that polls PostgreSQL at 12:00 UTC and triggers reconciliation when Summit flags are set.

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/startScheduler" \
  -H "Content-Type: application/json" -d '{}' | jq '.value'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/startScheduler" \
  -H "Content-Type: application/json" -d '{}' | jq '.value'
```

---

## 8. Run Reconciliation

Runs the full 3-step reconciliation (total count, GL account count, full row comparison) for a given date.
`date`: YYYY-MM-DD format. `startHour`: end of the data window (use 24 for full day).

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/runReconciliation" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-04-20", "startHour": 24}' | jq '.value'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/runReconciliation" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-04-20", "startHour": 24}' | jq '.value'
```

---

## 9. Get S4 Raw Data for Period

Fetches raw S/4HANA GL records for a custom date/time range. Returns all 6 reconciliation fields.
`startDate` and `endDate` must be ISO 8601 format: `YYYY-MM-DDTHH:MM:SS`.

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/getS4DataForPeriod" \
  -H "Content-Type: application/json" \
  -d '{"startDate": "2026-04-20T00:00:00", "endDate": "2026-04-20T23:59:59"}' | jq '.value | length'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/getS4DataForPeriod" \
  -H "Content-Type: application/json" \
  -d '{"startDate": "2026-04-20T00:00:00", "endDate": "2026-04-20T23:59:59"}' | jq '.value | length'
```

---

## 10. Get Datasphere Raw Data for Period

Fetches raw Datasphere ACDOCA records for a custom date/time range. Returns all 6 reconciliation fields.
`startDate` and `endDate` must be 14-digit format: `YYYYMMDDHHMMSS`.

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/getDSDataForPeriod" \
  -H "Content-Type: application/json" \
  -d '{"startDate": "20260420000000", "endDate": "20260420235959"}' | jq '.value | length'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/getDSDataForPeriod" \
  -H "Content-Type: application/json" \
  -d '{"startDate": "20260420000000", "endDate": "20260420235959"}' | jq '.value | length'
```

---

## 11. Test S4 Count by Date

Returns the total S/4HANA record count for a given date and hour window.

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/testS4CountByDate" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-04-20", "startHour": 24}' | jq '.value'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/testS4CountByDate" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-04-20", "startHour": 24}' | jq '.value'
```

---

## 12. Test S4 GL Count by Date

Returns per-GL-account record counts from S/4HANA for a given date and hour window.

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/testS4GLCountByDate" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-04-20", "startHour": 24}' | jq '.value'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/testS4GLCountByDate" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-04-20", "startHour": 24}' | jq '.value'
```

---

## 13. Test S4 Full Data by Date

Returns all 6 reconciliation fields for every S/4HANA record in the given date/hour window. Use `length` to count.

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/testS4DataByDate" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-04-20", "startHour": 24}' | jq '.value | length'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/testS4DataByDate" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-04-20", "startHour": 24}' | jq '.value | length'
```

---

## 14. Test Datasphere Count by Date

Returns the total Datasphere record count for a given date and hour window.

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/testDSCount" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-04-20", "startHour": 24}' | jq '.value'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/testDSCount" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-04-20", "startHour": 24}' | jq '.value'
```

---

## 15. Test Datasphere GL Count by Date

Returns per-GL-account record counts from Datasphere for a given date and hour window.

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/testDSGLCount" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-04-20", "startHour": 24}' | jq '.value'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/testDSGLCount" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-04-20", "startHour": 24}' | jq '.value'
```

---

## 16. Test Bulk Load

Fetches S4 and Datasphere data together and reports record counts, GL account count, match status, and elapsed time.

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/testBulkLoad" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-04-20", "startHour": 24}' | jq '.value'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/testBulkLoad" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-04-20", "startHour": 24}' | jq '.value'
```

---

## 17. Test Datasphere Full Data by Date

Fetches all Datasphere records per GL account and returns total count, per-account breakdown, and match status.

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/testDSData" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-04-20", "startHour": 24}' | jq '.value'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/testDSData" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-04-20", "startHour": 24}' | jq '.value'
```

---

## 18. Execute PostgreSQL Query

Runs any SQL query against the connected PostgreSQL database and returns results as JSON.

**Localhost**
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/executeQuery" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT 1 AS ping"}' \
  | jq '.value | fromjson | .rows'
```

**Deployed**
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/executeQuery" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT 1 AS ping"}' \
  | jq '.value | fromjson | .rows'
```

---

## DB Verification Queries (via executeQuery)

**Check all columns in the status table**

Localhost
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/executeQuery" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '"'"'db_accountingdataprocessstatus'"'"' ORDER BY ordinal_position"}' \
  | jq '.value | fromjson | .rows[] | "\(.column_name)  (\(.data_type))"'
```

Deployed
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/executeQuery" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '"'"'db_accountingdataprocessstatus'"'"' ORDER BY ordinal_position"}' \
  | jq '.value | fromjson | .rows[] | "\(.column_name)  (\(.data_type))"'
```

---

**Count total, completed and incomplete rows**

Localhost
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/executeQuery" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT COUNT(*) AS total, COUNT(CASE WHEN summitdataprocessedsuccessfully = '"'"'X'"'"' AND frameworksdataprocessedsuccessfully = '"'"'X'"'"' THEN 1 END) AS completed, COUNT(CASE WHEN summitdataprocessedsuccessfully IS NULL THEN 1 END) AS incomplete FROM summitaccountingdata.db_accountingdataprocessstatus"}' \
  | jq '.value | fromjson | .rows'
```

Deployed
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/executeQuery" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT COUNT(*) AS total, COUNT(CASE WHEN summitdataprocessedsuccessfully = '"'"'X'"'"' AND frameworksdataprocessedsuccessfully = '"'"'X'"'"' THEN 1 END) AS completed, COUNT(CASE WHEN summitdataprocessedsuccessfully IS NULL THEN 1 END) AS incomplete FROM summitaccountingdata.db_accountingdataprocessstatus"}' \
  | jq '.value | fromjson | .rows'
```

---

**See the most recent 10 rows**

Localhost
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/executeQuery" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT * FROM summitaccountingdata.db_accountingdataprocessstatus ORDER BY processingdate DESC LIMIT 10"}' \
  | jq '.value | fromjson | .rows'
```

Deployed
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/executeQuery" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT * FROM summitaccountingdata.db_accountingdataprocessstatus ORDER BY processingdate DESC LIMIT 10"}' \
  | jq '.value | fromjson | .rows'
```

---

**Check today's row**

Localhost
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/executeQuery" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT * FROM summitaccountingdata.db_accountingdataprocessstatus WHERE processingdate::date = CURRENT_DATE"}' \
  | jq '.value | fromjson | .rows'
```

Deployed
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/executeQuery" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT * FROM summitaccountingdata.db_accountingdataprocessstatus WHERE processingdate::date = CURRENT_DATE"}' \
  | jq '.value | fromjson | .rows'
```

---

**See all rows with null flags (incomplete dates)**

Localhost
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/executeQuery" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT processingdate::date AS date, summitdataprocessedsuccessfully AS summit, frameworksdataprocessedsuccessfully AS framework FROM summitaccountingdata.db_accountingdataprocessstatus WHERE summitdataprocessedsuccessfully IS NULL OR frameworksdataprocessedsuccessfully IS NULL ORDER BY processingdate DESC"}' \
  | jq '.value | fromjson | .rows'
```

Deployed
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/executeQuery" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT processingdate::date AS date, summitdataprocessedsuccessfully AS summit, frameworksdataprocessedsuccessfully AS framework FROM summitaccountingdata.db_accountingdataprocessstatus WHERE summitdataprocessedsuccessfully IS NULL OR frameworksdataprocessedsuccessfully IS NULL ORDER BY processingdate DESC"}' \
  | jq '.value | fromjson | .rows'
```

---

**Confirm schema and table ownership**

Localhost
```bash
curl -s -X POST "http://localhost:4004/odata/v4/reconciliation/executeQuery" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = '"'"'db_accountingdataprocessstatus'"'"'"}' \
  | jq '.value | fromjson | .rows'
```

Deployed
```bash
curl -s -X POST "https://ebrd-bas-dev-cf-ebrd-bas-dev-space-gl-reconciliation-srv.cfapps.eu10-004.hana.ondemand.com/odata/v4/reconciliation/executeQuery" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = '"'"'db_accountingdataprocessstatus'"'"'"}' \
  | jq '.value | fromjson | .rows'
```
