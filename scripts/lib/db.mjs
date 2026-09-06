// SQLite source of truth for scraped player counts.
//
// One row per (timestamp, server). Timestamps are UTC unix *seconds*, floored
// to the minute. Recent data is kept at full 15-minute resolution; data older
// than FULL_RES_DAYS is compacted into hourly averages (see downsample()).

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DB_PATH = 'data/history.sqlite';
export const FULL_RES_DAYS = 30;
const DAY = 86400;
const HOUR = 3600;

export function openDb(path = DB_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // Rollback-journal (not WAL): single writer, and the .sqlite file is committed
  // to git, so it must be self-contained after each commit with no side-files.
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = FULL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS readings (
      ts          INTEGER NOT NULL,
      server      TEXT    NOT NULL,
      region      TEXT    NOT NULL,
      players     INTEGER NOT NULL,
      max_players INTEGER,
      host        TEXT,
      port        INTEGER,
      PRIMARY KEY (ts, server)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_readings_server ON readings (server, ts);
  `);
  // Migrate DBs created before max_players/host/port existed.
  const cols = new Set(db.prepare('PRAGMA table_info(readings)').all().map((c) => c.name));
  for (const [name, type] of [['max_players', 'INTEGER'], ['host', 'TEXT'], ['port', 'INTEGER']]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE readings ADD COLUMN ${name} ${type}`);
  }
  return db;
}

// Insert one scrape's worth of rows at a single timestamp.
export function insertScrape(db, ts, servers) {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO readings (ts, server, region, players, max_players, host, port) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const tx = db.transaction((rows) => {
    for (const s of rows) stmt.run(ts, s.name, s.region, s.players, s.maxPlayers ?? null, s.host ?? null, s.port ?? null);
  });
  tx(servers);
}

// Record a full-outage slot: every channel from the most recent real scrape,
// written at `ts` with 0 players (keeping its region/capacity/host). Used when
// the server list is unreachable/empty on every attempt, so the trend shows the
// drop to zero instead of a gap.
//
// The channel set is taken from the latest scrape *before* `ts` (not the wider
// 30-day roster) so each outage slot has the same channel count as a normal
// scrape - this keeps it from disturbing the completeness threshold once the
// servers recover. Callers must only pass a `ts` that has no readings yet;
// otherwise a real scrape at that slot would be overwritten with zeros.
// Returns the number of channel rows written (0 if there is no prior scrape).
export function insertZeroReading(db, ts) {
  const srcTs = db.prepare('SELECT MAX(ts) AS t FROM readings WHERE ts < ?').get(ts).t;
  if (srcTs == null) return 0;
  const roster = db
    .prepare('SELECT server, region, max_players, host, port FROM readings WHERE ts = ?')
    .all(srcTs);
  if (!roster.length) return 0;
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO readings (ts, server, region, players, max_players, host, port) VALUES (?, ?, ?, 0, ?, ?, ?)',
  );
  const tx = db.transaction((rows) => {
    for (const r of rows) stmt.run(ts, r.server, r.region, r.max_players, r.host, r.port);
  });
  tx(roster);
  return roster.length;
}

// Compact sub-hour points older than FULL_RES_DAYS into one hourly average per
// server. Idempotent: hour-aligned rows already produced by a prior run average
// to themselves and are rewritten unchanged. Aggregate rows are written before
// their sub-hour source rows are deleted.
export function downsample(db, now) {
  const cutoff = now - FULL_RES_DAYS * DAY;
  const tx = db.transaction(() => {
    const collapsed = db
      .prepare(
        `INSERT OR REPLACE INTO readings (ts, server, region, players, max_players, host, port)
         SELECT (ts / ${HOUR}) * ${HOUR} AS bucket, server, MIN(region) AS region,
                CAST(ROUND(AVG(players)) AS INTEGER) AS players,
                MAX(max_players) AS max_players, MAX(host) AS host, MAX(port) AS port
         FROM readings
         WHERE ts < ?
         GROUP BY bucket, server`,
      )
      .run(cutoff);
    const removed = db
      .prepare(`DELETE FROM readings WHERE ts < ? AND (ts % ${HOUR}) != 0`)
      .run(cutoff);
    return { buckets: collapsed.changes, removed: removed.changes };
  });
  return tx();
}
