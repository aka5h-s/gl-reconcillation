// TEMPORARY — delete srv/scheduler-test.cds and srv/scheduler-test.js after demo.
using { ReconciliationResult } from './reconciliation-service';

service SchedulerTestService {

  // Runs one of 4 test scenarios to demonstrate the reconciliation scheduler end-to-end.
  //
  // scenario 1 — real reconciliation for a known-good date (matches on first attempt)
  // scenario 2 — forced failures on attempts 1-2, real reconciliation on attempt 3
  // scenario 3 — forced failures on all 3 attempts (FAILED sent to APIM)
  // scenario 4 — real reconciliation for a date with no data (NO_DATA result)
  //
  // retryWaitSeconds — seconds to wait between retries in scenarios 2 and 3.
  //                    Use a small value (e.g. 5) so the demo completes quickly.
  action runSchedulerTest(
    scenario         : Integer,
    retryWaitSeconds : Integer
  ) returns ReconciliationResult;

}
