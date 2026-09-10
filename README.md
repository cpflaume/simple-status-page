# copf-demo status

Public, automatically-updating status page for the `copf-demo.de` services —
the kind of page cloud providers publish for their offerings.

**Live:** https://status.copf-demo.de

- **Automated** — a scheduled job probes every service and updates the page on
  its own. Nobody edits status by hand.
- **Independently hosted** — runs on GitHub's infrastructure (Actions + Pages),
  *not* on the VM it monitors, so it stays up and correctly shows an outage even
  when that VM is down.
- **Declarative & extensible** — one YAML file lists what to monitor; each check
  has a `type` so new data sources (Prometheus, push-based, …) plug in without
  touching the page.
- **Free** — a public repo gets unlimited GitHub Actions minutes and free Pages
  hosting. See [Cost](#cost).

## How it works

```
                    GitHub Actions (every 5 min, GitHub's infra)
                    ┌──────────────────────────────────────────┐
config/services.yaml│  collect.py                                │
      (what to check)│    → run each check via its checker        │
                    │    → write data/summary.json + history/*   │──┐
                    │    → git commit  (durable incident history)│  │
                    │    → deploy to GitHub Pages                │  │
                    └──────────────────────────────────────────┘  │
                                                                    ▼
   your services  ◀── probes ──   status.copf-demo.de  ◀── serves ── GitHub Pages
   (the VM)                        (static page reads summary.json)
```

GitHub Pages only serves static files — it cannot probe anything itself. The
automation is the scheduled **GitHub Actions** workflow
([`.github/workflows/monitor.yml`](.github/workflows/monitor.yml)):

1. Every ~5 minutes it runs [`collector/collect.py`](collector/collect.py).
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
GitHub, entirely off the Oracle-Cloud VM, so a full-VM outage shows up honestly
as everything red rather than as an unreachable page.

## What it monitors

Probes hit **public, unauthenticated** endpoints — the same thing a real
visitor's browser would reach, which is what a public status page should
measure. `/` proves a frontend is served; `/v3/api-docs` (public Springdoc
OpenAPI JSON) proves the Spring Boot API process is alive.

| Service | Check | Endpoint |
|---|---|---|
| Announcements | http | `https://announcements.copf-demo.de/` |
| Announcements API | http | `https://announcements.copf-demo.de/v3/api-docs` |
| Jurtenburg (Inventory) | http | `https://jurtenburg.copf-demo.de/` |
| Jurtenburg API | http | `https://jurtenburg.copf-demo.de/v3/api-docs` |
| Provision Calculator | http | `https://provisioncalculator.copf-demo.de/` |
| Provision Calculator API | http | `https://provisioncalculator.copf-demo.de/v3/api-docs` |
| Backup & Restore | http | `https://backup.copf-demo.de/` |
| Showcase | http | `https://showcase.copf-demo.de/` |
| Typo mail responder | tcp/smtp | `mail.copf-demo.de:25` *(disabled — see below)* |

Domains that front both an API and a UI (announcements, jurtenburg,
provisioncalculator) get one check per backing service, mirroring the
Service-vs-Site split in the `copf-demo-gitops` repo.

## The catalog: `config/services.yaml`

Adding a service is a one-file change — no code:

```yaml
groups:
  - name: Web applications
    checks:
      - id: my-service          # stable slug; also the history filename
        name: My Service         # label on the page
        type: http               # which checker runs it
        url: https://my.example.de/
        expect_status: [200]     # optional (default [200])
```

Set `enabled: false` to keep a check defined but not run. Config-wide fallbacks
live under `defaults:` (`timeout`, `degraded_latency_ms`).

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

### SMTP / port 25 (and push-based checks)

`typo-mail-responder` speaks SMTP, so it needs the `tcp` checker — but
**GitHub-hosted runners block outbound port 25**, so the probe can't succeed
from a default runner. It therefore ships **disabled** in the catalog. Two clean
ways to enable it:

1. **Self-hosted runner** with port-25 egress — flip `enabled: true` and run the
   job (or a second workflow) on that runner.
2. **Push-based reporting** — the mail host reports its own health by committing
   a `data/history/<id>.json` entry (or triggering a `repository_dispatch` the
   workflow consumes). This is the general answer to "status/metrics from
   sources the central job can't reach," and a `push` checker type is the
   intended home for it.

## Cost

**€0.** Public repositories get **free, unlimited** standard GitHub-hosted
Actions minutes and free Pages hosting; the monthly minute quota applies only to
*private* repos. The workflow is a single job on `ubuntu-latest`, so one rounded
minute is billed per run — and billed at zero on a public repo.

> Keep this repo **public**. If it were private, the every-5-minute schedule
> (~8,700 runs/month) would run several times over the 2,000-minute free
> allowance; you'd have to drop to roughly hourly checks. Public avoids that
> entirely. Change the cadence anytime via the `cron:` line in the workflow.

## One-time setup

The repository and its contents are created for you. Two manual steps remain
(neither is scriptable via the API):

1. **Enable Pages:** repo **Settings → Pages → Build and deployment → Source =
   GitHub Actions**.
2. **Point the domain:** at your DNS provider add
   `CNAME  status  →  cpflaume.github.io.`
   (`public/CNAME` already claims `status.copf-demo.de`; GitHub issues the TLS
   cert automatically once DNS resolves.)

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

Run the tests (no network needed — they probe loopback servers):

```bash
pip install -r tests/requirements.txt
pytest tests/ -q
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
  history/<id>.json           rolling 90-day daily buckets + recent samples
.github/workflows/monitor.yml the scheduled collect + deploy job
tests/                        collector unit tests
```

## Data model

- `data/summary.json` — overall roll-up + current state, uptime (24 h / 90 d),
  and a per-day status array for each check.
- `data/history/<id>.json` — `days[]` (up to 90 daily buckets:
  up/degraded/down counts) and `samples[]` (last 200 raw probes). Retention is
  capped so the committed files stay tiny.

Uptime counts anything not hard-`down` as available (a `degraded` service is
still serving). The 90-day bar colours each day green / amber / red / grey (no
data).
