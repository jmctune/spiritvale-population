/* Spiritvale Population dashboard.
   Loads the static JSON emitted by scripts/build.mjs and renders:
     - Regions view: stat tiles + a multi-series player-count timeseries
     - Servers view: a searchable/sortable grid; click a server for its history
   Charts use uPlot (vendored). No build step, no external requests. */
'use strict';

const REGION_COLORS = {
  sea: '#38bdf8', na: '#f472b6', eu: '#a78bfa', sa: '#fbbf24', oce: '#34d399',
};
const FALLBACK_COLORS = ['#38bdf8', '#f472b6', '#a78bfa', '#fbbf24', '#34d399', '#fb7185', '#4ade80', '#c084fc'];
const TOTAL_COLOR = '#6ea8fe';
const AXIS = '#9aa3b2';
const GRID = { stroke: 'rgba(128,128,128,0.15)', width: 1 };
const TICKS = { stroke: 'rgba(128,128,128,0.25)', width: 1 };

const RANGES = [
  { label: '24h', sec: 86400 },
  { label: '7d', sec: 604800 },
  { label: '30d', sec: 2592000 },
  { label: 'All', sec: null },
];

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fmtNum = (n) => (n == null ? '–' : Number(n).toLocaleString('en-US'));
const fmtWhen = (ts) =>
  new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const colorFor = (region, i) => REGION_COLORS[region] || FALLBACK_COLORS[i % FALLBACK_COLORS.length];
// A channel name is "<cluster>-<n>"; the cluster is everything before the last -n.
const clusterOf = (name) => name.replace(/-\d+$/, '');

async function getJSON(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

function lastValue(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

// Slice aligned series to the trailing `rangeSec` window. null = keep all.
function sliceRange(t, arrays, rangeSec) {
  if (!rangeSec || t.length === 0) return [t, arrays];
  const cutoff = t[t.length - 1] - rangeSec;
  let i = 0;
  while (i < t.length && t[i] < cutoff) i++;
  return [t.slice(i), arrays.map((a) => a.slice(i))];
}

function baseOpts(width, height, seriesDefs) {
  return {
    width,
    height,
    scales: { x: { time: true } },
    axes: [
      { stroke: AXIS, grid: GRID, ticks: TICKS },
      {
        stroke: AXIS, grid: GRID, ticks: TICKS, size: 56,
        values: (u, splits) => splits.map((v) => (v >= 1000 ? (v / 1000) + 'k' : v)),
      },
    ],
    series: seriesDefs,
    legend: { show: false },
    cursor: { points: { size: 6 }, focus: { prox: 24 } },
    padding: [12, 12, 4, 4],
    plugins: [tooltipPlugin()],
  };
}

// Hover tooltip: the exact value of every visible series at the highlighted
// timestamp. Ported (in spirit) from unora-population-checker's hover overlay,
// adapted to uPlot's cursor. One instance per chart (created in baseOpts).
function tooltipPlugin() {
  let tt;
  return {
    hooks: {
      init(u) {
        tt = el('div', 'u-tooltip');
        u.over.appendChild(tt);
        u.over.addEventListener('mouseleave', () => tt.classList.remove('on'));
      },
      setCursor(u) {
        const { idx, left, top } = u.cursor;
        if (idx == null || left < 0) { tt.classList.remove('on'); return; }
        const ts = u.data[0][idx];
        let rows = '';
        let any = false;
        for (let i = 1; i < u.series.length; i++) {
          const s = u.series[i];
          if (s.show === false) continue;
          const v = u.data[i][idx];
          const stroke = typeof s.stroke === 'function' ? s.stroke(u, i) : s.stroke;
          rows +=
            `<div class="t-row${v == null ? ' dim' : ''}">` +
            `<span class="dot" style="background:${stroke}"></span>` +
            `<span class="t-lbl">${s.label}</span>` +
            `<span class="t-val">${v == null ? '–' : fmtNum(v)}</span></div>`;
          any = true;
        }
        if (!any) { tt.classList.remove('on'); return; }
        tt.innerHTML = `<div class="t-time">${fmtWhen(ts)}</div>${rows}`;
        tt.classList.add('on');
        // Place on whichever side of the cursor has room, clamped into the plot.
        const ow = u.over.clientWidth, oh = u.over.clientHeight;
        const tw = tt.offsetWidth, th = tt.offsetHeight;
        let x = left + 14 + tw > ow ? left - tw - 14 : left + 14;
        x = Math.max(0, Math.min(x, ow - tw));
        const y = Math.max(0, Math.min((top ?? 0) + 12, oh - th));
        tt.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      },
    },
  };
}

function renderRangeButtons(container, initialSec, onPick) {
  container.innerHTML = '';
  RANGES.forEach((r) => {
    const b = el('button', 'range', r.label);
    if (r.sec === initialSec) b.classList.add('active');
    b.onclick = () => {
      [...container.children].forEach((c) => c.classList.remove('active'));
      b.classList.add('active');
      onPick(r.sec);
    };
    container.appendChild(b);
  });
}

/* ------------------------------------------------------------------ Regions */

let regionData = null;
let totalChart = null;
let regionChart = null;
let countChart = null;
let totalRange = 604800; // default 7d
let regionRange = 604800;
let countRange = 604800;

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function renderRegionTiles(latest) {
  const wrap = $('#region-tiles');
  wrap.innerHTML = '';
  const total = el('div', 'tile');
  total.append(el('div', 'label', 'total online'));
  const tv = el('div', 'value', fmtNum(latest.grandTotal));
  total.appendChild(tv);
  wrap.appendChild(total);
  latest.regions.forEach((reg, i) => {
    const tile = el('div', 'tile');
    tile.append(el('div', 'label', reg.toUpperCase()));
    const v = el('div', 'value');
    const dot = el('span', 'dot');
    dot.style.background = colorFor(reg, i);
    v.append(dot, document.createTextNode(fmtNum(latest.regionTotals[reg])));
    tile.appendChild(v);
    wrap.appendChild(tile);
  });
}

// Combined total: every server/channel summed into one series over time.
function drawTotalChart() {
  const host = $('#total-chart');
  const width = host.clientWidth || 800;
  const [xs, ys] = sliceRange(regionData.t, [regionData.total], totalRange);
  const seriesDefs = [
    {},
    {
      label: 'Total players',
      stroke: TOTAL_COLOR,
      fill: rgba(TOTAL_COLOR, 0.1),
      width: 2,
      points: { show: false },
      value: (u, v) => fmtNum(v),
    },
  ];
  if (totalChart) totalChart.destroy();
  totalChart = new uPlot(baseOpts(width, 300, seriesDefs), [xs, ...ys], host);
}

// Generic multi-series region timeseries (players OR server counts).
function buildRegionChart(host, valuesByRegion, range, height) {
  const width = host.clientWidth || 800;
  const regions = regionData.regions;
  const full = regions.map((r) => valuesByRegion[r] || []);
  const [xs, ys] = sliceRange(regionData.t, full, range);
  const seriesDefs = [{}];
  regions.forEach((r, i) => {
    seriesDefs.push({
      label: r.toUpperCase(),
      stroke: colorFor(r, i),
      width: 2,
      points: { show: false },
      value: (u, v) => fmtNum(v),
    });
  });
  return new uPlot(baseOpts(width, height, seriesDefs), [xs, ...ys], host);
}

// Clickable legend that toggles each region series and shows its latest value.
function buildRegionLegend(wrap, chart, valuesByRegion) {
  wrap.innerHTML = '';
  regionData.regions.forEach((r, i) => {
    const idx = i + 1; // series index in uPlot (0 is x)
    const item = el('div', 'item');
    const dot = el('span', 'dot');
    dot.style.background = colorFor(r, i);
    const label = el('span', null, r.toUpperCase() + ' ');
    const val = el('b', null, fmtNum(lastValue(valuesByRegion[r] || [])));
    item.append(dot, label, val);
    if (!chart.series[idx].show) item.classList.add('off');
    item.onclick = () => {
      const show = !chart.series[idx].show;
      chart.setSeries(idx, { show });
      item.classList.toggle('off', !show);
    };
    wrap.appendChild(item);
  });
}

function drawRegionChart() {
  if (regionChart) regionChart.destroy();
  regionChart = buildRegionChart($('#region-chart'), regionData.series, regionRange, 340);
  buildRegionLegend($('#region-legend'), regionChart, regionData.series);
}

function drawCountChart() {
  if (countChart) countChart.destroy();
  countChart = buildRegionChart($('#region-count-chart'), regionData.counts, countRange, 240);
  buildRegionLegend($('#region-count-legend'), countChart, regionData.counts);
}

/* ------------------------------------------------------------------ Servers */

let latestData = null;
let serverChart = null;
let serverRange = 604800;
let currentServer = null;
let currentCluster = null; // cluster the open channel was drilled from (for the back link)
let currentRegion = null;

// Group a region's channels into clusters. `players` sums only online channels;
// `online` counts them; `lastSeen` is the newest last-seen across the cluster
// (used to show "last online" when the whole cluster is down).
function clustersForRegion(region) {
  const map = new Map();
  for (const s of latestData.servers) {
    if (s.region !== region) continue;
    const c = clusterOf(s.name);
    let e = map.get(c);
    if (!e) { e = { cluster: c, region, players: 0, online: 0, lastSeen: 0, channels: [] }; map.set(c, e); }
    if (s.online) { e.players += s.players; e.online++; }
    if (s.lastSeen > e.lastSeen) e.lastSeen = s.lastSeen;
    e.channels.push(s);
  }
  return [...map.values()];
}

function buildServerControls() {
  const rf = $('#region-filter');
  latestData.regions.forEach((r) => {
    const o = el('option', null, r.toUpperCase());
    o.value = r;
    rf.appendChild(o);
  });
  $('#server-search').addEventListener('input', renderServers);
  rf.addEventListener('change', renderServers);
  $('#sort-by').addEventListener('change', renderServers);
}

// Heatmap of server clusters, grouped by region and shaded by current player
// load (relative to the busiest cluster in its region). Click a cluster to drill
// into its channels. Search matches a cluster name or any of its channel names.
function renderServers() {
  const q = $('#server-search').value.trim().toLowerCase();
  const regionFilter = $('#region-filter').value;
  const sortBy = $('#sort-by').value;
  const host = $('#server-map');
  host.innerHTML = '';

  let shown = 0;
  latestData.regions.forEach((region, ri) => {
    if (regionFilter && regionFilter !== region) return;
    const all = clustersForRegion(region);
    let clusters = q
      ? all.filter((c) => c.cluster.toLowerCase().includes(q) || c.channels.some((ch) => ch.name.toLowerCase().includes(q)))
      : all;
    if (clusters.length === 0) return;

    if (sortBy === 'players-desc') clusters = [...clusters].sort((a, b) => b.players - a.players);
    else if (sortBy === 'players-asc') clusters = [...clusters].sort((a, b) => a.players - b.players);
    else clusters = [...clusters].sort((a, b) => a.cluster.localeCompare(b.cluster, undefined, { numeric: true }));

    // Shade relative to the region's busiest cluster so colors stay stable while filtering.
    const max = Math.max(1, ...all.map((c) => c.players));
    const base = colorFor(region, ri);
    const channelCount = all.reduce((a, c) => a + c.channels.length, 0);
    const regionTotal = all.reduce((a, c) => a + c.players, 0);

    const group = el('div', 'map-group');
    const h = el('h3');
    const dot = el('span', 'dot');
    dot.style.background = base;
    h.append(dot, document.createTextNode(region.toUpperCase() + ' '),
      el('span', 'count', `${all.length} clusters · ${channelCount} channels · ${fmtNum(regionTotal)} players`));
    group.appendChild(h);

    const grid = el('div', 'heat cluster-grid');
    clusters.forEach((c) => {
      const cell = el('div', 'heat-cell cluster-cell');
      const offline = c.online === 0; // whole cluster missing from the latest scrape
      const intensity = offline ? '0.10' : (0.15 + 0.75 * (c.players / max)).toFixed(3);
      // Colored layer over a constant dark base so tiles stay legible in both themes.
      cell.style.background = `linear-gradient(${rgba(base, intensity)}, ${rgba(base, intensity)}), #10131b`;
      if (offline) cell.classList.add('offline');
      const sub = offline
        ? `last ${fmtWhen(c.lastSeen)}`
        : c.online < c.channels.length
          ? `${c.online}/${c.channels.length} ch`
          : `${c.channels.length} ch`;
      cell.title = offline
        ? `${c.cluster} - offline, last online ${fmtWhen(c.lastSeen)}`
        : `${c.cluster} - ${c.online}/${c.channels.length} channels online, ${c.players} players`;
      cell.append(
        el('span', 'hn', c.cluster),
        el('span', 'hp', offline ? 'unknown' : fmtNum(c.players)),
        el('span', 'hsub', sub),
      );
      cell.onclick = () => openCluster(c.cluster, region);
      grid.appendChild(cell);
      shown++;
    });
    group.appendChild(grid);
    host.appendChild(group);
  });

  if (shown === 0) host.appendChild(el('div', 'empty', 'no clusters match your filter'));
}

function showModalMode(mode) {
  $('#cluster-body').style.display = mode === 'cluster' ? '' : 'none';
  $('#server-body').style.display = mode === 'server' ? '' : 'none';
}

// Cluster view: a snapshot heatmap of the cluster's channels. Clicking a channel
// drills into its history (openServer with a back link to here).
function openCluster(cluster, region) {
  currentCluster = cluster;
  currentRegion = region;
  currentServer = null;
  if (serverChart) { serverChart.destroy(); serverChart = null; }

  const chans = latestData.servers
    .filter((s) => s.region === region && clusterOf(s.name) === cluster)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const onlineChans = chans.filter((s) => s.online);
  const total = onlineChans.reduce((a, s) => a + s.players, 0);
  const peak = onlineChans.reduce((m, s) => Math.max(m, s.players), 0);
  const max = Math.max(1, peak);
  const base = colorFor(region, latestData.regions.indexOf(region));

  $('#modal-title').textContent = cluster;
  $('#modal-meta').textContent = onlineChans.length === 0
    ? `${region.toUpperCase()} cluster · 0/${chans.length} channels online · last online ${fmtWhen(Math.max(...chans.map((s) => s.lastSeen)))}`
    : `${region.toUpperCase()} cluster · ${onlineChans.length}/${chans.length} channels online · ${fmtNum(total)} players · busiest ${fmtNum(peak)}`;
  $('#modal-back').hidden = true;
  showModalMode('cluster');

  const heat = $('#cluster-heat');
  heat.innerHTML = '';
  chans.forEach((s) => {
    const cell = el('div', 'heat-cell');
    const offline = !s.online;
    const intensity = offline ? '0.10' : (0.15 + 0.75 * (s.players / max)).toFixed(3);
    cell.style.background = `linear-gradient(${rgba(base, intensity)}, ${rgba(base, intensity)}), #10131b`;
    if (offline) cell.classList.add('offline');
    cell.title = offline
      ? `${s.name} - offline, last online ${fmtWhen(s.lastSeen)}`
      : `${s.name} - ${s.players} players`;
    cell.append(el('span', 'hn', s.name), el('span', 'hp', offline ? 'unknown' : fmtNum(s.players)));
    cell.onclick = () => openServer(s.name, s.region, cluster);
    heat.appendChild(cell);
  });

  $('#modal').classList.add('open');
}

// Channel view: its history chart. fromCluster shows a back link to that cluster.
async function openServer(name, region, fromCluster = null) {
  currentServer = name;
  currentRegion = region;
  currentCluster = fromCluster;
  $('#modal-back').hidden = !fromCluster;
  showModalMode('server');
  $('#modal-title').textContent = name;
  $('#modal-meta').textContent = 'loading history…';

  // Host details (capacity + ip:port) from the roster snapshot - available now.
  const entry = latestData.servers.find((x) => x.name === name);
  const bits = [];
  if (entry?.maxPlayers != null) bits.push(`capacity ${fmtNum(entry.maxPlayers)}`);
  if (entry?.host) bits.push(`host ${entry.host}${entry.port ? ':' + entry.port : ''}`);
  $('#server-host').textContent = bits.join('  ·  ');

  $('#modal').classList.add('open');
  renderRangeButtons($('#server-ranges'), serverRange, (sec) => {
    serverRange = sec;
    if (currentServer === name) drawServerChart(window.__serverSeries, region);
  });
  try {
    const data = await getJSON(`./data/servers/${encodeURIComponent(name)}.json`);
    if (currentServer !== name) return; // user opened another one meanwhile
    window.__serverSeries = data;
    const cur = lastValue(data.players);
    const peak = data.players.reduce((m, v) => (v != null && v > m ? v : m), 0);
    const status = entry && !entry.online
      ? `offline · last online ${fmtWhen(entry.lastSeen)}`
      : `current ${fmtNum(cur)}`;
    $('#modal-meta').textContent =
      `${region.toUpperCase()} · ${clusterOf(name)} cluster · ${status} · peak ${fmtNum(peak)} · ${data.t.length} data points`;
    drawServerChart(data, region);
  } catch (e) {
    $('#modal-meta').textContent = 'failed to load history: ' + e.message;
  }
}

function drawServerChart(data, region) {
  const host = $('#server-chart');
  const width = host.clientWidth || 760;
  const [xs, ys] = sliceRange(data.t, [data.players], serverRange);
  const seriesDefs = [
    {},
    {
      label: 'players',
      stroke: colorFor(region, latestData.regions.indexOf(region)),
      fill: 'rgba(110,168,254,0.10)',
      width: 2,
      points: { show: false },
      value: (u, v) => fmtNum(v),
    },
  ];
  if (serverChart) serverChart.destroy();
  serverChart = new uPlot(baseOpts(width, 320, seriesDefs), [xs, ...ys], host);
}

function closeModal() {
  $('#modal').classList.remove('open');
  currentServer = null;
  currentCluster = null;
  currentRegion = null;
  if (serverChart) { serverChart.destroy(); serverChart = null; }
}

/* --------------------------------------------------------------------- Init */

function selectTab(view) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  if (view === 'regions') {
    if (totalChart) totalChart.setSize({ width: $('#total-chart').clientWidth, height: 300 });
    if (regionChart) regionChart.setSize({ width: $('#region-chart').clientWidth, height: 340 });
    if (countChart) countChart.setSize({ width: $('#region-count-chart').clientWidth, height: 240 });
  }
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.onclick = () => selectTab(tab.dataset.view);
  });
}

// Deep links: #servers, #regions, #cluster=<name>, #server=<channel>
function applyHash() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (h.startsWith('cluster=')) {
    const c = h.slice('cluster='.length);
    const s = latestData.servers.find((x) => clusterOf(x.name) === c);
    selectTab('servers');
    if (s) openCluster(c, s.region);
  } else if (h.startsWith('server=')) {
    const name = h.slice('server='.length);
    const s = latestData.servers.find((x) => x.name === name);
    selectTab('servers');
    if (s) openServer(s.name, s.region, clusterOf(name)); // back link to its cluster
  } else if (h === 'servers') {
    selectTab('servers');
  } else {
    selectTab('regions');
  }
}

// The viewer's local IANA timezone (e.g. "America/Chicago"). All chart axes and
// timestamps render in this zone automatically (uPlot uses browser-local time).
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';

function subtitle(meta, latest) {
  if (!meta.lastTs) return 'no data scraped yet - the first scheduled run will populate this.';
  const when = new Date(meta.lastTs * 1000);
  const ago = Math.round((Date.now() - when.getTime()) / 60000);
  const agoStr = ago < 1 ? 'just now' : ago < 60 ? `${ago} min ago` : `${Math.round(ago / 60)} h ago`;
  const clusterCount = new Set(latest.servers.map((s) => clusterOf(s.name))).size;
  return `<b>${fmtNum(latest.grandTotal)}</b> players online in <b>${clusterCount}</b> clusters · ` +
    `updated <b>${agoStr}</b> (${when.toLocaleString()}) · ` +
    `${fmtNum(meta.scrapeCount)} scrapes · times shown in <b>${LOCAL_TZ}</b>`;
}

async function init() {
  try {
    const [meta, latest, regions] = await Promise.all([
      getJSON('./data/meta.json'),
      getJSON('./data/latest.json'),
      getJSON('./data/regions.json'),
    ]);
    latestData = latest;
    regionData = regions;

    $('#subtitle').innerHTML = subtitle(meta, latest);

    if (!meta.lastTs) {
      $('#region-tiles').appendChild(el('div', 'empty', 'waiting for first scrape'));
      return;
    }

    renderRegionTiles(latest);
    renderRangeButtons($('#total-ranges'), totalRange, (sec) => { totalRange = sec; drawTotalChart(); });
    drawTotalChart();
    renderRangeButtons($('#region-ranges'), regionRange, (sec) => { regionRange = sec; drawRegionChart(); });
    drawRegionChart();
    renderRangeButtons($('#count-ranges'), countRange, (sec) => { countRange = sec; drawCountChart(); });
    drawCountChart();

    buildServerControls();
    renderServers();

    setupTabs();
    applyHash();
    $('#modal-close').onclick = closeModal;
    $('#modal-back').onclick = () => { if (currentCluster && currentRegion) openCluster(currentCluster, currentRegion); };
    $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

    let rt;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        if ($('#view-regions').classList.contains('active')) {
          if (totalChart) totalChart.setSize({ width: $('#total-chart').clientWidth, height: 300 });
          if (regionChart) regionChart.setSize({ width: $('#region-chart').clientWidth, height: 340 });
          if (countChart) countChart.setSize({ width: $('#region-count-chart').clientWidth, height: 240 });
        }
        if (serverChart) serverChart.setSize({ width: $('#server-chart').clientWidth, height: 320 });
      }, 120);
    });
  } catch (e) {
    $('#subtitle').textContent = 'failed to load data: ' + e.message;
    console.error(e);
  }
}

init();
