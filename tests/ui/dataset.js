/* Deterministic status data for the UI tests.
 *
 * This is the single source of truth: the test server (serve.js) hands it to
 * the page exactly as the collector would publish data/summary.json and
 * data/history/<id>.json, and the spec (summary.spec.js) asserts the page
 * reflects these same values. Change a value here and the test checks that the
 * UI follows.
 *
 * Day buckets and history timestamps are anchored to "today" (UTC) because
 * app.js aligns the daily bar to calendar days ending today; static past dates
 * would render as "no data" cells and make the bar assertions meaningless.
 */

"use strict";

const DAY_MS = 86400000;

function utcDayKey(offsetDays) {
  const d = new Date(Date.now() - offsetDays * DAY_MS);
  return d.toISOString().slice(0, 10);
}

function isoAtToday(hour, minute) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0));
  return d.toISOString();
}

function buildDataset() {
  const summary = {
    name: "UI-test status",
    description: "Fixture data used by the UI tests.",
    generated_at: isoAtToday(12, 0),
    overall_status: "partial_outage",
    overall_text: "Partial outage — database is down",
    display: { min_days: 30, max_days: 90 },
    checks: [
      {
        id: "api-gateway",
        name: "API Gateway",
        group: "Web applications",
        type: "http",
        url: "https://gateway.example.test/",
        status: "up",
        latency_ms: 123,
        detail: "HTTP 200",
        checked_at: isoAtToday(12, 0),
        uptime_24h: 100.0,
        uptime_90d: 99.95,
        days: [
          { date: utcDayKey(2), status: "up", uptime: 100.0 },
          { date: utcDayKey(1), status: "up", uptime: 100.0 },
          { date: utcDayKey(0), status: "up", uptime: 100.0 },
        ],
      },
      {
        id: "dashboard",
        name: "Dashboard",
        group: "Web applications",
        type: "http",
        url: "https://dashboard.example.test/",
        status: "degraded",
        latency_ms: 1500,
        detail: "Slow response",
        checked_at: isoAtToday(12, 0),
        uptime_24h: 95.0,
        uptime_90d: 98.10,
        days: [
          { date: utcDayKey(2), status: "up", uptime: 100.0 },
          { date: utcDayKey(1), status: "degraded", uptime: 90.0 },
          { date: utcDayKey(0), status: "degraded", uptime: 95.0 },
        ],
      },
      {
        id: "database",
        name: "Primary Database",
        group: "Web applications",
        type: "tcp",
        host: "db.example.test",
        port: 5432,
        status: "down",
        latency_ms: 40,
        detail: "Connection refused",
        checked_at: isoAtToday(12, 0),
        uptime_24h: 50.0,
        uptime_90d: 87.50,
        days: [
          { date: utcDayKey(2), status: "up", uptime: 100.0 },
          { date: utcDayKey(1), status: "up", uptime: 100.0 },
          { date: utcDayKey(0), status: "down", uptime: 20.0 },
        ],
      },
      {
        id: "auth-api",
        name: "Auth API",
        group: "APIs",
        type: "http",
        url: "https://auth.example.test/health",
        status: "up",
        latency_ms: 88,
        detail: "HTTP 200",
        checked_at: isoAtToday(12, 0),
        uptime_24h: 100.0,
        uptime_90d: 100.0,
        days: [
          { date: utcDayKey(2), status: "up", uptime: 100.0 },
          { date: utcDayKey(1), status: "up", uptime: 100.0 },
          { date: utcDayKey(0), status: "up", uptime: 100.0 },
        ],
      },
    ],
  };

  // Detail-panel history, keyed by check id. api-gateway has samples so the
  // expandable panel renders a spark strip; auth-api is intentionally absent so
  // the "could not load" path is exercised too.
  const histories = {
    "api-gateway": {
      days: [
        { date: utcDayKey(1), up: 6, degraded: 0, down: 0, total: 6 },
        { date: utcDayKey(0), up: 4, degraded: 0, down: 0, total: 4 },
      ],
      samples: [
        { t: isoAtToday(8, 0), s: "up", ms: 120 },
        { t: isoAtToday(9, 0), s: "up", ms: 140 },
        { t: isoAtToday(10, 0), s: "up", ms: 110 },
        { t: isoAtToday(11, 0), s: "up", ms: 130 },
        { t: isoAtToday(12, 0), s: "up", ms: 123 },
      ],
    },
  };

  return { summary, histories };
}

/* Labels app.js maps each status to; the spec imports these so it asserts the
 * exact text the page is expected to show. Keep in sync with STATUS_LABEL in
 * public/assets/app.js. */
const STATUS_LABEL = {
  up: "Operational",
  degraded: "Degraded",
  down: "Down",
  nodata: "No data",
};

module.exports = { buildDataset, STATUS_LABEL };
