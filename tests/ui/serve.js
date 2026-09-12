/* Minimal static server for the UI tests — no dependencies.
 *
 * Serves the real, unmodified page from ../../public and injects the fixture
 * data from dataset.js at the same paths the deployed site uses
 * (data/summary.json, data/history/<id>.json). This mirrors how the monitor
 * workflow assembles _site (public/. + data), so the tests exercise the page
 * exactly as shipped, only with deterministic data.
 *
 * Listens on PORT (default 4173) and serves until killed.
 */

"use strict";

const http = require("node:http");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { buildDataset } = require("./dataset.js");

const PUBLIC_DIR = path.resolve(__dirname, "..", "..", "public");
const PORT = Number(process.env.PORT) || 4173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const { summary, histories } = buildDataset();

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
  res.end(body);
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

const server = http.createServer(async (req, res) => {
  // Strip query string (the page cache-busts with ?ts=...).
  let pathname = decodeURIComponent((req.url || "/").split("?")[0]);
  if (pathname === "/") pathname = "/index.html";

  // Fixture data endpoints.
  if (pathname === "/data/summary.json") return sendJson(res, summary);
  const m = pathname.match(/^\/data\/history\/([^/]+)\.json$/);
  if (m) {
    const hist = histories[m[1]];
    return hist ? sendJson(res, hist) : notFound(res);
  }

  // Everything else: static file from public/, path-traversal guarded.
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return notFound(res);
  }
  try {
    const data = await readFile(filePath);
    const type = MIME[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  } catch {
    notFound(res);
  }
});

server.listen(PORT, () => {
  console.log(`UI test server on http://127.0.0.1:${PORT}`);
});
