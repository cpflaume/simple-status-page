/* copf-demo status — renders data/summary.json into the page.
 * No dependencies, no build step. Re-fetches every 60 s so a browser left
 * open reflects the latest committed status. */

"use strict";

var REPO_URL = "https://github.com/cpflaume/simple-status-page";
var BAR_DAYS = 90;
var REFRESH_MS = 60000;

var STATUS_LABEL = { up: "Operational", degraded: "Degraded", down: "Down", nodata: "No data" };

function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text; // textContent => no HTML injection
  return node;
}

function fmtPct(v) {
  return v == null ? "—" : v.toFixed(v >= 99.995 ? 2 : 2) + "%";
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

/* Build a 90-cell bar aligned to calendar days ending today, filling gaps
 * with "no data" so every service lines up. */
function buildBar(days) {
  var byDate = {};
  (days || []).forEach(function (d) { byDate[d.date] = d; });

  var bar = el("div", "bar");
  var today = new Date();
  for (var i = BAR_DAYS - 1; i >= 0; i--) {
    var dt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    var key = dt.toISOString().slice(0, 10);
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

function buildRow(check) {
  var row = el("div", "row");

  var head = el("div", "row__head");
  var left = el("div");
  left.appendChild(el("div", "row__name", check.name));
  var detailBits = [];
  if (check.detail) detailBits.push(check.detail);
  if (check.latency_ms != null && check.status !== "down") detailBits.push(check.latency_ms + " ms");
  left.appendChild(el("div", "row__detail muted", detailBits.join(" · ")));
  head.appendChild(left);

  var status = check.status || "nodata";
  head.appendChild(el("span", "pill pill--" + status, STATUS_LABEL[status] || status));
  row.appendChild(head);

  row.appendChild(buildBar(check.days));

  var legend = el("div", "bar__legend muted");
  legend.appendChild(el("span", null, BAR_DAYS + " days ago"));
  legend.appendChild(el("span", null, fmtPct(check.uptime_90d) + " uptime"));
  legend.appendChild(el("span", null, "today"));
  row.appendChild(legend);

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
    var empty = el("div", "empty muted", "Awaiting the first status check…");
    groupsEl.appendChild(empty);
    return;
  }

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
    byGroup[name].forEach(function (c) { card.appendChild(buildRow(c)); });
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
