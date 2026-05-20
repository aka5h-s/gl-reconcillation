// // apim-service.js
// // Sends reconciliation outcome notifications to the Control-M Automation API via APIM.
// // Uses @sap-cloud-sdk/http-client with the APIM_CONTROL_M BTP destination —
// // this routes through the Cloud Connector (ProxyType=OnPremise) automatically,
// // exactly as SAP_S4_ODATA does for S4 calls.
// //
// // Authentication: Ocp-Apim-Subscription-Key header, read from APIM_SUBSCRIPTION_KEY env var.
// // If the key is missing at runtime, the POST is skipped and a warning is logged.
// // A failed POST is logged but never thrown — APIM failure must not affect the reconciliation result.

// const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
// const cds = require('@sap/cds');

// const log = cds.log('apim-service');

// // BTP destination name — must be created in BTP cockpit with ProxyType=OnPremise
// // and URL = https://api.apim.dev.ebrd.com
// const APIM_DESTINATION = 'APIM_CONTROL_M';

// // Control-M event path (relative to the destination base URL)
// const APIM_PATH = '/control-m/run/event/dev';

// // Event names agreed with the Control-M team
// const EVENT_SUCCESS = 'AIS-SUM-DATASPHERE_PROCESS_FINISHED_SUCCESS';
// const EVENT_FAILED  = 'AIS-SUM-DATASPHERE_PROCESS_FINISHED_FAILUR';

// // Sends a POST to the Control-M event endpoint with the appropriate event name.
// //
// // status values:
// //   'SUCCESS' — S4 and Datasphere counts match across all 3 reconciliation steps
// //   'FAILED'  — counts do not match after all retry attempts
// //
// // details: ReconciliationResult object from compare-service.js (logged for traceability, not sent to APIM)
// // Returns an outcome object so callers like testAPIM can report exactly what happened:
// //   { outcome: 'sent',    event, httpStatus }  — POST succeeded
// //   { outcome: 'skipped', event, reason }      — subscription key missing
// //   { outcome: 'failed',  event, httpStatus, body } — POST returned an error
// async function notifyAPIM(status, details) {
//   const eventName = status === 'SUCCESS' ? EVENT_SUCCESS : EVENT_FAILED;

//   log.info(`APIM notification: status=${status}, event=${eventName}`, details);

//   // Read key at call time so runtime changes (e.g. injected after startup) are picked up
//   const subscriptionKey = process.env.APIM_SUBSCRIPTION_KEY;

//   if (!subscriptionKey) {
//     log.warn('APIM_SUBSCRIPTION_KEY is not set — skipping APIM notification');
//     return { outcome: 'skipped', event: eventName, reason: 'APIM_SUBSCRIPTION_KEY is not set' };
//   }

//   try {
//     const response = await executeHttpRequest(
//       { destinationName: APIM_DESTINATION },
//       {
//         method:  'POST',
//         url:     APIM_PATH,
//         data:    { name: eventName },
//         headers: {
//           'Content-Type':              'application/json',
//           'Ocp-Apim-Subscription-Key': subscriptionKey
//         }
//       }
//     );

//     log.info(`APIM notification sent: event=${eventName}, status=${response.status}`);
//     return { outcome: 'sent', event: eventName, httpStatus: response.status };

//   } catch (err) {
//     const httpStatus = err.response ? err.response.status : 'no response';
//     const body       = err.response ? JSON.stringify(err.response.data) : err.message;
//     log.error(`APIM notification error: event=${eventName}, status=${httpStatus}, body=${body}`);
//     return { outcome: 'failed', event: eventName, httpStatus, body };
//   }
// }

// module.exports = {
//   notifyAPIM
// };



// apim-service.js
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const cds = require('@sap/cds');

const log = cds.log('apim-service');

const APIM_DESTINATION = 'APIM_CONTROL_M';
const APIM_PATH        = '/control-m/run/event/DEV';

const EVENT_SUCCESS = 'AIS-SUM-DATASPHERE_PROCESS_FINISHED_SUCCESS';
const EVENT_FAILED  = 'AIS-SUM-DATASPHERE_PROCESS_FINISHED_FAILUR';

async function notifyAPIM(status, details) {
  const eventName = status === 'SUCCESS' ? EVENT_SUCCESS : EVENT_FAILED;

  log.info(`APIM notification: status=${status}, event=${eventName}`, details);

  const subscriptionKey = process.env.APIM_SUBSCRIPTION_KEY;

  if (!subscriptionKey) {
    log.warn('APIM_SUBSCRIPTION_KEY is not set — skipping APIM notification');
    return { outcome: 'skipped', event: eventName, reason: 'APIM_SUBSCRIPTION_KEY is not set' };
  }

  try {
    const response = await executeHttpRequest(
      { destinationName: APIM_DESTINATION },
      {
        method:  'POST',
        url:     APIM_PATH,
        data:    { name: eventName },
        headers: {
          'Content-Type':              'application/json',
          'Ocp-Apim-Subscription-Key': subscriptionKey
        }
      },
      { fetchCsrfToken: false }
    );

    log.info(`APIM notification sent: event=${eventName}, status=${response.status}`);
    return { outcome: 'sent', event: eventName, httpStatus: response.status };

  } catch (err) {
    const httpStatus = err.response ? err.response.status : 'no response';
    const body       = err.response ? JSON.stringify(err.response.data) : err.message;
    log.error(`APIM notification error: event=${eventName}, status=${httpStatus}, body=${body}`);
    return { outcome: 'failed', event: eventName, httpStatus, body };
  }
}

module.exports = { notifyAPIM };