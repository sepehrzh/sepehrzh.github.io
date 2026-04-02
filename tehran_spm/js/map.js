// ----------------------
// GLOBAL STATE
// ----------------------
let breaksData = {};

let currentAttribute = "NACH";
let currentMethod = "equal_interval";
let currentClasses = 9;


// ----------------------
// ATTRIBUTE CONFIG
// ----------------------

const attributes = {
  "NACH_400": "Normalized Angular Choice - 400m",
  "NACH_1200": "Normalized Angular Choice - 1200m",
  "NACH_5000": "Normalized Angular Choice - 5km",
  "NACH_10000": "Normalized Angular Choice - 10km",
  "NACH_20000": "Normalized Angular Choice - 20km",
  "NACH_40000": "Normalized Angular Choice - 40km",
  "NACH": "Normalized Angular Choice - Global Scale",

  "NAIN_400": "Normalized Angular Integration - 400m",
  "NAIN_1200": "Normalized Angular Integration - 1200m",
  "NAIN_5000": "Normalized Angular Integration - 5km",
  "NAIN_10000": "Normalized Angular Integration - 10km",
  "NAIN_20000": "Normalized Angular Integration - 20km",
  "NAIN_40000": "Normalized Angular Integration - 40km",
  "NAIN": "Normalized Angular Integration - Global Scale"
};


// ----------------------
// LOAD BREAKS JSON FIRST
// ----------------------

fetch('map_data/classification.json')
  .then(res => {
    console.log("FETCH STATUS:", res.status);
    return res.json();
  })
  .then(data => {
    console.log("JSON LOADED:", data);
    breaksData = data;
    initializeMap();
  })
  .catch(err => {
    console.error("FETCH ERROR:", err);
  });


// ----------------------
// HELPER FUNCTIONS
// ----------------------

function getBins(attribute, method, classes) {
  const key = `${method}_${classes}_classes`;

  if (!breaksData[attribute]) {
    console.error("Missing attribute:", attribute);
    return null;
  }

  if (!breaksData[attribute][key]) {
    console.error("Missing key:", key);
    return null;
  }

  return breaksData[attribute][key].bins;
}


function getColorExpression(attribute, method, classes) {

  const bins = getBins(attribute, method, classes);

  if (!bins) {
    console.warn("Fallback style used");
    return ["get", attribute];
  }

  const colors = [
    "#2c7bb6", "#00a6ca", "#00ccbc", "#90eb9d",
    "#ffffbf", "#fee090", "#fdae61",
    "#f46d43", "#d73027", "#a50026"
  ];

  const selectedColors = colors.slice(0, bins.length + 1);

  let expression = ["step", ["get", attribute], selectedColors[0]];

  for (let i = 0; i < bins.length; i++) {
    expression.push(bins[i]);
    expression.push(selectedColors[i + 1]);
  }

  return expression;
}


// ----------------------
// INITIALIZE MAP
// ----------------------

function initializeMap() {

  const map = new maplibregl.Map({
    container: 'map',

    style: {
      version: 8,

      sources: {
        osm: {
          type: "raster",
          tiles: [
            "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
            "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
            "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png"
          ],
          tileSize: 256
        },

        tehran_syntax: {
          type: "vector",
          tiles: [
            "https://api.mappinest.com/tiles/sepehrzh.tehran/{z}/{x}/{y}.pbf?key=85e95e21-5ca7-406a-b61d-c84225615e45"
          ],
          minzoom: 0,
          maxzoom: 18
        }
      },

      layers: [

        {
          id: "osm",
          type: "raster",
          source: "osm",
          paint: {
            "raster-saturation": -1,
            "raster-contrast": 0.1,
            "raster-brightness-min": 0.2
          }
        },

        {
          id: "syntax-lines",
          type: "line",
          source: "tehran_syntax",
          "source-layer": "tehran_spm_reprojected_geopandas",

          paint: {
            "line-color": getColorExpression(currentAttribute, currentMethod, currentClasses),
            "line-width": 4,
            "line-opacity": 0.9
          }
        }

      ]
    },

    center: [51.3347, 35.7219],
    zoom: 10
  });


  // ----------------------
  // UI + INTERACTIONS
  // ----------------------

  map.on('load', () => {

    const attributeSelect = document.getElementById('attributeSelect');
    const methodSelect = document.getElementById('methodSelect');
    const classSelect = document.getElementById('classSelect');

    // Populate attribute dropdown
    for (const key in attributes) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = attributes[key];
      attributeSelect.appendChild(option);
    }

    // Set defaults
    attributeSelect.value = currentAttribute;
    methodSelect.value = currentMethod;
    classSelect.value = currentClasses;

    // Update function
    function updateMapStyle() {
      map.setPaintProperty(
        'syntax-lines',
        'line-color',
        getColorExpression(currentAttribute, currentMethod, currentClasses)
      );
    }

    // Event listeners
    attributeSelect.addEventListener('change', (e) => {
      currentAttribute = e.target.value;
      updateMapStyle();
    });

    methodSelect.addEventListener('change', (e) => {
      currentMethod = e.target.value;
      updateMapStyle();
    });

    classSelect.addEventListener('change', (e) => {
      currentClasses = parseInt(e.target.value);
      updateMapStyle();
    });

    // Attribution (required)
    map.addControl(new maplibregl.AttributionControl({
      compact: true
    }));

  });

}
