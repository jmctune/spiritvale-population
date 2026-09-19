# Spiritvale Population

Scrapes Spiritvale server player counts every 15 minutes and renders them as a
static timeseries dashboard.

## Configuration

The server-list endpoint URL is **not** in source. Provide it via the
`SPIRITVALE_SERVER_LIST_URL` env var:

- **CI**: add it as a repository **variable** named `SPIRITVALE_SERVER_LIST_URL`
  (Settings -> Secrets and variables -> Actions -> Variables). The workflow reads
  it via `vars` and passes it to the scrape step. It stays out of the workflow YAML
  and, since the code never prints it, out of the run logs - while remaining
  readable to you in settings.
- **Local**: export it, put it in a git-ignored `.env` and run with
  `node --env-file=.env scripts/scrape.mjs`, or prefix the command.

Without it, the scrape exits with a clear error.

## Pipeline

```
server-list API  --scrape-->  data/history.sqlite  --build-->  docs/data/*.json  -->  docs/ dashboard
```

Each run does scrape -> downsample -> build -> publish. All four steps run in
`.github/workflows/scrape.yml`; the two `scripts/` entrypoints also run standalone.

### Scrape (`scripts/scrape.mjs` + `lib/fetch.mjs`)

`fetch.mjs` GETs the game-client server-list endpoint (URL from
`SPIRITVALE_SERVER_LIST_URL`) and parses its JSON array of channel instances, each
`{ name, region, players, max_players, host, port }`. Results are validated and
inserted at a single minute-aligned UTC timestamp, carrying the player count plus
capacity (`max_players`) and host (`ip:port`).

**Partial-table guard.** the endpoint sometimes returns before all channels have
loaded, giving far fewer than the full set (observed dropping from ~240 to as low
as 17), and fills back in on a later refresh. So the scrape
estimates the full-table size (the 75th percentile of recent per-scrape counts,
which ignores glitch-lows and rare peaks) and, if a fetch comes back below
`COMPLETENESS_RATIO` (0.9) of it, refetches - up to `MAX_ATTEMPTS` (4), 15s apart.
If it never fills in, the run records nothing for that slot (a gap) rather than a
misleading partial. The 0.9 slack means a cluster or two being genuinely down
still stores (and shows as "unknown"); only a large shortfall triggers retry/skip.
All four thresholds are env-overridable (`SPIRITVALE_MAX_ATTEMPTS`,
`SPIRITVALE_RETRY_DELAY_MS`, `SPIRITVALE_EXPECTED_PERCENTILE`,
`SPIRITVALE_COMPLETENESS_RATIO`).

### Store + downsample (`scripts/lib/db.mjs`)

SQLite (`data/history.sqlite`, committed) is the source of truth. One row per
`(ts, server)`:

```sql
readings(ts INTEGER, server TEXT, region TEXT, players INTEGER,
         max_players INTEGER, host TEXT, port INTEGER, PRIMARY KEY (ts, server))
```

Timestamps are unix seconds. Rollback-journal mode (not WAL) is used so the
`.sqlite` file is always self-contained when committed - no side-files.
`openDb()` adds the `max_players`/`host`/`port` columns to pre-existing DBs on open.

`downsample()` bounds growth: rows older than 30 days are compacted from 15-min
points into one hourly average per server. It is idempotent (hour-aligned rows
average to themselves) and writes the aggregate rows before deleting their
sub-hour sources. Net growth past the 30-day window is ~24 points/day/series.

### Build (`scripts/build.mjs`)

Queries the DB and writes the static JSON the dashboard consumes:

- `meta.json` - time span, scrape count, region list, server count.
- `latest.json` - the most recent snapshot: every channel + per-region totals.
- `regions.json` - wide, uPlot-ready: `t[]` plus per-region `series` (players)
  and `counts` (channel count) and a `total[]`.
- `servers/<name>.json` - per-channel timeseries, one file per channel, loaded on
  demand by the UI. Regenerated each build for channels in the latest snapshot.

Paths are overridable via `SPIRITVALE_DB` / `SPIRITVALE_OUT` (used for local
preview against a throwaway DB).

### Publish

The workflow commits the updated DB + JSON as a **parentless** commit and
force-pushes it, so the branch always holds exactly one commit whose tree is the
current data. Git *history* is discarded; the *data* survives because the DB and
JSON are re-committed every run. Net effect: the remote repo size stays flat no
matter how long it has been scraping.

Triggers: `repository_dispatch` (type `scrape`) as the primary external
every-15-min call, `schedule: */15` as a fallback when that call stops, and
`workflow_dispatch` for manual runs. A `concurrency` group serializes runs so
overlapping triggers never race on the force-push.

## Dashboard (`docs/`)

Plain HTML/CSS/JS, no build step, vendored [uPlot](https://github.com/leeoniya/uPlot),
no runtime network calls beyond its own JSON.

Entry names are `<cluster>-<channel>` (e.g. `na1-5` is channel 5 of cluster `na1`),
so the hierarchy is **region -> cluster -> channel**. Clusters are derived from the
names in the browser; a cluster's population is the sum of its channels. Two views:

- **Regions** - stat tiles, a players-per-region timeseries, and a
  channels-per-region timeseries (to catch channels being added/removed). Both
  charts have range controls and a toggleable legend.
- **Clusters** - a heatmap of server clusters, grouped by region and shaded by
  current player load, with search / region-filter / sort. Click a cluster to
  drill into its channel tiles, then a channel for its full history plus its
  capacity (`max_players`) and host (`ip:port`). Deep-linkable via
  `#cluster=<name>` or `#server=<channel>`.

spiritvale.info sometimes omits down clusters from a scrape. The build keeps a
roster of every channel seen in the last 30 days: a channel/cluster absent from
the latest scrape is rendered as a dashed **unknown** tile showing when it was
last online, counts as 0 players, and keeps its history reachable (the per-channel
file is still emitted). `latest.json` carries `online` / `lastSeen` per channel
for this. Channels not seen for 30 days are aged out (dropped from the roster and
no longer emitted). A totally empty scrape is treated as a failed run (see
`validate()` in `lib/fetch.mjs`), so it never marks everything offline at once.

## Local dev

```sh
npm install
export SPIRITVALE_SERVER_LIST_URL="<endpoint>"   # required by the scrape
npm run run-once                                 # scrape once + build -> docs/data/*.json
npx serve docs                                   # fetch() needs http, not file://
```

With real data you start at a single data point (flat charts) until scrapes
accumulate.

## Layout

```
scripts/
  scrape.mjs        scrape entrypoint
  build.mjs         DB -> docs/data/*.json
  lib/fetch.mjs     Inertia scraping
  lib/db.mjs        schema, insert, downsample
data/history.sqlite source of truth (committed)
docs/               dashboard + generated data (served by GitHub Pages)
.github/workflows/scrape.yml
```
