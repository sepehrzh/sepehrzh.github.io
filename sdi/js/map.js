/* ─────────────────────────────────────────────────────────────────────────────
   SDI Tehran Dashboard · map.js
   MapLibre GL JS v3.6.2 · Chart.js radar · bivariate choropleth
───────────────────────────────────────────────────────────────────────────── */

'use strict';

// ── GCS ASSETS ──────────────────────────────────────────────────────────────
const GCS_BASE       = 'https://storage.googleapis.com/sdi-tehran-assets/data/outputs';
const HEX_URL        = `${GCS_BASE}/hex.geojson`;
const CLASS_URL      = `${GCS_BASE}/classification.json`;

// ── COLOUR PALETTES ──────────────────────────────────────────────────────────

// Sequential 5-class: low (cream/green) → high (deep rust/dark)
// Warm ochre Tehran palette — diverges from standard YlOrRd
const UNI_COLORS = [
  '#e8dfc8',  // 1 — very low
  '#d4b87a',  // 2
  '#b8864e',  // 3
  '#8c5430',  // 4
  '#4a1e10',  // 5 — very high
];

// KMeans 12-class palette — muted, distinguishable
const TYPOLOGY_COLORS = [
  '#4e79a7','#f28e2b','#e15759','#76b7b2',
  '#59a14f','#edc948','#b07aa1','#ff9da7',
  '#9c755f','#bab0ac','#aecbbb','#d4a6c8',
];

// 3×3 bivariate matrix: rows = var1 (1→3), cols = var2 (1→3)
// Classic Stevens/Brewer bivariate — blue/orange
const BV_MATRIX = [
  ['#e8e8e8', '#b5c4d5', '#6494c0'],  // var1=1, var2=1,2,3
  ['#d4b07a', '#a89d8a', '#6e8ca0'],  // var1=2
  ['#b85c20', '#8c5840', '#4a3c5c'],  // var1=3
];

// ── STATE ────────────────────────────────────────────────────────────────────
let map;
let classificationData = null;
let radarChart = null;
let hoveredHexId = null;
let hoverDebounce = null;
let typologyVisible = false;

// ── COLLAPSED ATTRIBUTES ─────────────────────────────────────────────────────
const COLLAPSED_VARS = new Set(['score_dilap_index_class', 'score_landuse_class']);

// ── VARIABLE META ─────────────────────────────────────────────────────────────
const VAR_LABELS = {
  sdi_class:                'SDI',
  score_policy_era_class:   'Policy era',
  score_mean_area_class:    'Plot area',
  score_perimeter_class:    'Perimeter',
  score_mean_pop_class:     'Population',
  score_dilap_index_class:  'Dilapidation',
  score_landuse_class:      'Land use',
  whole_CH_2:               'Typology',
};

// Radar fields (raw score, not _class)
const RADAR_FIELDS = [
  { key: 'score_policy_era',   label: 'Policy era' },
  { key: 'score_dilap_index',  label: 'Dilapidation' },
  { key: 'score_landuse',      label: 'Land use' },
  { key: 'score_mean_area',    label: 'Plot area' },
  { key: 'score_perimeter',    label: 'Perimeter' },
  { key: 'score_mean_pop',     label: 'Population' },
];

// ── HELPERS ──────────────────────────────────────────────────────────────────

// Map sdi_class 1-5 → bivariate tier 1-3
function toBivTier(classVal) {
  const v = Number(classVal);
  if (v <= 2) return 1;
  if (v === 3) return 2;
  return 3;
}

// Build a MapLibre step expression for a 5-class _class field
// class values are 1..5 integers already stored in the geojson
function stepExprClass(field, colors) {
  return [
    'step', ['get', field],
    colors[0],
    2, colors[1],
    3, colors[2],
    4, colors[3],
    5, colors[4],
  ];
}

// Build step for whole_CH_2 (0..11)
function stepExprTypology(field, colors) {
  const expr = ['step', ['get', field], colors[0]];
  for (let i = 1; i < 12; i++) expr.push(i, colors[i]);
  return expr;
}

// Build bivariate fill-color expression
function bivariateExpr(var1Field, var2Field) {
  // For each tier combo, return the matrix colour
  // We use nested match expressions
  // var1 tier: remap 1→1, 2→2, 3-5→3 then 4→3 5→3
  // simpler: use case expression

  const tierExpr = (field) => [
    'case',
    ['<=', ['get', field], 2], 1,
    ['==', ['get', field], 3], 2,
    3
  ];

  const colours = [];
  for (let r = 1; r <= 3; r++) {
    for (let c = 1; c <= 3; c++) {
      colours.push([r, c, BV_MATRIX[r - 1][c - 1]]);
    }
  }

  // Build nested case
  const expr = ['case'];
  for (const [r, c, col] of colours) {
    expr.push(
      ['all',
        ['==', tierExpr(var1Field), r],
        ['==', tierExpr(var2Field), c],
      ],
      col
    );
  }
  expr.push('#cccccc'); // fallback
  return expr;
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  // Load classification.json
  try {
    const res = await fetch(CLASS_URL);
    classificationData = await res.json();
  } catch (e) {
    console.warn('Could not load classification.json:', e);
  }

  // Init map
  map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(),
    center: [51.38, 35.72],
    zoom: 9.5,
    attributionControl: false,
  });

  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  map.on('load', onMapLoad);
}

// ── DESATURATED OSM STYLE ─────────────────────────────────────────────────────
function buildStyle() {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
        maxzoom: 19,
      }
    },
    layers: [
      {
        id: 'osm-tiles',
        type: 'raster',
        source: 'osm',
        paint: {
          'raster-saturation': -0.85,
          'raster-brightness-min': 0.05,
          'raster-brightness-max': 0.55,
          'raster-contrast': -0.1,
          'raster-opacity': 0.7,
        }
      }
    ]
  };
}

// ── MAP LOAD ──────────────────────────────────────────────────────────────────
function onMapLoad() {
  // Add hex source
  map.addSource('hexes', {
    type: 'geojson',
    data: HEX_URL,
    promoteId: 'h3index',
  });

  // ── HEX FILL — univariate default ─────────────────────────────────────────
  map.addLayer({
    id: 'hex-fill',
    type: 'fill',
    source: 'hexes',
    paint: {
      'fill-color': stepExprClass('sdi_class', UNI_COLORS),
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        0.75,
        0.5
      ],
    },
  });

  // ── HEX BORDER ────────────────────────────────────────────────────────────
  map.addLayer({
    id: 'hex-border',
    type: 'line',
    source: 'hexes',
    paint: {
      'line-color': '#0f0f13',
      'line-width': 0.4,
      'line-opacity': 0.5,
    },
  });

  // ── TYPOLOGY CLUSTER FILL (hidden by default) ─────────────────────────────
  map.addLayer({
    id: 'hex-typology',
    type: 'fill',
    source: 'hexes',
    paint: {
      'fill-color': stepExprTypology('whole_CH_2', TYPOLOGY_COLORS),
      'fill-opacity': 0.55,
    },
    layout: { visibility: 'none' },
  });

  // ── HOVER INTERACTION ─────────────────────────────────────────────────────
  map.on('mousemove', 'hex-fill', onHexHover);
  map.on('mouseleave', 'hex-fill', onHexLeave);
  map.on('click', 'hex-fill', onHexClick);

  map.getCanvas().style.cursor = '';
  map.on('mouseenter', 'hex-fill', () => { map.getCanvas().style.cursor = 'crosshair'; });
  map.on('mouseleave', 'hex-fill', () => { map.getCanvas().style.cursor = ''; });

  // ── BUILD LEGEND ──────────────────────────────────────────────────────────
  buildUnivariateLegend(UNI_COLORS, 'Low disparity', 'High disparity');

  // ── CONTROLS ──────────────────────────────────────────────────────────────
  document.getElementById('select-var1').addEventListener('change', onVarChange);
  document.getElementById('select-var2').addEventListener('change', onVarChange);
  document.getElementById('cb-typology').addEventListener('change', onTypologyToggle);

  // ── RADAR INIT ────────────────────────────────────────────────────────────
  initRadar();
}

// ── VARIABLE CHANGE ───────────────────────────────────────────────────────────
function onVarChange() {
  const var1 = document.getElementById('select-var1').value;
  const var2 = document.getElementById('select-var2').value;

  // Show collapsed warning if either selected var is collapsed
  const warning = document.getElementById('collapsed-warning');
  const v1Collapsed = COLLAPSED_VARS.has(var1);
  const v2Collapsed = var2 && COLLAPSED_VARS.has(var2);
  warning.hidden = !(v1Collapsed || v2Collapsed);

  if (var2) {
    // Bivariate mode
    applyBivariate(var1, var2);
  } else {
    // Univariate
    applyUnivariate(var1);
  }
}

function applyUnivariate(field) {
  let colorExpr, endpointLow, endpointHigh;

  if (field === 'whole_CH_2') {
    colorExpr = stepExprTypology('whole_CH_2', TYPOLOGY_COLORS);
    endpointLow = 'Cluster 0';
    endpointHigh = 'Cluster 11';
  } else {
    colorExpr = stepExprClass(field, UNI_COLORS);
    endpointLow = 'Low';
    endpointHigh = 'High';
  }

  map.setPaintProperty('hex-fill', 'fill-color', colorExpr);

  document.getElementById('legend-univariate').hidden = false;
  document.getElementById('legend-bivariate').hidden = true;

  if (field === 'whole_CH_2') {
    buildTypologyLegend();
  } else {
    buildUnivariateLegend(UNI_COLORS, endpointLow, endpointHigh);
  }
}

function applyBivariate(var1, var2) {
  const expr = bivariateExpr(var1, var2);
  map.setPaintProperty('hex-fill', 'fill-color', expr);

  document.getElementById('legend-univariate').hidden = true;
  document.getElementById('legend-bivariate').hidden = false;
  document.getElementById('bv-label-x').textContent = `→ ${VAR_LABELS[var1] || var1}`;
  document.getElementById('bv-label-y').textContent = `↑ ${VAR_LABELS[var2] || var2}`;

  drawBivariateLegend();
}

// ── LEGEND BUILDERS ───────────────────────────────────────────────────────────
function buildUnivariateLegend(colors, labelLow, labelHigh) {
  const container = document.getElementById('legend-swatches');
  container.innerHTML = '';
  colors.forEach(c => {
    const div = document.createElement('div');
    div.className = 'swatch';
    div.style.background = c;
    container.appendChild(div);
  });
  const eps = document.querySelectorAll('.legend-endpoints span');
  if (eps[0]) eps[0].textContent = labelLow;
  if (eps[1]) eps[1].textContent = labelHigh;
}

function buildTypologyLegend() {
  const container = document.getElementById('legend-swatches');
  container.innerHTML = '';
  TYPOLOGY_COLORS.forEach(c => {
    const div = document.createElement('div');
    div.className = 'swatch';
    div.style.background = c;
    div.style.flex = 'none';
    div.style.width = '18px';
    container.appendChild(div);
  });
  const eps = document.querySelectorAll('.legend-endpoints span');
  if (eps[0]) eps[0].textContent = 'Cluster 0';
  if (eps[1]) eps[1].textContent = 'Cluster 11';
}

function drawBivariateLegend() {
  const canvas = document.getElementById('bivariate-legend-canvas');
  const ctx = canvas.getContext('2d');
  const size = 45;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      ctx.fillStyle = BV_MATRIX[r][c];
      // draw from bottom-left: row 0 at bottom
      ctx.fillRect(c * size, (2 - r) * size, size - 1, size - 1);
    }
  }
}

// ── TYPOLOGY TOGGLE ───────────────────────────────────────────────────────────
function onTypologyToggle(e) {
  typologyVisible = e.target.checked;
  map.setLayoutProperty('hex-typology', 'visibility', typologyVisible ? 'visible' : 'none');
}

// ── HOVER ─────────────────────────────────────────────────────────────────────
function onHexHover(e) {
  clearTimeout(hoverDebounce);
  hoverDebounce = setTimeout(() => {
    if (!e.features || !e.features.length) return;
    const feature = e.features[0];
    const id = feature.id;

    if (hoveredHexId !== null && hoveredHexId !== id) {
      map.setFeatureState({ source: 'hexes', id: hoveredHexId }, { hover: false });
    }
    hoveredHexId = id;
    map.setFeatureState({ source: 'hexes', id }, { hover: true });

    const props = feature.properties;
    updateRadar(props);
    updateHexInfo(props);
  }, 80);
}

function onHexLeave() {
  clearTimeout(hoverDebounce);
  if (hoveredHexId !== null) {
    map.setFeatureState({ source: 'hexes', id: hoveredHexId }, { hover: false });
    hoveredHexId = null;
  }
  // Don't reset radar on leave — keep last hovered hex shown
}

function onHexClick(e) {
  if (!e.features || !e.features.length) return;
  const props = e.features[0].properties;
  updateRadar(props);
  updateHexInfo(props);
  document.getElementById('section-hexinfo').hidden = false;
}

// ── RADAR ─────────────────────────────────────────────────────────────────────
function initRadar() {
  const ctx = document.getElementById('radar-canvas').getContext('2d');
  radarChart = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: RADAR_FIELDS.map(f => f.label),
      datasets: [{
        data: RADAR_FIELDS.map(() => 0),
        backgroundColor: 'rgba(200, 169, 110, 0.15)',
        borderColor: 'rgba(200, 169, 110, 0.8)',
        borderWidth: 1.5,
        pointBackgroundColor: 'rgba(200, 169, 110, 0.9)',
        pointRadius: 3,
        pointHoverRadius: 4,
      }]
    },
    options: {
      responsive: false,
      animation: { duration: 120 },
      scales: {
        r: {
          min: 0,
          max: 1,
          ticks: {
            display: false,
            stepSize: 0.25,
          },
          grid: {
            color: 'rgba(88, 88, 112, 0.35)',
            lineWidth: 0.8,
          },
          angleLines: {
            color: 'rgba(88, 88, 112, 0.35)',
            lineWidth: 0.8,
          },
          pointLabels: {
            color: '#9994a8',
            font: {
              family: "'IBM Plex Mono', monospace",
              size: 9,
            },
          },
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e1e26',
          borderColor: '#2c2c38',
          borderWidth: 1,
          titleColor: '#c8a96e',
          bodyColor: '#9994a8',
          titleFont: { family: "'IBM Plex Mono', monospace", size: 10 },
          bodyFont:  { family: "'IBM Plex Mono', monospace", size: 10 },
          callbacks: {
            label: ctx => ` ${ctx.formattedValue}`,
          }
        }
      }
    }
  });
}

function updateRadar(props) {
  document.getElementById('radar-placeholder').style.display = 'none';
  const values = RADAR_FIELDS.map(f => {
    const v = parseFloat(props[f.key]);
    return isNaN(v) ? 0 : Math.round(v * 100) / 100;
  });
  radarChart.data.datasets[0].data = values;
  radarChart.update('none');
}

// ── HEX INFO DL ───────────────────────────────────────────────────────────────
function updateHexInfo(props) {
  const dl = document.getElementById('hex-dl');
  const fields = [
    ['SDI',         props.sdi        ? parseFloat(props.sdi).toFixed(3) : '—'],
    ['Class',       props.sdi_class  || '—'],
    ['n segs',      props.n_segments || '—'],
    ['Policy era',  props.score_policy_era ? parseFloat(props.score_policy_era).toFixed(3) : '—'],
    ['Plot area',   props.score_mean_area  ? parseFloat(props.score_mean_area).toFixed(3)  : '—'],
    ['Perimeter',   props.score_perimeter  ? parseFloat(props.score_perimeter).toFixed(3)  : '—'],
    ['Population',  props.score_mean_pop   ? parseFloat(props.score_mean_pop).toFixed(3)   : '—'],
    ['Typology',    props.whole_CH_2 !== undefined ? props.whole_CH_2 : '—'],
  ];
  dl.innerHTML = fields.map(([k, v]) =>
    `<dt>${k}</dt><dd>${v}</dd>`
  ).join('');
  document.getElementById('section-hexinfo').hidden = false;
}

// ── MOBILE PANEL TOGGLE ───────────────────────────────────────────────────────
function initMobileToggle() {
  const btn     = document.getElementById('panel-toggle');
  const panel   = document.getElementById('panel');
  const overlay = document.getElementById('map-overlay');

  function openPanel() {
    panel.classList.add('panel-open');
    overlay.classList.add('active');
    btn.textContent = '✕';
  }

  function closePanel() {
    panel.classList.remove('panel-open');
    overlay.classList.remove('active');
    btn.textContent = '☰';
  }

  btn.addEventListener('click', () => {
    panel.classList.contains('panel-open') ? closePanel() : openPanel();
  });

  overlay.addEventListener('click', closePanel);
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  init();
  initMobileToggle();
});