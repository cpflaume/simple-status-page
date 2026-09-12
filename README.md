# Simple Status Page

[![Live status page](https://img.shields.io/badge/Live-status.copf--demo.de-18a058?style=for-the-badge&logo=githubpages&logoColor=white)](https://status.copf-demo.de)

A public, automatically-updating status page for whatever services you run —
the kind of page cloud providers publish for their offerings. Point it at your
own endpoints and it monitors them for you.

- **Automated** — a scheduled job probes every service and updates the page on
  its own. Nobody edits status by hand.
- **Independently hosted** — runs on GitHub's infrastructure (Actions + Pages),
  *not* on the machines it monitors, so it stays up and correctly shows an
  outage even when your infrastructure is down.
- **Declarative & extensible** — one YAML file lists what to monitor; each check
  has a `type` so new data sources (Prometheus, push-based, …) plug in without
  touching the page.
- **Free** — a public repo gets unlimited GitHub Actions minutes and free Pages
  hosting. See [Cost](#cost).

## How it works

```
                    GitHub Actions (every 10 min, GitHub's infra)
                    ┌──────────────────────────────────────────┐
config/services.yaml│  collect.py                                │
      (what to check)│    → run each check via its checker        │
                    │    → write data/summary.json + history/*   │──┐
                    │    → git commit  (durable incident history)│  │
                    │    → deploy to GitHub Pages                │  │
                    └──────────────────────────────────────────┘  │
                                                                    ▼
   your services  ◀── probes ──   your status page  ◀── serves ── GitHub Pages
                                   (static page reads summary.json)
```

GitHub Pages only serves static files — it cannot probe anything itself. The
automation is the scheduled **GitHub Actions** workflow
([`.github/workflows/monitor.yml`](.github/workflows/monitor.yml)):

1. Every ~10 minutes it runs [`collector/collect.py`](collector/collect.py).
2. The collector reads the catalog, probes each service, and normalizes the
   result to `up` / `degraded` / `down` + latency.
3. Results are written to JSON and **committed to the repo** — so git history
   *is* the incident record — then the page is redeployed to Pages.

When a service goes down, the next run flips its tile to red and lowers its
uptime %. You only touch [`config/services.yaml`](config/services.yaml) when a
service is added or removed.

### Why host it separately (the one rule that matters)

A status page hosted on the same box it monitors is useless exactly when you
need it: the box dies and takes the status page with it. This page runs on
GitHub, entirely off your own infrastructure, so a full outage shows up
honestly as everything red rather than as an unreachable page.

## What it monitors

Whatever you list in the catalog. Probes typically hit **public,
unauthenticated** endpoints — the same thing a real visitor's browser would
reach, which is what a public status page should measure. A single domain that
fronts both a UI and an API can be split into separate checks so each backing
service is measured on its own.

## The catalog: `config/services.yaml`

Adding a service is a one-file change — no code:

```yaml
groups:
  - name: Web applications
    checks:
      - id: my-service          # stable slug; also the history filename
        name: My Service         # label on the page
        type: http               # which checker runs it
        url: https://my.example.com/
        expect_status: [200]     # optional (default [200])
```

Set `enabled: false` to keep a check defined but not run. Config-wide fallbacks
live under `defaults:` (`timeout`, `degraded_latency_ms`).

### Sizing the uptime bar: `display:`

The per-service bar no longer fixes itself to 90 days. A top-level `display:`
block controls how wide it grows:

```yaml
display:
  min_days: 30   # bar never shrinks below this (missing older days show grey)
  max_days: 90   # bar never grows past this (older history is not shown)
```

Between the two bounds the bar stretches to fit however much history actually
exists — measured across **all** services, so every row stays aligned. With
little data yet the bar stays at `min_days` and the empty older cells render
grey, exactly as before. Raising `max_days` above 90 also raises how many daily
buckets the collector retains. Omit the block entirely to get the `30 / 90`
defaults.

### Zooming in to the raw samples

Click any service row to expand a detail panel that plots the recent raw probes
(kept in `data/history/<id>.json`, ~10 min apart). Toggle between **10 min**
(one bar per probe) and **Hourly** (probes averaged per hour); bar height tracks
latency and colour tracks status, so a slow-but-up blip and a hard outage read
differently at a glance.

## Extending to new data sources

This is the design's core: the collector and the page only ever see a
normalized `CheckResult` (`status`, `latency_ms`, `detail`). Each `type:` maps
to a **checker** in [`collector/checkers/`](collector/checkers/). Shipped today:

- **`http`** — GET a URL, assert status code / optional body substring, flag
  slow-but-up as `degraded`.
- **`tcp`** — open a socket, optionally match a banner (e.g. SMTP `220`).

**To add a source, write one class and register it — nothing else changes:**

```python
# collector/checkers/prometheus_checker.py
from .base import Checker, CheckResult, STATUS_UP, STATUS_DOWN

class PrometheusChecker(Checker):
    TYPE = "prometheus"
    def check(self, check, defaults):
        value = query_promql(check["query"], check["endpoint"])   # your code
        ok = value < check["threshold"]
        return CheckResult(STATUS_UP if ok else STATUS_DOWN,
                           detail=f"{check['query']}={value}")
```

Then add `PrometheusChecker` to `_CHECKERS` in
[`collector/checkers/__init__.py`](collector/checkers/__init__.py) and reference
`type: prometheus` in the catalog. Natural future types: `prometheus` (metrics
thresholds), `dns`, `keyword`, and **`push`** (see below).

### Checks the central job can't reach (e.g. push-based)

Some things can't be probed from a default GitHub-hosted runner — for example
outbound port 25 is blocked, so an SMTP check can't succeed there. Two clean
ways to handle such cases:

1. **Self-hosted runner** with the egress you need — run the job (or a second
   workflow) on that runner.
2. **Push-based reporting** — the source reports its own health by committing a
   `data/history/<id>.json` entry (or triggering a `repository_dispatch` the
   workflow consumes). This is the general answer to "status/metrics from
   sources the central job can't reach," and a `push` checker type is the
   intended home for it.

## Cost

**€0.** Public repositories get **free, unlimited** standard GitHub-hosted
Actions minutes and free Pages hosting; the monthly minute quota applies only to
*private* repos. The workflow is a single job on `ubuntu-latest`, so one rounded
minute is billed per run — and billed at zero on a public repo.

> Keep this repo **public**. On a private repo the scheduled runs would consume
> your monthly minute allowance and you'd have to run checks far less often.
> Public avoids that entirely. Change the cadence anytime via the `cron:` line
> in the workflow.

## One-time setup

Two manual steps remain (neither is scriptable via the API):

1. **Enable Pages:** repo **Settings → Pages → Build and deployment → Source =
   GitHub Actions**.
2. **Point the domain (optional):** at your DNS provider add a `CNAME` record
   for your status subdomain pointing at `<your-user>.github.io.`, and put that
   hostname in `public/CNAME`. GitHub issues the TLS cert automatically once DNS
   resolves.

Then trigger the first run: **Actions → monitor → Run workflow** (or just push).
The first run publishes the page with live data.

## Local development

```bash
pip install -r collector/requirements.txt
python collector/collect.py                       # writes data/summary.json + history/*
# Assemble the page + data exactly like CI does, then serve it:
mkdir -p _site && cp -R public/. _site/ && cp -R data _site/data
python -m http.server -d _site 8000               # open http://localhost:8000/
```

Run the collector tests (no network needed — they probe loopback servers):

```bash
pip install -r tests/requirements.txt
pytest tests/ -q
```

Run the UI tests (Playwright drives the real page against a fixture dataset and
asserts the JSON is correctly reflected on the page):

```bash
cd tests/ui
npm ci
npx playwright install --with-deps chromium
npx playwright test
```

## Layout

```
config/services.yaml          the catalog you edit
collector/
  collect.py                  entrypoint: probe → normalize → write JSON
  checkers/                   pluggable sources (base, http, tcp, + your own)
public/                       the static page (index.html, assets, CNAME)
data/                         committed status snapshot + per-check history
  summary.json                latest state (what the page loads)
  history/<id>.json           rolling daily buckets + recent samples
.github/workflows/monitor.yml the scheduled collect + deploy job
.github/workflows/ui-tests.yml UI tests: JSON is reflected on the page
tests/                        collector unit tests
  ui/                         Playwright UI tests (data → page)
```

## Data model

- `data/summary.json` — overall roll-up + current state, uptime (24 h / 90 d),
  and a per-day status array for each check.
- `data/history/<id>.json` — `days[]` (daily buckets: up/degraded/down counts,
  retained to at least `display.max_days`) and `samples[]` (last 200 raw probes,
  driving the 10-min zoom). Retention is capped so the committed files stay tiny.

Uptime counts anything not hard-`down` as available (a `degraded` service is
still serving). The daily bar colours each day green / amber / red / grey (no
data) and is sized by the `display:` block (see above).
