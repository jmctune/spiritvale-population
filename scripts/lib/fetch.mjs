// Fetches the current channel list from Spiritvale's game-client API.
//
// The endpoint URL is intentionally NOT in source - it is read from the
// SPIRITVALE_SERVER_LIST_URL env var (a GitHub Actions secret in CI, an exported
// var locally). The endpoint returns a JSON array of channel instances, each
// with a current player count, capacity (max_players), and host (ip:port).

const ENV_KEY = 'SPIRITVALE_SERVER_LIST_URL';
const UA = 'spiritvale-population-scraper (+https://github.com/)';

// Normalize + validate the API rows into { name, region, players, maxPlayers, host, port }.
function validate(rows) {
  if (!Array.isArray(rows)) throw new Error('server-list response is not an array');
  if (rows.length === 0) throw new Error('server list is empty');
  return rows.map((s) => {
    const name = typeof s.name === 'string' && s.name ? s.name : s.instance_id;
    if (typeof name !== 'string' || !name) throw new Error(`bad name: ${JSON.stringify(s)}`);
    if (typeof s.region !== 'string' || !s.region) throw new Error(`bad region: ${JSON.stringify(s)}`);
    if (!Number.isFinite(s.players) || s.players < 0) throw new Error(`bad players: ${JSON.stringify(s)}`);
    return {
      name,
      region: s.region,
      players: s.players | 0,
      maxPlayers: Number.isFinite(s.max_players) ? s.max_players | 0 : null,
      host: typeof s.host === 'string' && s.host ? s.host : null,
      port: Number.isFinite(s.port) ? s.port | 0 : null,
    };
  });
}

// Returns [{ name, region, players, maxPlayers, host, port }, ...].
export async function fetchServers() {
  const url = process.env[ENV_KEY];
  if (!url) throw new Error(`${ENV_KEY} is not set - point it at the server-list endpoint`);
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`server-list fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  return validate(body);
}
