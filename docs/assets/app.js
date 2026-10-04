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
const MA_COLOR = '#f0a848'; // 24h moving-average trend line
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
          // A series may override what the tooltip shows via s.tt(u, idx) -> {v, text};
          // used by the stacked composition chart to report per-region share rather
          // than the cumulative value it actually plots.
          const cell = s.tt ? s.tt(u, idx) : { v: u.data[i][idx], text: fmtNum(u.data[i][idx]) };
          const stroke = typeof s.stroke === 'function' ? s.stroke(u, i) : s.stroke;
          rows +=
            `<div class="t-row${cell.v == null ? ' dim' : ''}">` +
            `<span class="dot" style="background:${stroke}"></span>` +
            `<span class="t-lbl">${s.label}</span>` +
            `<span class="t-val">${cell.v == null ? '–' : cell.text}</span></div>`;
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
// Shared region filter: null = show all; otherwise isolate this one region across
// every region-broken-down chart (players, channels, share). Clicking a region in
// any of those legends sets it; clicking the active one again clears it.
let regionFilter = null;

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

// Average total players for each hour of the local day, with the busiest and
// slowest hour. Outage slots (everything at 0) are skipped so downtime doesn't
// pass itself off as a slow hour.
function hourlyTotals() {
  const { t, total } = regionData;
  const sum = new Array(24).fill(0), cnt = new Array(24).fill(0);
  for (let i = 0; i < t.length; i++) {
    const v = total[i];
    if (v == null || v === 0) continue; // no data / outage
    const h = new Date(t[i] * 1000).getHours(); // viewer-local hour
    sum[h] += v;
    cnt[h]++;
  }
  const avg = sum.map((s, h) => (cnt[h] ? s / cnt[h] : null));
  let peak = null, low = null;
  avg.forEach((v, h) => {
    if (v == null) return;
    if (peak === null || v > avg[peak]) peak = h;
    if (low === null || v < avg[low]) low = h;
  });
  return { avg, peak, low };
}

// One-line summary above the total chart: when a typical day peaks and bottoms
// out, in the viewer's local time. Sits with the chart it describes rather than
// in its own tile, since it is a property of the curve below it.
function renderHourSummary() {
  const wrap = $('#total-hours');
  wrap.innerHTML = '';
  const { avg, peak, low } = hourlyTotals();
  if (peak === null) return;
  const part = (label, hour) => {
    const s = el('span', 'hour-stat');
    s.append(
      document.createTextNode(label + ' '),
      el('b', null, fmtHour(hour)),
      document.createTextNode(` (${fmtNum(Math.round(avg[hour]))})`),
    );
    return s;
  };
  wrap.append(part('Busiest', peak), part('Slowest', low));
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

// Trailing 24h moving average of `vals` along timestamps `t`. Outage points
// (value 0) are excluded so a stretch of downtime doesn't drag the trend down
// for a full day afterward - the line tracks the underlying player-base trend
// beneath the daily peak/trough cycle.
function movingAvg24(t, vals) {
  const out = new Array(t.length).fill(null);
  let lo = 0, sum = 0, cnt = 0;
  for (let i = 0; i < t.length; i++) {
    if (vals[i] > 0) { sum += vals[i]; cnt++; }
    while (t[lo] <= t[i] - 86400) { if (vals[lo] > 0) { sum -= vals[lo]; cnt--; } lo++; }
    out[i] = cnt ? Math.round(sum / cnt) : null;
  }
  return out;
}

// Static legend for the total chart (Total players + 24h average).
function renderTotalLegend() {
  const wrap = $('#total-legend');
  wrap.innerHTML = '';
  const item = (color, label) => {
    const it = el('div', 'item');
    const dot = el('span', 'dot');
    dot.style.background = color;
    it.append(dot, document.createTextNode(label));
    return it;
  };
  wrap.append(item(TOTAL_COLOR, 'Total players'), item(MA_COLOR, '24h average'));
}

// Combined total: every server/channel summed into one series over time, with a
// 24h moving-average trend line overlaid.
function drawTotalChart() {
  const host = $('#total-chart');
  const width = host.clientWidth || 800;
  const ma = movingAvg24(regionData.t, regionData.total);
  const [xs, ys] = sliceRange(regionData.t, [regionData.total, ma], totalRange);
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
    {
      label: '24h average',
      stroke: MA_COLOR,
      width: 2,
      dash: [6, 4],
      points: { show: false },
      value: (u, v) => fmtNum(v),
    },
  ];
  if (totalChart) totalChart.destroy();
  totalChart = new uPlot(baseOpts(width, 300, seriesDefs), [xs, ...ys], host);
}

// Generic multi-series region timeseries (players OR server counts). Respects the
// shared regionFilter, hiding the other regions when one is isolated.
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
      show: !regionFilter || r === regionFilter,
      value: (u, v) => fmtNum(v),
    });
  });
  return new uPlot(baseOpts(width, height, seriesDefs), [xs, ...ys], host);
}

// Region legend. Clicking a region isolates it (filters to just that region)
// across every region chart; clicking the active one again clears the filter.
function buildRegionLegend(wrap, valuesByRegion) {
  wrap.innerHTML = '';
  regionData.regions.forEach((r, i) => {
    const item = el('div', 'item');
    const dot = el('span', 'dot');
    dot.style.background = colorFor(r, i);
    const label = el('span', null, r.toUpperCase() + ' ');
    const val = el('b', null, fmtNum(lastValue(valuesByRegion[r] || [])));
    item.append(dot, label, val);
    if (regionFilter && regionFilter !== r) item.classList.add('off');
    if (regionFilter === r) item.classList.add('active');
    item.onclick = () => setRegionFilter(regionFilter === r ? null : r);
    wrap.appendChild(item);
  });
}

// Apply the current filter everywhere: toggle series on the players + channels
// charts, redraw the composition chart, and refresh all three legends.
function setRegionFilter(r) {
  regionFilter = r;
  regionData.regions.forEach((reg, i) => {
    const show = !regionFilter || reg === regionFilter;
    if (regionChart) regionChart.setSeries(i + 1, { show });
    if (countChart) countChart.setSeries(i + 1, { show });
  });
  buildRegionLegend($('#region-legend'), regionData.series);
  buildRegionLegend($('#region-count-legend'), regionData.counts);
  if (compositionChart) drawCompositionChart();
  buildCompositionLegend();
}

function drawRegionChart() {
  if (regionChart) regionChart.destroy();
  regionChart = buildRegionChart($('#region-chart'), regionData.series, regionRange, 340);
  buildRegionLegend($('#region-legend'), regionData.series);
}

function drawCountChart() {
  if (countChart) countChart.destroy();
  countChart = buildRegionChart($('#region-count-chart'), regionData.counts, countRange, 240);
  buildRegionLegend($('#region-count-legend'), regionData.counts);
}

/* ------------------------------------------------------------------- Trends */

let compositionChart = null;
let compositionRange = null; // default: all history (composition is a long-term view)
const fmtHour = (h) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
// Compact hour label for the axis: 12a, 6a, 12p, 6p.
const fmtHourShort = (h) => (h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? h + 'a' : h - 12 + 'p');

// Average players per region for each hour of the local day. Outage slots (whole
// grid at 0) are skipped so downtime doesn't distort the typical-day picture.
function hourlyByRegion() {
  const { regions, t, series, total } = regionData;
  const sum = {}, cnt = {};
  for (const r of regions) { sum[r] = new Array(24).fill(0); cnt[r] = new Array(24).fill(0); }
  for (let i = 0; i < t.length; i++) {
    if (total[i] === 0) continue; // outage
    const h = new Date(t[i] * 1000).getHours(); // viewer-local hour
    for (const r of regions) {
      const v = series[r][i];
      if (v != null) { sum[r][h] += v; cnt[r][h]++; }
    }
  }
  const avg = {};
  for (const r of regions) avg[r] = sum[r].map((s, h) => (cnt[r][h] ? s / cnt[r][h] : null));
  return avg;
}

// Heatmap: region rows x 24 local-hour columns, each row shaded by its own peak
// hour so the active window of each region is visible regardless of its size.
// Each row's busiest hour is outlined and its peak time + avg spelled out at the
// row end, so "when is this region most active" reads without hovering.
function renderActivityMap() {
  const host = $('#activity-map');
  host.innerHTML = '';
  const { regions } = regionData;
  const avg = hourlyByRegion();

  const grid = el('div', 'activity-grid');
  grid.appendChild(el('div', 'act-corner'));
  for (let h = 0; h < 24; h++) grid.appendChild(el('div', 'act-hour', h % 6 === 0 ? fmtHourShort(h) : ''));
  grid.appendChild(el('div', 'act-hour act-peak-head', 'peak'));

  regions.forEach((r, ri) => {
    const row = avg[r];
    let peakH = -1, peakV = -1;
    row.forEach((v, h) => { if (v != null && v > peakV) { peakV = v; peakH = h; } });
    const max = Math.max(1, peakV);
    const base = colorFor(r, ri);

    const name = el('div', 'act-name');
    const dot = el('span', 'dot');
    dot.style.background = base;
    name.append(dot, document.createTextNode(r.toUpperCase()));
    grid.appendChild(name);

    for (let h = 0; h < 24; h++) {
      const v = row[h];
      const cell = el('div', 'act-cell');
      if (v == null) {
        cell.classList.add('empty');
      } else {
        // Gamma > 1 dims the quiet hours hard while peaks stay bright, so the
        // active window pops. Low floor keeps near-empty hours nearly dark.
        const intensity = (0.02 + 0.98 * Math.pow(v / max, 2.4)).toFixed(3);
        cell.style.background = `linear-gradient(${rgba(base, intensity)}, ${rgba(base, intensity)}), #10131b`;
        if (h === peakH) cell.classList.add('peak');
        cell.dataset.tip = `${r.toUpperCase()} · ${fmtHour(h)} · avg ${fmtNum(Math.round(v))} players`;
      }
      grid.appendChild(cell);
    }

    const callout = el('div', 'act-peak');
    if (peakH >= 0) {
      callout.append(
        el('span', 'act-peak-t', fmtHour(peakH)),
        el('span', 'act-peak-v', fmtNum(Math.round(peakV))),
      );
    }
    grid.appendChild(callout);
  });
  host.appendChild(grid);

  // Instant tooltip - the native `title` attribute has a ~1s hover delay.
  const tip = el('div', 'cell-tip');
  host.appendChild(tip);
  const place = (e) => {
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > window.innerWidth) x = e.clientX - w - pad;
    if (y + h > window.innerHeight) y = e.clientY - h - pad;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  };
  grid.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.act-cell');
    if (!cell || !cell.dataset.tip) { tip.classList.remove('on'); return; }
    tip.textContent = cell.dataset.tip;
    tip.classList.add('on');
    place(e);
  });
  grid.addEventListener('mousemove', (e) => { if (tip.classList.contains('on')) place(e); });
  grid.addEventListener('mouseout', (e) => {
    const to = e.relatedTarget;
    if (!to || !to.closest || !to.closest('.act-cell')) tip.classList.remove('on');
  });
}

// 100% stacked area of each region's share of the total, over time. Rendered by
// plotting cumulative shares and painting the largest area first so smaller ones
// overpaint it into stacked bands (uPlot has no native stacking). The tooltip
// reports each region's own share via s.tt, not the cumulative value plotted.
function drawCompositionChart() {
  const host = $('#composition-chart');
  const width = host.clientWidth || 800;
  const { regions, t, series, total } = regionData;

  const share = regions.map(() => new Array(t.length).fill(null));
  const cum = regions.map(() => new Array(t.length).fill(null));
  for (let i = 0; i < t.length; i++) {
    if (!total[i]) continue; // outage / no data -> gap
    let acc = 0;
    regions.forEach((r, ri) => {
      const pct = (series[r][i] || 0) / total[i] * 100;
      share[ri][i] = pct;
      acc += pct;
      cum[ri][i] = acc;
    });
  }

  // Slice both cumulative (plotted for the stack) and raw share (tooltip) to range.
  const [xs, cumS] = sliceRange(t, cum, compositionRange);
  const [, shareS] = sliceRange(t, share, compositionRange);

  const seriesDefs = [{}];
  const cols = [xs];
  const ttFor = (ri) => (u, idx) => {
    const v = shareS[ri][idx];
    return { v, text: v == null ? null : v.toFixed(0) + '%' };
  };
  if (regionFilter) {
    // Isolated: just this region's share as an area (0..its %), not the stack.
    const ri = regions.indexOf(regionFilter);
    seriesDefs.push({
      label: regionFilter.toUpperCase(),
      stroke: colorFor(regionFilter, ri),
      fill: rgba(colorFor(regionFilter, ri), 0.18),
      width: 2,
      points: { show: false },
      tt: ttFor(ri),
    });
    cols.push(shareS[ri]);
  } else {
    // Largest cumulative (last region) drawn first = bottom; earlier regions
    // overpaint on top. Series order is reversed for that reason.
    regions.map((_, i) => i).reverse().forEach((ri) => {
      const r = regions[ri];
      seriesDefs.push({
        label: r.toUpperCase(),
        stroke: colorFor(r, ri),
        fill: colorFor(r, ri),
        width: 1,
        points: { show: false },
        tt: ttFor(ri),
      });
      cols.push(cumS[ri]);
    });
  }

  const opts = baseOpts(width, 300, seriesDefs);
  opts.scales = { x: { time: true }, y: { range: [0, 100] } };
  opts.axes[1].values = (u, splits) => splits.map((v) => v + '%');
  if (compositionChart) compositionChart.destroy();
  compositionChart = new uPlot(opts, cols, host);
}

// Clickable, mirrors the shared region filter (same as the region legends).
function buildCompositionLegend() {
  const wrap = $('#composition-legend');
  wrap.innerHTML = '';
  regionData.regions.forEach((r, i) => {
    const item = el('div', 'item');
    const dot = el('span', 'dot');
    dot.style.background = colorFor(r, i);
    item.append(dot, document.createTextNode(r.toUpperCase()));
    if (regionFilter && regionFilter !== r) item.classList.add('off');
    if (regionFilter === r) item.classList.add('active');
    item.onclick = () => setRegionFilter(regionFilter === r ? null : r);
    wrap.appendChild(item);
  });
}

function drawTrends() {
  renderActivityMap();
  drawCompositionChart();
  buildCompositionLegend();
}

/* ------------------------------------------------------------------ Servers */

let latestData = null;
let serverChart = null;
let serverRange = 604800;
let clusterChart = null;
let clusterRange = 604800;
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
// Cluster activity over time: the cluster's channels summed per timestamp. Only
// timestamps the build kept as complete (regionData.t) are summed, so partial
// scrapes don't create false dips - matching the smoothing used everywhere else.
async function loadClusterActivity(cluster, region, chans) {
  window.__clusterSeries = null;
  $('#cluster-chart').innerHTML = '';
  if (clusterChart) { clusterChart.destroy(); clusterChart = null; }
  const completeTs = new Set(regionData.t);
  const files = await Promise.all(
    chans.map((s) => getJSON(`./data/servers/${encodeURIComponent(s.name)}.json`).catch(() => null)),
  );
  if (currentCluster !== cluster || currentServer) return; // switched away meanwhile
  const sumByTs = new Map();
  for (const f of files) {
    if (!f) continue;
    for (let i = 0; i < f.t.length; i++) {
      const t = f.t[i], v = f.players[i];
      if (v == null || !completeTs.has(t)) continue;
      sumByTs.set(t, (sumByTs.get(t) || 0) + v);
    }
  }
  const t = [...sumByTs.keys()].sort((a, b) => a - b);
  window.__clusterSeries = { t, players: t.map((ts) => sumByTs.get(ts)) };
  drawClusterChart(region);
}

function drawClusterChart(region) {
  const data = window.__clusterSeries;
  if (!data) return;
  const host = $('#cluster-chart');
  const width = host.clientWidth || 760;
  const [xs, ys] = sliceRange(data.t, [data.players], clusterRange);
  const color = colorFor(region, latestData.regions.indexOf(region));
  const seriesDefs = [
    {},
    { label: 'players', stroke: color, fill: rgba(color, 0.12), width: 2, points: { show: false }, value: (u, v) => fmtNum(v) },
  ];
  if (clusterChart) clusterChart.destroy();
  clusterChart = new uPlot(baseOpts(width, 200, seriesDefs), [xs, ...ys], host);
}

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
  $('#modal').classList.add('open');

  // Activity chart above the channel list (async: pulls each channel's history).
  renderRangeButtons($('#cluster-ranges'), clusterRange, (sec) => {
    clusterRange = sec;
    if (currentCluster === cluster && !currentServer) drawClusterChart(region);
  });
  loadClusterActivity(cluster, region, chans);

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
  if (clusterChart) { clusterChart.destroy(); clusterChart = null; }
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
  if (view === 'trends' && compositionChart) {
    compositionChart.setSize({ width: $('#composition-chart').clientWidth, height: 300 });
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
  } else if (h === 'trends') {
    selectTab('trends');
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
    renderHourSummary();
    renderTotalLegend();
    renderRangeButtons($('#total-ranges'), totalRange, (sec) => { totalRange = sec; drawTotalChart(); });
    drawTotalChart();
    renderRangeButtons($('#region-ranges'), regionRange, (sec) => { regionRange = sec; drawRegionChart(); });
    drawRegionChart();
    renderRangeButtons($('#count-ranges'), countRange, (sec) => { countRange = sec; drawCountChart(); });
    drawCountChart();

    renderRangeButtons($('#composition-ranges'), compositionRange, (sec) => { compositionRange = sec; drawCompositionChart(); });
    drawTrends();

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
        if ($('#view-trends').classList.contains('active') && compositionChart) {
          compositionChart.setSize({ width: $('#composition-chart').clientWidth, height: 300 });
        }
        if (serverChart) serverChart.setSize({ width: $('#server-chart').clientWidth, height: 320 });
        if (clusterChart) clusterChart.setSize({ width: $('#cluster-chart').clientWidth, height: 200 });
      }, 120);
    });
  } catch (e) {
    $('#subtitle').textContent = 'failed to load data: ' + e.message;
    console.error(e);
  }
}

init();
