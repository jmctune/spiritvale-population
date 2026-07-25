// Backfill an outage: fill missing 15-minute scrape slots with explicit zero
// readings, so a stretch of downtime shows as a drop to zero in the population
// trend instead of a gap. This is the retroactive counterpart to what
// scrape.mjs now records live when the server list is unreachable (see
// insertZeroReading in lib/db.mjs).
//
// It fills every 15-min slot from the last real reading up to now that has no
// data, using the channel set of the most recent scrape. It never overwrites an
// existing slot, so it is safe to re-run.
//
// Usage:
//   node scripts/backfill-zero.mjs             # fill the gap (last reading -> now)
//   node scripts/backfill-zero.mjs --hours 5   # cap the lookback at 5 hours
//   node scripts/backfill-zero.mjs --dry-run   # report what it would fill

import { openDb, insertZeroReading, downsample } from './lib/db.mjs';

const QUARTER = 900; // 15 minutes in seconds
const DEFAULT_MAX_HOURS = 24; // safety cap so a stale DB can't fill huge ranges

function argValue(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const maxHours = Number(argValue('--hours', DEFAULT_MAX_HOURS));
  const db = openDb(process.env.SPIRITVALE_DB || undefined);
  try {
    const nowTs = Math.floor(Date.now() / 60000) * 60;
    const lastTs = db.prepare('SELECT MAX(ts) AS t FROM readings').get().t;
    if (lastTs == null) {
      console.log('no data in DB; nothing to backfill');
      return;
    }

    // Start after the last real reading, but never reach further back than the
    // lookback cap (guards against filling an unexpectedly huge gap).
    const startFrom = Math.max(lastTs, nowTs - maxHours * 3600);
    const half = Math.floor(QUARTER / 2);
    const near = db.prepare('SELECT COUNT(*) AS c FROM readings WHERE ts BETWEEN ? AND ?');

    let filled = 0;
    let channels = 0;
    let skipped = 0;
    for (let ts = startFrom + QUARTER; ts <= nowTs; ts += QUARTER) {
      // Skip if a reading already sits near this slot, so we never duplicate a
      // real (minute-jittered) scrape point or double-fill on a re-run.
      if (near.get(ts - half, ts + half).c > 0) {
        skipped++;
        continue;
      }
      if (dryRun) {
        filled++;
        continue;
      }
      const n = insertZeroReading(db, ts);
      if (n > 0) {
        filled++;
        channels += n;
      }
    }

    if (!dryRun && filled > 0) downsample(db, nowTs);

    const from = new Date((startFrom + QUARTER) * 1000).toISOString();
    const to = new Date(nowTs * 1000).toISOString();
    console.log(
      `${dryRun ? '[dry-run] ' : ''}backfilled ${filled} zero slots ` +
        `(${channels} channel-rows), skipped ${skipped} near existing points; ` +
        `window ${from} -> ${to}`,
    );
  } finally {
    db.close();
  }
}

main();
