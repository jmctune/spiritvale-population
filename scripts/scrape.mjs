// Scrape entrypoint: fetch current player counts, store them, compact old data.
// Run via `npm run scrape`. Safe to run repeatedly; each run is one timestamp.
//
// --skip-if-current : no-op if a data point already exists for the current
//   15-minute window. Used by the GitHub `schedule` fallback so it does nothing
//   when the primary (on-the-quarter) trigger already scraped. Emits
//   `scraped=true|false` to $GITHUB_OUTPUT so the workflow can gate build/commit.
//
// Partial-table guard: spiritvale.info sometimes renders the table before all
// channels have loaded, returning fewer than the full set. When the fetched
// channel count is below what we know the full table to be, the scrape refetches
// (up to MAX_ATTEMPTS, RETRY_DELAY_MS apart) and, if it never fills in, records
// nothing for this slot rather than storing a misleading partial snapshot.

import { appendFileSync } from 'node:fs';
import { fetchServers } from './lib/fetch.mjs';
import { openDb, insertScrape, insertZeroReading, downsample } from './lib/db.mjs';

const QUARTER = 900; // 15 minutes in seconds
const DAY = 86400;

// Tunable via env (also lets tests drop the delay to 0).
const MAX_ATTEMPTS = Number(process.env.SPIRITVALE_MAX_ATTEMPTS || 4);
const RETRY_DELAY_MS = Number(process.env.SPIRITVALE_RETRY_DELAY_MS ?? 15000);
const EXPECTED_WINDOW_DAYS = Number(process.env.SPIRITVALE_EXPECTED_WINDOW_DAYS || 1);
// Percentile of recent per-scrape counts used as the "full table" size. A high
// percentile ignores glitch-lows (bottom half) without chasing rare peaks (max).
const EXPECTED_PERCENTILE = Number(process.env.SPIRITVALE_EXPECTED_PERCENTILE || 0.75);
// A scrape is "complete" if it has at least this fraction of the expected full
// table. Below it we treat the response as a load glitch and retry. The slack
// absorbs a cluster or two being legitimately down (those still store, and show
// as "unknown"); only a big shortfall triggers the retry/skip path.
const COMPLETENESS_RATIO = Number(process.env.SPIRITVALE_COMPLETENESS_RATIO || 0.9);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// UTC unix seconds floored to the minute (scrape wall-clock, not bucket-aligned).
function nowMinuteTs() {
  return Math.floor(Date.now() / 60000) * 60;
}

function setScrapedOutput(scraped) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `scraped=${scraped}\n`);
}

// The full-table size we expect: a high percentile of recent per-scrape counts.
// This ignores glitch-lows (which sit in the bottom half) without chasing rare
// peaks, and self-heals if the site permanently changes size (the new size
// becomes the norm, so the percentile follows it within a window).
function expectedFullCount(db) {
  const since = Math.floor(Date.now() / 1000) - EXPECTED_WINDOW_DAYS * DAY;
  const counts = db
    .prepare('SELECT COUNT(*) AS c FROM readings WHERE ts >= ? GROUP BY ts')
    .all(since)
    .map((r) => r.c)
    .sort((a, b) => a - b);
  if (!counts.length) return 0;
  const idx = Math.min(counts.length - 1, Math.floor(EXPECTED_PERCENTILE * counts.length));
  return counts[idx];
}

// Fetch until the table is complete (>= threshold channels) or attempts run out.
async function fetchComplete(db) {
  const expected = expectedFullCount(db);
  const threshold = Math.ceil(expected * COMPLETENESS_RATIO);
  let best = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let servers = null;
    try {
      servers = await fetchServers();
    } catch (e) {
      console.warn(`attempt ${attempt}/${MAX_ATTEMPTS}: fetch failed - ${e.message}`);
    }
    if (servers) {
      if (!best || servers.length > best.length) best = servers;
      if (servers.length >= threshold) return { servers, expected, threshold, attempts: attempt, complete: true };
      console.warn(
        `attempt ${attempt}/${MAX_ATTEMPTS}: partial table - ${servers.length} channels ` +
          `(expected ~${expected}, need >= ${threshold})`,
      );
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  return { servers: best, expected, threshold, attempts: MAX_ATTEMPTS, complete: false };
}

async function main() {
  const skipIfCurrent = process.argv.includes('--skip-if-current');
  const db = openDb(process.env.SPIRITVALE_DB || undefined);
  try {
    if (skipIfCurrent) {
      // Start of the current 15-min window; the primary trigger fires on it.
      const quarterStart = Math.floor(Date.now() / 1000 / QUARTER) * QUARTER;
      const latest = db.prepare('SELECT MAX(ts) AS t FROM readings').get().t;
      if (latest != null && latest >= quarterStart) {
        setScrapedOutput(false);
        console.log(`skip: point already exists for this window (latest ${new Date(latest * 1000).toISOString()})`);
        return;
      }
    }

    const result = await fetchComplete(db);
    if (!result.complete) {
      const best = result.servers?.length ?? 0;
      if (best === 0) {
        // Zero channels on every attempt = the servers are down, not a slow
        // partial load. Record an explicit zero reading (all channels from the
        // last scrape at 0 players) so the trend shows the outage as a drop to
        // zero instead of a gap.
        const ts = nowMinuteTs();
        const n = insertZeroReading(db, ts);
        if (n > 0) downsample(db, ts);
        setScrapedOutput(n > 0);
        console.log(
          `outage: 0 channels after ${result.attempts} attempts - recorded ${n} channels ` +
            `at 0 players @ ${new Date(ts * 1000).toISOString()}`,
        );
        return;
      }
      // A partial table (some channels, but below the completeness threshold) is
      // a load glitch - record nothing (a gap is better than a partial snapshot
      // that would flag live clusters as offline).
      setScrapedOutput(false);
      console.log(
        `no data: table still incomplete after ${result.attempts} attempts ` +
          `(best ${best} channels, needed >= ${result.threshold})`,
      );
      return;
    }

    const servers = result.servers;
    const ts = nowMinuteTs();
    insertScrape(db, ts, servers);
    const comp = downsample(db, ts);
    setScrapedOutput(true);

    const total = servers.reduce((a, s) => a + s.players, 0);
    console.log(
      `scraped ${servers.length} channels (expected ${result.expected}, attempt ${result.attempts}), ` +
        `${total} players @ ${new Date(ts * 1000).toISOString()} ` +
        `(compacted ${comp.buckets} hourly buckets, removed ${comp.removed} sub-hour rows)`,
    );
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('scrape failed:', err.message);
  process.exit(1);
});
