'use strict';

// ---------------------------------------------------------------------------
// GL Reconciliation — High Volume Date Finder
//
// Scans a date range and reports S4 record count for each day.
// Sorted highest to lowest so you can spot the busiest days.
//
// Usage:
//   APP_URL=https://your-app.cfapps.eu10.hana.ondemand.com \
//   START_DATE=2026-01-01 \
//   END_DATE=2026-03-31 \
//   TEST_HOUR=24 \
//   node find-high-volume.js
// ---------------------------------------------------------------------------

const APP_URL    = (process.env.APP_URL    || '').replace(/\/$/, '');
const START_DATE = process.env.START_DATE  || '2026-01-01';
const END_DATE   = process.env.END_DATE    || '2026-03-31';
const TEST_HOUR  = parseInt(process.env.TEST_HOUR || '24', 10);
const TOKEN      = process.env.TOKEN       || '';
const SVC        = `${APP_URL}/odata/v4/reconciliation`;

if (!APP_URL) {
  console.error('ERROR: APP_URL is required.');
  process.exit(1);
}

async function getCount(date) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

  const res = await fetch(`${SVC}/testS4CountByDate`, {
    method:  'POST',
    headers,
    body:    JSON.stringify({ date, startHour: TEST_HOUR }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return typeof json.value === 'number' ? json.value : json;
}

function datesInRange(start, end) {
  const dates = [];
  const cur = new Date(start);
  const last = new Date(end);
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

(async () => {
  const dates = datesInRange(START_DATE, END_DATE);

  console.log(`GL Reconciliation — High Volume Date Finder`);
  console.log(`App        : ${APP_URL}`);
  console.log(`Date range : ${START_DATE} to ${END_DATE}  (${dates.length} days)`);
  console.log(`Hour       : ${TEST_HOUR}`);
  console.log(`\nScanning...\n`);

  const results = [];

  for (const date of dates) {
    try {
      const count = await getCount(date);
      results.push({ date, count });
      process.stdout.write(`  ${date}  ${String(count).padStart(7)} records\n`);
    } catch (err) {
      results.push({ date, count: -1 });
      process.stdout.write(`  ${date}  ERROR: ${err.message}\n`);
    }
  }

  const sorted = [...results]
    .filter(r => r.count > 0)
    .sort((a, b) => b.count - a.count);

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Top 10 highest-volume days:\n`);
  for (const r of sorted.slice(0, 10)) {
    console.log(`  ${r.date}  ${String(r.count).padStart(7)} records`);
  }
})();
