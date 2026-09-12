/* copf-demo status — renders data/summary.json into the page.
 * No dependencies, no build step. Re-fetches every 60 s so a browser left
 * open reflects the latest committed status. */

"use strict";

var REPO_URL = "https://github.com/cpflaume/simple-status-page";
var REFRESH_MS = 60000;

/* Fallback bar sizing if summary.json carries no display block. The collector
 * normally supplies these from the `display:` section of services.yaml. */
var DEFAULT_DISPLAY = { min_days: 30, max_days: 90 };

var STATUS_LABEL = { up: "Operational", degraded: "Degraded", down: "Down", nodata: "No data" };
var SEVERITY = { up: 0, degraded: 1, down: 2 };
var DAY_MS = 86400000;

/* Which detail panels the user has expanded, kept across the 60 s refresh so
 * an open panel does not snap shut when the page re-renders. */
var OPEN_ROWS = Object.create(null);

function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text; // textContent => no HTML injection
  return node;
}

function posInt(v, dflt) {
  return typeof v === "number" && isFinite(v) && v > 0 ? Math.floor(v) : dflt;
}

function fmtPct(v) {
  return v == null ? "—" : v.toFixed(2) + "%";
}

function fmtTime(iso) {
  if (!iso) return "—";
  var d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short"
  });
}

function fmtClock(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
}

function worstStatus(list) {
  var worst = null;
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    if (worst === null || (SEVERITY[s] || 0) > (SEVERITY[worst] || 0)) worst = s;
  }
  return worst || "nodata";
}

/* --- daily bar sizing ---------------------------------------------------- */

function utcKey(date) {
  return date.toISOString().slice(0, 10);
}

/* Whole days spanned from an ISO date (YYYY-MM-DD) up to and including today. */
function spanToToday(dateKey, today) {
  var from = Date.parse(dateKey + "T00:00:00Z");
  if (isNaN(from)) return 0;
  var to = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((to - from) / DAY_MS) + 1;
}

/* How many day-cells the bar should draw, shared across every service so the
 * rows line up:
 *   - never below display.min_days (missing older days render grey)
 *   - otherwise stretch to the most history any one service actually has
 *   - never above display.max_days
 */
function computeBarDays(checks, display, today) {
  var widest = 0;
  checks.forEach(function (c) {
    var days = c.days || [];
    for (var i = 0; i < days.length; i++) {
      var span = spanToToday(days[i].date, today);
      if (span > widest) widest = span;
    }
  });
  return Math.max(display.min_days, Math.min(widest, display.max_days));
}

/* Build a bar aligned to calendar days ending today, filling gaps with
 * "no data" so every service lines up. */
function buildBar(days, barDays, today) {
  var byDate = {};
  (days || []).forEach(function (d) { byDate[d.date] = d; });

  var bar = el("div", "bar");
  for (var i = barDays - 1; i >= 0; i--) {
    var dt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    var key = utcKey(dt);
    var day = byDate[key];
    var status = day ? day.status : "nodata";
    var cell = el("div", "bar__cell bar__cell--" + status);
    cell.title = day
      ? key + " · " + STATUS_LABEL[status] + " · " + fmtPct(day.uptime) + " uptime"
      : key + " · no data";
    bar.appendChild(cell);
  }
  return bar;
}

/* --- zoom / detail panel ------------------------------------------------- */

/* Group raw samples into hourly buckets (worst status + mean latency). */
function bucketByHour(samples) {
  var order = [];
  var map = {};
  samples.forEach(function (s) {
    var key = (s.t || "").slice(0, 13); // YYYY-MM-DDTHH
    if (!key) return;
    var b = map[key];
    if (!b) { b = { key: key, statuses: [], msSum: 0, msN: 0 }; map[key] = b; order.push(key); }
    b.statuses.push(s.s);
    if (typeof s.ms === "number") { b.msSum += s.ms; b.msN += 1; }
  });
  return order.map(function (k) {
    var b = map[k];
    return {
      t: b.key + ":00:00",
      s: worstStatus(b.statuses),
      ms: b.msN ? Math.round(b.msSum / b.msN) : null,
      count: b.statuses.length
    };
  });
}

/* One column = a latency bar (height ∝ ms, coloured by status) over a status
 * chip. Rendered newest-last so the strip reads left→right in time. */
function buildSpark(points, level) {
  var maxMs = 1;
  points.forEach(function (p) { if (typeof p.ms === "number" && p.ms > maxMs) maxMs = p.ms; });

  var spark = el("div", "spark spark--" + level);
  points.forEach(function (p) {
    var col = el("div", "spark__col");
    var hasMs = typeof p.ms === "number";
    var h = hasMs ? Math.max(6, Math.round((p.ms / maxMs) * 100)) : 100;

    var track = el("div", "spark__track");
    var bar = el("div", "spark__bar spark__bar--" + p.s);
    bar.style.height = h + "%";
    if (!hasMs) bar.classList.add("spark__bar--nolat");
    track.appendChild(bar);
    col.appendChild(track);
    col.appendChild(el("div", "spark__chip spark__chip--" + p.s));

    var when = level === "hour" ? fmtClock(p.t) + " (hour)" : fmtTime(p.t);
    var msText = hasMs ? p.ms + " ms" : "no latency";
    var extra = level === "hour" ? " · " + p.count + " probe" + (p.count === 1 ? "" : "s") : "";
    col.title = when + " · " + (STATUS_LABEL[p.s] || p.s) + " · " + msText + extra;
    spark.appendChild(col);
  });
  return spark;
}

function renderDetailBody(body, history) {
  body.textContent = "";
  var samples = (history && history.samples) || [];
  if (!samples.length) {
    body.appendChild(el("div", "detail__empty muted", "No recent samples yet."));
    return;
  }

  var state = { level: "raw" };

  var controls = el("div", "detail__controls");
  var buttons = {};
  [["raw", "10 min"], ["hour", "Hourly"]].forEach(function (pair) {
    var b = el("button", "zoom-btn", pair[1]);
    b.type = "button";
    b.addEventListener("click", function () {
      state.level = pair[0];
      draw();
    });
    buttons[pair[0]] = b;
    controls.appendChild(b);
  });

  var meta = el("div", "detail__meta muted");
  var strip = el("div", "detail__strip");
  var wrap = el("div", "detail__stripwrap");
  wrap.appendChild(strip);

  body.appendChild(controls);
  body.appendChild(wrap);
  body.appendChild(meta);

  function draw() {
    Object.keys(buttons).forEach(function (k) {
      buttons[k].classList.toggle("zoom-btn--on", k === state.level);
    });
    var points = state.level === "hour" ? bucketByHour(samples) : samples;
    strip.textContent = "";
    strip.appendChild(buildSpark(points, state.level));
    var first = points[0], last = points[points.length - 1];
    meta.textContent =
      points.length + (state.level === "hour" ? " hours" : " probes") +
      " · " + fmtClock(first.t) + " → " + fmtClock(last.t) +
      (state.level === "raw" ? " · ~10 min apart" : "");
    // Newest is on the right; keep it in view.
    wrap.scrollLeft = wrap.scrollWidth;
  }

  draw();
}

function buildDetail(check) {
  var panel = el("div", "detail");
  panel.hidden = true;
  var loaded = false;

  panel.load = function () {
    if (loaded) return;
    loaded = true;
    var body = el("div", "detail__body");
    body.appendChild(el("div", "detail__empty muted", "Loading recent samples…"));
    panel.appendChild(body);
    fetch("data/history/" + encodeURIComponent(check.id) + ".json?ts=" + Date.now(), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (history) { renderDetailBody(body, history); })
      .catch(function () {
        body.textContent = "";
        body.appendChild(el("div", "detail__empty muted", "Could not load detailed history."));
      });
  };
  return panel;
}

/* --- rows ---------------------------------------------------------------- */

function buildRow(check, barDays, today) {
  var row = el("div", "row");

  var head = el("div", "row__head");
  head.setAttribute("role", "button");
  head.setAttribute("tabindex", "0");
  head.setAttribute("aria-expanded", "false");

  var left = el("div", "row__left");
  var name = el("div", "row__name");
  name.appendChild(el("span", "row__caret", "▸"));
  name.appendChild(el("span", null, check.name));
  left.appendChild(name);
  var detailBits = [];
  if (check.detail) detailBits.push(check.detail);
  if (check.latency_ms != null && check.status !== "down") detailBits.push(check.latency_ms + " ms");
  left.appendChild(el("div", "row__detail muted", detailBits.join(" · ")));
  head.appendChild(left);

  var status = check.status || "nodata";
  head.appendChild(el("span", "pill pill--" + status, STATUS_LABEL[status] || status));
  row.appendChild(head);

  row.appendChild(buildBar(check.days, barDays, today));

  var legend = el("div", "bar__legend muted");
  legend.appendChild(el("span", null, barDays + " days ago"));
  legend.appendChild(el("span", null, fmtPct(check.uptime_90d) + " uptime"));
  legend.appendChild(el("span", null, "today"));
  row.appendChild(legend);

  var detail = buildDetail(check);
  row.appendChild(detail);

  function setOpen(open) {
    if (open) detail.load();
    detail.hidden = !open;
    row.classList.toggle("row--open", open);
    head.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) OPEN_ROWS[check.id] = true; else delete OPEN_ROWS[check.id];
  }
  function toggle() { setOpen(detail.hidden); }
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });

  if (OPEN_ROWS[check.id]) setOpen(true);

  return row;
}

function render(data) {
  document.getElementById("site-name").textContent = data.name || "Status";
  if (data.description) document.getElementById("site-desc").textContent = data.description;
  document.getElementById("updated").textContent = fmtTime(data.generated_at);
  document.getElementById("repo-link").href = REPO_URL;

  var state = data.overall_status || "operational";
  var banner = document.getElementById("banner");
  banner.className = "banner banner--" + state;
  document.getElementById("banner-text").textContent = data.overall_text || STATUS_LABEL[state] || state;

  var groupsEl = document.getElementById("groups");
  groupsEl.textContent = "";

  var checks = data.checks || [];
  if (!checks.length) {
    groupsEl.appendChild(el("div", "empty muted", "Awaiting the first status check…"));
    return;
  }

  var display = {
    min_days: posInt(data.display && data.display.min_days, DEFAULT_DISPLAY.min_days),
    max_days: posInt(data.display && data.display.max_days, DEFAULT_DISPLAY.max_days)
  };
  if (display.min_days > display.max_days) display.min_days = display.max_days;

  var today = new Date();
  var barDays = computeBarDays(checks, display, today);

  // Preserve config order while grouping.
  var order = [];
  var byGroup = {};
  checks.forEach(function (c) {
    var g = c.group || "Services";
    if (!byGroup[g]) { byGroup[g] = []; order.push(g); }
    byGroup[g].push(c);
  });

  order.forEach(function (name) {
    var group = el("section", "group");
    group.appendChild(el("h2", "group__title", name));
    var card = el("div", "group__card");
    byGroup[name].forEach(function (c) { card.appendChild(buildRow(c, barDays, today)); });
    group.appendChild(card);
    groupsEl.appendChild(group);
  });
}

function showError() {
  var banner = document.getElementById("banner");
  banner.className = "banner banner--error";
  document.getElementById("banner-text").textContent =
    "Status data is not available yet.";
  var groupsEl = document.getElementById("groups");
  groupsEl.textContent = "";
  groupsEl.appendChild(
    el("div", "empty muted",
      "No status snapshot published yet. The first automated check will populate this page shortly.")
  );
}

function load() {
  // Cache-bust so the 60 s refresh actually sees new commits.
  fetch("data/summary.json?ts=" + Date.now(), { cache: "no-store" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(render)
    .catch(showError);
}

load();
setInterval(load, REFRESH_MS);
