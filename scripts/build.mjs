// Build step: read the SQLite history and emit the static JSON the dashboard
// loads. Run via `npm run build` (the workflow runs it right after scrape).
//
// Outputs (under docs/data/):
//   meta.json            summary: time span, scrape count, regions, channel counts
//   regions.json         region player totals over time (wide, uPlot-ready)
//   latest.json          roster snapshot: every channel (online + offline) + totals
//   servers/<name>.json  per-channel timeseries, loaded on demand by the UI

import { openDb, DB_PATH } from './lib/db.mjs';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';

// Paths are overridable for local testing against a throwaway DB.
const DB = process.env.SPIRITVALE_DB || DB_PATH;
const OUT = process.env.SPIRITVALE_OUT || 'docs/data';
const SERVERS_DIR = `${OUT}/servers`;

function write(file, obj) {
  writeFileSync(file, JSON.stringify(obj));
}

// Nth-percentile (f in 0..1, nearest-rank) of a numeric array. Used to estimate
// the "full table" channel count from nearby scrapes when filtering partials.
function percentile(values, f) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const db = openDb(DB);
  try {
    const now = Math.floor(Date.now() / 1000);

    const span = db
      .prepare('SELECT MIN(ts) AS first, MAX(ts) AS last, COUNT(DISTINCT ts) AS scrapes FROM readings')
      .get();

    if (span.last == null) {
      console.log('no data yet; emitting empty outputs');
      emitEmpty(now);
      return;
    }

    // Roster snapshot -----------------------------------------------------
    // Every channel seen within the last ROSTER_DAYS, carrying its last-known row.
    // A channel absent from the latest scrape (spiritvale.info sometimes omits down
    // clusters) is kept and marked offline so the UI can still render it (as
    // "unknown") and its history. Channels not seen for ROSTER_DAYS are aged out.
    const ROSTER_DAYS = 30;
    const latestTs = span.last;
    const cutoff = latestTs - ROSTER_DAYS * 86400;
    const roster = db
      .prepare(
        `SELECT r.server AS name, r.region, r.ts AS lastSeen,
                r.max_players AS maxPlayers, r.host AS host, r.port AS port
         FROM readings r
         JOIN (SELECT server, MAX(ts) AS mx FROM readings GROUP BY server) m
           ON r.server = m.server AND r.ts = m.mx
         WHERE r.ts >= ?`,
      )
      .all(cutoff);

    const servers = roster
      .map((c) => ({
        name: c.name,
        region: c.region,
        players: 0, // offline stays 0; overwritten below for online channels
        online: c.lastSeen === latestTs,
        lastSeen: c.lastSeen,
        // last-known host details (unchanged whether the channel is online now)
        maxPlayers: c.maxPlayers ?? null,
        host: c.host ?? null,
        port: c.port ?? null,
      }))
      .sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name, undefined, { numeric: true }));

    // Fill current players for online channels from the latest scrape.
    const latestPlayers = new Map(
      db.prepare('SELECT server, players FROM readings WHERE ts = ?').all(latestTs).map((r) => [r.server, r.players]),
    );
    for (const s of servers) if (s.online) s.players = latestPlayers.get(s.name) ?? 0;

    const regionTotals = {};
    for (const s of servers) {
      regionTotals[s.region] ??= 0;
      regionTotals[s.region] += s.players; // offline contributes 0
    }
    // Region display order: biggest current (online) population first.
    const regions = Object.keys(regionTotals).sort((a, b) => regionTotals[b] - regionTotals[a]);
    const grandTotal = servers.reduce((a, s) => a + (s.online ? s.players : 0), 0);
    const onlineCount = servers.filter((s) => s.online).length;

    write(`${OUT}/latest.json`, {
      t: latestTs,
      generatedAt: now,
      regions,
      regionTotals,
      grandTotal,
      onlineCount,
      channelCount: servers.length,
      servers,
    });

    // Region timeseries (wide) -------------------------------------------
    // Per timestamp/region: total players (SUM) and channel count (COUNT).
    const regionRows = db
      .prepare('SELECT ts, region, SUM(players) AS p, COUNT(*) AS c FROM readings GROUP BY ts, region ORDER BY ts')
      .all();

    // Completeness filter. The scraper sometimes caught the server list mid-load
    // and returned far fewer channels than were actually up; summed into a total
    // those partial snapshots read as sharp dips-and-recoveries - false drops
    // that make the trend look jagged. We drop any timestamp whose channel count
    // is well below the local norm so the line follows the real envelope. The
    // norm is a rolling percentile of nearby scrapes' channel counts, so it
    // adapts as clusters are genuinely added or removed over time.
    //
    // A recorded outage (full roster, everyone at 0 - see insertZeroReading) has
    // a normal channel count, so it passes the filter and correctly renders as
    // zero rather than being smoothed away.
    const perTs = db
      .prepare('SELECT ts, COUNT(*) AS c, SUM(players) AS p FROM readings GROUP BY ts ORDER BY ts')
      .all();
    const RATIO = Number(process.env.SPIRITVALE_COMPLETENESS_RATIO || 0.9);
    const WINDOW = 96; // ~1 day of 15-min scrapes, centered on each point
    const tsIndex = new Map(); // ts -> index in t[] (complete scrapes only)
    const outageTs = new Set(); // complete scrapes with zero players everywhere
    const t = [];
    let dropped = 0;
    for (let i = 0; i < perTs.length; i++) {
      const lo = Math.max(0, i - WINDOW / 2);
      const hi = Math.min(perTs.length, i + WINDOW / 2 + 1);
      const expected = percentile(perTs.slice(lo, hi).map((r) => r.c), 0.75);
      if (perTs[i].c < RATIO * expected) {
        dropped++;
        continue; // partial snapshot - leave a gap so the chart interpolates
      }
      tsIndex.set(perTs[i].ts, t.length);
      if (perTs[i].p === 0) outageTs.add(perTs[i].ts);
      t.push(perTs[i].ts);
    }

    const series = {}; // players per region
    const counts = {}; // channel count per region
    for (const reg of regions) {
      series[reg] = new Array(t.length).fill(null);
      counts[reg] = new Array(t.length).fill(null);
    }
    const total = new Array(t.length).fill(0);
    for (const r of regionRows) {
      const i = tsIndex.get(r.ts);
      if (i === undefined) continue; // dropped as a partial scrape
      if (series[r.region]) series[r.region][i] = r.p;
      // Outage channels are zero-filled placeholders, not live channels, so the
      // count reads 0 there too (else it shows a full roster at 0 players).
      if (counts[r.region]) counts[r.region][i] = outageTs.has(r.ts) ? 0 : r.c;
      total[i] += r.p;
    }
    write(`${OUT}/regions.json`, { generatedAt: now, regions, t, series, counts, total });

    // Per-channel timeseries ---------------------------------------------
    // Emitted for every roster channel, including offline ones, so their history
    // stays reachable (you can see when a down channel was last online). Aged-out
    // channels (not in the roster) are skipped so the servers/ dir stays bounded.
    rmSync(SERVERS_DIR, { recursive: true, force: true });
    mkdirSync(SERVERS_DIR, { recursive: true });
    const regionOf = new Map(servers.map((s) => [s.name, s.region]));
    const rosterNames = new Set(servers.map((s) => s.name));
    const perServer = new Map(); // name -> { t:[], players:[] }
    const rows = db
      .prepare('SELECT server, ts, players FROM readings ORDER BY server, ts')
      .all();
    for (const r of rows) {
      if (!rosterNames.has(r.server)) continue; // aged out of the roster
      let e = perServer.get(r.server);
      if (!e) {
        e = { t: [], players: [] };
        perServer.set(r.server, e);
      }
      e.t.push(r.ts);
      e.players.push(r.players);
    }
    for (const [name, e] of perServer) {
      write(`${SERVERS_DIR}/${encodeURIComponent(name)}.json`, {
        name,
        region: regionOf.get(name),
        t: e.t,
        players: e.players,
      });
    }

    // Meta ----------------------------------------------------------------
    write(`${OUT}/meta.json`, {
      generatedAt: now,
      firstTs: span.first,
      lastTs: span.last,
      scrapeCount: span.scrapes,
      channelCount: servers.length,
      onlineCount,
      regions,
      fullResDays: 30,
    });

    console.log(
      `built dashboard data: ${onlineCount}/${servers.length} channels online, ${span.scrapes} scrapes, ` +
        `${t.length} time points (dropped ${dropped} partial scrapes), ` +
        `span ${new Date(span.first * 1000).toISOString()} -> ${new Date(span.last * 1000).toISOString()}`,
    );
  } finally {
    db.close();
  }
}

function emitEmpty(now) {
  mkdirSync(SERVERS_DIR, { recursive: true });
  write(`${OUT}/meta.json`, { generatedAt: now, firstTs: null, lastTs: null, scrapeCount: 0, channelCount: 0, onlineCount: 0, regions: [], fullResDays: 30 });
  write(`${OUT}/regions.json`, { generatedAt: now, regions: [], t: [], series: {}, counts: {}, total: [] });
  write(`${OUT}/latest.json`, { t: null, generatedAt: now, regions: [], regionTotals: {}, grandTotal: 0, onlineCount: 0, channelCount: 0, servers: [] });
}

main();
