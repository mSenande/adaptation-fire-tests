(function () {
  "use strict";

  var LEFT_BASE_SCENARIO = "none"; // Control
  var RIGHT_BASE_SCENARIO = "carmine_nbs"; // NbS

  // Which scenario is actually showing on each side right now -- either the
  // base scenario above, or a climate variant of it (e.g. "none_SSP5-2050"),
  // picked via the left/right scenario <select>s.
  var leftScenario = LEFT_BASE_SCENARIO;
  var rightScenario = RIGHT_BASE_SCENARIO;

  var map = L.map("map", { zoomControl: true, minZoom: 3 });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors",
    maxZoom: 18,
  }).addTo(map);
  map.setView([41.4, 2.08], 10);

  // L.ImageOverlay positions its <img> with its own CSS transform, unlike a
  // tile layer's container (which stays anchored at the map's pixel origin).
  // leaflet-side-by-side clips whatever DOM element it's given using
  // absolute map-pixel coordinates, which only stays correct across zooms
  // for an element anchored at that origin -- so each side needs its own
  // pane (which IS anchored that way) to clip, rather than the raw <img>.
  map.createPane("sbsLeftPane").style.zIndex = 400;
  map.createPane("sbsRightPane").style.zIndex = 400;
  // Above both swipe panes, and not part of the sideBySide control, so the
  // NbS-area outlines show through on both sides regardless of divider
  // position instead of being clipped along with the raster underneath.
  map.createPane("nbsAreasPane").style.zIndex = 450;
  // Above everything else raster/polygon so the ignition marker & wind
  // arrow are never obscured.
  map.createPane("ignitionPane").style.zIndex = 460;

  // Fixed display order across both event-scoped variables (fire simulation
  // results) and static variables (model inputs, same for every event).
  var VARIABLE_ORDER = ["daily_probability", "flame_length_max", "fbfm40", "cbh", "cc"];

  var leftLayer = null;
  var rightLayer = null;
  var sideBySide = null;
  var nbsAreasLayer = null;
  var nbsAreasGeoJSON = null;
  var ignitionLayer = null;

  var loadingEl = document.getElementById("loading");
  var emptyEl = document.getElementById("empty-state");
  var eventLabel = document.getElementById("event-label");
  var eventSelect = document.getElementById("event-select");
  var leftScenarioLabel = document.getElementById("left-scenario-label");
  var rightScenarioLabel = document.getElementById("right-scenario-label");
  var leftScenarioSelect = document.getElementById("left-scenario-select");
  var rightScenarioSelect = document.getElementById("right-scenario-select");
  var sideLabelLeft = document.querySelector(".side-label-left");
  var sideLabelRight = document.querySelector(".side-label-right");
  var variableToggle = document.getElementById("variable-toggle");
  var overlayToggle = document.getElementById("overlay-toggle");
  var legendTitle = document.getElementById("legend-title");
  var legendGradient = document.getElementById("legend-gradient");
  var legendMin = document.getElementById("legend-min");
  var legendMax = document.getElementById("legend-max");
  var legendBar = document.getElementById("legend-bar");
  var legendSwatches = document.getElementById("legend-swatches");

  var costEffectivenessBtn = document.getElementById("cost-effectiveness-btn");
  var costModalOverlay = document.getElementById("cost-modal-overlay");
  var costModalEvent = document.getElementById("cost-modal-event");
  var costInputAdaptation = document.getElementById("cost-input-adaptation");
  var costInputSuppression = document.getElementById("cost-input-suppression");
  var costInputLoss = document.getElementById("cost-input-loss");
  var costCalculateBtn = document.getElementById("cost-calculate-btn");
  var costModalCloseBtn = document.getElementById("cost-modal-close-btn");
  var costResults = document.getElementById("cost-results");
  var costAdaptationSummary = document.getElementById("cost-adaptation-summary");
  var costResultsTableBody = document.querySelector("#cost-results-table tbody");

  // Order/labels shown even for an event that doesn't have all four (older
  // events have no SSP5-2050 climate variant) -- matches the same
  // base-scenario/climate-variant convention as LEFT_BASE_SCENARIO etc.
  var COST_SCENARIO_FALLBACK_LABELS = {
    "none": "Control",
    "carmine_nbs": "NbS",
    "none_SSP5-2050": "Control — SSP5-8.5 (2050)",
    "carmine_nbs_SSP5-2050": "NbS — SSP5-8.5 (2050)",
  };
  var COST_SCENARIO_KEYS = Object.keys(COST_SCENARIO_FALLBACK_LABELS);

  var manifest = null;
  var currentVariable = null;

  function getVariableSpec(key) {
    return (manifest.variables && manifest.variables[key]) || (manifest.static_variables && manifest.static_variables[key]);
  }

  function isStaticVariable(key) {
    return !!(manifest.static_variables && manifest.static_variables[key]);
  }

  // ---- Click-to-inspect: point values for every variable, both scenarios ----
  // Exact values aren't recoverable from the baked PNG pixels (color+alpha
  // isn't cleanly invertible, especially after clipping/rounding), so this
  // reads a separate compact "query grid" of raw numeric values fetched
  // once per event/static-inputs and cached.

  var queryCache = {}; // path -> Promise<parsed JSON>

  function fetchQuery(path) {
    if (!path) return Promise.resolve(null);
    if (!queryCache[path]) {
      queryCache[path] = fetch(path).then(function (resp) { return resp.json(); });
    }
    return queryCache[path];
  }

  function gridValueIndex(scenarioGrid, lat, lng) {
    var b = scenarioGrid.bounds;
    if (lat < b.south || lat > b.north || lng < b.west || lng > b.east) return null;
    var col = Math.min(Math.floor((lng - b.west) / (b.east - b.west) * scenarioGrid.width), scenarioGrid.width - 1);
    var row = Math.min(Math.floor((b.north - lat) / (b.north - b.south) * scenarioGrid.height), scenarioGrid.height - 1);
    return row * scenarioGrid.width + col;
  }

  function valueFromScenarioGrid(scenarioGrid, varKey, lat, lng) {
    if (!scenarioGrid) return undefined;
    var idx = gridValueIndex(scenarioGrid, lat, lng);
    if (idx === null) return undefined;
    return scenarioGrid.values[varKey][idx];
  }

  function formatPointValue(varKey, rawValue) {
    if (rawValue === null || rawValue === undefined) return "–";
    if (varKey === "fbfm40") {
      var codes = (manifest.static_variables.fbfm40 && manifest.static_variables.fbfm40.codes) || {};
      return codes[String(rawValue)] || ("Code " + rawValue);
    }
    var spec = getVariableSpec(varKey);
    // daily_probability's raw values are a 0-1 fraction; every other "%"
    // variable (canopy cover) is already stored 0-100.
    var value = varKey === "daily_probability" ? rawValue * 100 : rawValue;
    return spec.unit === "%"
      ? (Math.round(value * 10) / 10) + "%"
      : (Math.round(value * 100) / 100) + " " + spec.unit;
  }

  // Popup rows mix event-scoped and static variables, but the left/right
  // scenario picked by the user is a single choice for the whole popup --
  // prefer that scenario's label from the event (if this event has it),
  // falling back to the static-inputs entry (which never has a climate
  // variant) so the header still reads sensibly either way.
  function scenarioLabel(scenarioKey, fallback) {
    var evt = findEvent(eventSelect.value);
    var entry = (evt && evt.scenarios && evt.scenarios[scenarioKey]) ||
      (manifest.static_scenarios && manifest.static_scenarios[scenarioKey]);
    return (entry && entry.label) || fallback;
  }

  // Strips a climate variant suffix (e.g. "none_SSP5-2050" -> "none") so
  // static model inputs -- which only ever vary by Control vs. NbS, never
  // by climate year -- can still be looked up in staticGrid when an SSP
  // scenario is selected.
  function baseScenarioOf(scenarioKey) {
    return [LEFT_BASE_SCENARIO, RIGHT_BASE_SCENARIO].filter(function (base) {
      return scenarioKey === base || scenarioKey.indexOf(base + "_") === 0;
    })[0] || scenarioKey;
  }

  function buildPopupHtml(latlng, eventGrid, staticGrid) {
    var rowsHtml = VARIABLE_ORDER.filter(function (key) { return !!getVariableSpec(key); }).map(function (key) {
      var isStatic = isStaticVariable(key);
      var grid = isStatic ? staticGrid : eventGrid;
      var leftKey = isStatic ? baseScenarioOf(leftScenario) : leftScenario;
      var rightKey = isStatic ? baseScenarioOf(rightScenario) : rightScenario;
      var controlVal = valueFromScenarioGrid(grid && grid[leftKey], key, latlng.lat, latlng.lng);
      var nbsVal = valueFromScenarioGrid(grid && grid[rightKey], key, latlng.lat, latlng.lng);
      return (
        "<tr><th>" + getVariableSpec(key).label + "</th>" +
        "<td>" + formatPointValue(key, controlVal) + "</td>" +
        "<td>" + formatPointValue(key, nbsVal) + "</td></tr>"
      );
    }).join("");

    var leftLabel = scenarioLabel(leftScenario, "Control");
    var rightLabel = scenarioLabel(rightScenario, "NbS");

    return (
      "<div class=\"point-popup\">" +
      "<div class=\"point-popup-coords\">" + latlng.lat.toFixed(4) + ", " + latlng.lng.toFixed(4) + "</div>" +
      "<table><thead><tr><th></th><th>" + leftLabel + "</th><th>" + rightLabel + "</th></tr></thead><tbody>" + rowsHtml + "</tbody></table>" +
      "</div>"
    );
  }

  function onMapClick(e) {
    var popup = L.popup({ maxWidth: 320 }).setLatLng(e.latlng).setContent("Loading…").openOn(map);

    var evt = findEvent(eventSelect.value);
    var eventQueryPath = evt && evt.query_path;

    Promise.all([fetchQuery(eventQueryPath), fetchQuery(manifest.static_query_path)])
      .then(function (results) {
        popup.setContent(buildPopupHtml(e.latlng, results[0], results[1]));
      })
      .catch(function (err) {
        popup.setContent("Failed to load point data: " + err);
      });
  }

  function toLatLngBounds(b) {
    return L.latLngBounds([b.south, b.west], [b.north, b.east]);
  }

  function formatDomainValue(value, unit) {
    if (unit === "%") {
      // Burn probability's domain is a 0-1 fraction (needs *100 to show as
      // a percent); canopy cover's domain is already 0-100 (a percent, not
      // a fraction of one) -- max<=1 is an unambiguous way to tell them
      // apart since these are the only two "%" variables.
      return Math.round(value <= 1 ? value * 100 : value) + "%";
    }
    return value + " " + unit;
  }

  function updateLegend(variableKey) {
    var spec = getVariableSpec(variableKey);
    legendTitle.textContent = spec.label;

    if (spec.legend_type === "swatches") {
      legendGradient.hidden = true;
      legendSwatches.hidden = false;
      legendSwatches.innerHTML = "";
      spec.swatches.forEach(function (sw) {
        var item = document.createElement("span");
        item.className = "legend-swatch";
        var chip = document.createElement("span");
        chip.className = "legend-swatch-chip";
        chip.style.background = sw.color;
        var label = document.createElement("span");
        label.textContent = sw.label;
        item.appendChild(chip);
        item.appendChild(label);
        legendSwatches.appendChild(item);
      });
    } else {
      legendSwatches.hidden = true;
      legendGradient.hidden = false;
      legendMin.textContent = formatDomainValue(spec.domain[0], spec.unit);
      legendMax.textContent = formatDomainValue(spec.domain[1], spec.unit);
      legendBar.style.background = "linear-gradient(to right, " + spec.gradient_stops.join(", ") + ")";
    }
  }

  function findEvent(eventId) {
    for (var i = 0; i < manifest.events.length; i++) {
      if (manifest.events[i].id === eventId) return manifest.events[i];
    }
    return null;
  }

  function clearOverlays() {
    if (leftLayer) { map.removeLayer(leftLayer); leftLayer = null; }
    if (rightLayer) { map.removeLayer(rightLayer); rightLayer = null; }
  }

  function ignitionIcon(bearingDeg) {
    return L.divIcon({
      className: "ignition-icon",
      html:
        '<svg width="56" height="56" viewBox="-28 -28 56 56">' +
          '<g style="transform: rotate(' + bearingDeg + 'deg); transform-origin: 0px 0px;">' +
            '<line x1="0" y1="0" x2="0" y2="-22" stroke="#1f2937" stroke-width="2.5" stroke-linecap="round"/>' +
            '<polygon points="0,-27 -6,-16 6,-16" fill="#1f2937"/>' +
          '</g>' +
          '<circle cx="0" cy="0" r="5" fill="#d32f2f" stroke="#fff" stroke-width="1.5"/>' +
        '</svg>',
      iconSize: [56, 56],
      iconAnchor: [28, 28],
    });
  }

  function updateIgnitionMarker() {
    if (ignitionLayer) { map.removeLayer(ignitionLayer); ignitionLayer = null; }

    var evt = findEvent(eventSelect.value);
    var ign = evt && evt.ignition;
    if (!ign) return;

    ignitionLayer = L.marker([ign.lat, ign.lon], {
      icon: ignitionIcon(ign.wind_arrow_bearing),
      pane: "ignitionPane",
      title: "Ignition point",
    })
      .bindPopup(
        "<b>Ignition point</b><br>" +
        ign.lat.toFixed(4) + ", " + ign.lon.toFixed(4) + "<br>" +
        "Wind from " + Math.round(ign.wind_direction_from) + "° (" + ign.wind_direction_from_compass + ")," +
        " spreading toward " + ign.wind_arrow_bearing_compass
      )
      .addTo(map);
  }

  function render() {
    updateIgnitionMarker();

    var usingStatic = isStaticVariable(currentVariable);
    eventSelect.disabled = usingStatic;
    eventLabel.classList.toggle("disabled", usingStatic);
    eventLabel.title = usingStatic ? "Not applicable to model input layers (same for every event)" : "";

    // Climate variants (e.g. SSP5-8.5 2050) only exist for event-scoped
    // simulations, not for static model inputs -- disable scenario choice
    // while viewing those, same treatment as the event select above.
    leftScenarioSelect.disabled = usingStatic;
    rightScenarioSelect.disabled = usingStatic;
    leftScenarioLabel.classList.toggle("disabled", usingStatic);
    rightScenarioLabel.classList.toggle("disabled", usingStatic);

    var evt = usingStatic ? null : findEvent(eventSelect.value);
    var scenarios = usingStatic ? manifest.static_scenarios : ((evt && evt.scenarios) || {});
    leftScenario = populateScenarioSelect(leftScenarioSelect, scenarios, leftScenario, LEFT_BASE_SCENARIO);
    rightScenario = populateScenarioSelect(rightScenarioSelect, scenarios, rightScenario, RIGHT_BASE_SCENARIO);

    var leftEntry = scenarios[leftScenario];
    var rightEntry = scenarios[rightScenario];
    clearOverlays();

    if (!leftEntry || !rightEntry) {
      console.warn("[carmine-viz] no data for", usingStatic ? "static inputs" : eventSelect.value);
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    sideLabelLeft.textContent = leftEntry.label;
    sideLabelRight.textContent = rightEntry.label;

    var leftBounds = toLatLngBounds(leftEntry.bounds);
    var rightBounds = toLatLngBounds(rightEntry.bounds);

    var pending = 2;
    loadingEl.hidden = false;
    function onLoaded() {
      pending -= 1;
      if (pending <= 0) loadingEl.hidden = true;
    }

    leftLayer = L.imageOverlay(leftEntry.variables[currentVariable], leftBounds, { alt: leftEntry.label, pane: "sbsLeftPane" });
    rightLayer = L.imageOverlay(rightEntry.variables[currentVariable], rightBounds, { alt: rightEntry.label, pane: "sbsRightPane" });
    leftLayer.once("load", onLoaded);
    rightLayer.once("load", onLoaded);
    leftLayer.addTo(map);
    rightLayer.addTo(map);

    if (!sideBySide) {
      sideBySide = L.control.sideBySide(leftLayer, rightLayer).addTo(map);
    } else {
      sideBySide.setLeftLayers(leftLayer);
      sideBySide.setRightLayers(rightLayer);
    }

    map.fitBounds(leftBounds);
    updateLegend(currentVariable);
  }

  function safeRender() {
    try {
      render();
    } catch (err) {
      showError("Error rendering viewer: " + err);
    }
  }

  function buildEventSelect() {
    manifest.events.forEach(function (evt) {
      var opt = document.createElement("option");
      opt.value = evt.id;
      opt.textContent = evt.label + (evt.populated ? "" : " (no data yet)");
      opt.disabled = !evt.populated;
      eventSelect.appendChild(opt);
    });
    var firstPopulated = manifest.events.filter(function (e) { return e.populated; })[0];
    if (firstPopulated) eventSelect.value = firstPopulated.id;
    eventSelect.addEventListener("change", safeRender);
  }

  // Rebuilds a side's <select> with every scenario key available right now
  // (varies per event -- older events have no climate variant), listing all
  // families (Control, NbS, and their climate variants) so either side can
  // show any of them. Preserves `current` if it's still an option; else
  // falls back to its base family (stripping a climate-variant suffix) if
  // that's available, else `defaultKey`, else whatever's first. Returns the
  // value the select ends up showing.
  function populateScenarioSelect(select, scenarios, current, defaultKey) {
    var keys = Object.keys(scenarios);
    select.innerHTML = "";
    keys.forEach(function (key) {
      var opt = document.createElement("option");
      opt.value = key;
      opt.textContent = scenarios[key].label;
      select.appendChild(opt);
    });
    var candidates = [current, baseScenarioOf(current), defaultKey];
    var resolved = candidates.filter(function (key) { return keys.indexOf(key) !== -1; })[0] || keys[0];
    select.value = resolved;
    return resolved;
  }

  function buildScenarioSelects() {
    leftScenarioSelect.addEventListener("change", function () {
      leftScenario = leftScenarioSelect.value;
      safeRender();
    });
    rightScenarioSelect.addEventListener("change", function () {
      rightScenario = rightScenarioSelect.value;
      safeRender();
    });
  }

  function buildVariableToggle() {
    var keys = VARIABLE_ORDER.filter(function (key) { return !!getVariableSpec(key); });
    currentVariable = keys[0];
    keys.forEach(function (key) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = getVariableSpec(key).label;
      btn.setAttribute("aria-pressed", key === currentVariable ? "true" : "false");
      btn.addEventListener("click", function () {
        currentVariable = key;
        Array.prototype.forEach.call(variableToggle.children, function (child) {
          child.setAttribute("aria-pressed", child === btn ? "true" : "false");
        });
        safeRender();
      });
      variableToggle.appendChild(btn);
    });
  }

  function buildOverlayToggle() {
    var overlaySpec = manifest.overlays && manifest.overlays.collserola_pegs;
    if (!overlaySpec) {
      overlayToggle.closest("label").hidden = true;
      return;
    }
    overlayToggle.addEventListener("change", function () {
      if (!overlayToggle.checked) {
        if (nbsAreasLayer) map.removeLayer(nbsAreasLayer);
        return;
      }
      if (nbsAreasGeoJSON) {
        addNbsAreasLayer(nbsAreasGeoJSON);
        return;
      }
      fetch(overlaySpec.path)
        .then(function (resp) { return resp.json(); })
        .then(function (data) {
          nbsAreasGeoJSON = data;
          addNbsAreasLayer(data);
        })
        .catch(function (err) {
          overlayToggle.checked = false;
          showError("Failed to load NbS intervention areas: " + err);
        });
    });
  }

  function addNbsAreasLayer(geojson) {
    nbsAreasLayer = L.geoJSON(geojson, {
      pane: "nbsAreasPane",
      style: { color: "#8e24aa", weight: 2, fillColor: "#8e24aa", fillOpacity: 0.15 },
    }).addTo(map);
  }

  function formatEuro(value) {
    return "€" + Math.round(value).toLocaleString();
  }

  function calculateCostEffectiveness() {
    var adaptationRate = parseFloat(costInputAdaptation.value);
    var suppressionCost = parseFloat(costInputSuppression.value);
    var economicLoss = parseFloat(costInputLoss.value);
    if (!isFinite(adaptationRate) || !isFinite(suppressionCost) || !isFinite(economicLoss)) {
      window.alert("Enter a number in all three fields.");
      return;
    }

    var evt = findEvent(eventSelect.value);
    costModalEvent.textContent = evt ? evt.label : eventSelect.value;

    var nbsAreaHa = manifest.overlays && manifest.overlays.collserola_pegs && manifest.overlays.collserola_pegs.area_ha;
    if (nbsAreaHa) {
      var adaptationCost = adaptationRate * nbsAreaHa * 10;
      costAdaptationSummary.textContent =
        "Adaptation cost over 10 years (NbS intervention area: " + nbsAreaHa.toFixed(1) + " ha): " + formatEuro(adaptationCost);
    } else {
      costAdaptationSummary.textContent = "NbS intervention area unavailable -- can't estimate adaptation cost.";
    }

    costResultsTableBody.innerHTML = "";
    COST_SCENARIO_KEYS.forEach(function (key) {
      var scenario = evt && evt.scenarios && evt.scenarios[key];
      var label = (scenario && scenario.label) || COST_SCENARIO_FALLBACK_LABELS[key];
      var row = document.createElement("tr");
      if (scenario && typeof scenario.expected_burned_area_ha === "number") {
        var burnedAreaHa = scenario.expected_burned_area_ha;
        var economicCost = (suppressionCost + economicLoss) * burnedAreaHa;
        row.innerHTML =
          "<td>" + label + "</td>" +
          "<td>" + burnedAreaHa.toFixed(1) + "</td>" +
          "<td>" + formatEuro(economicCost) + "</td>";
      } else {
        row.innerHTML = "<td>" + label + "</td><td>No data</td><td>No data</td>";
      }
      costResultsTableBody.appendChild(row);
    });

    costResults.hidden = false;
  }

  function buildCostEffectiveness() {
    costEffectivenessBtn.addEventListener("click", function () {
      costResults.hidden = true;
      costModalOverlay.hidden = false;
    });
    costModalCloseBtn.addEventListener("click", function () {
      costModalOverlay.hidden = true;
    });
    costModalOverlay.addEventListener("click", function (e) {
      if (e.target === costModalOverlay) costModalOverlay.hidden = true;
    });
    costCalculateBtn.addEventListener("click", calculateCostEffectiveness);
  }

  function showError(message) {
    loadingEl.hidden = true;
    emptyEl.hidden = false;
    emptyEl.textContent = message;
  }

  fetch("manifest.json")
    .then(function (resp) { return resp.json(); })
    .catch(function (err) {
      showError("Failed to load manifest.json: " + err);
      throw err; // stop the chain below from also running
    })
    .then(function (data) {
      manifest = data;
      console.log("[carmine-viz] manifest loaded:", manifest);
      buildEventSelect();
      buildScenarioSelects();
      buildVariableToggle();
      buildOverlayToggle();
      buildCostEffectiveness();
      map.on("click", onMapClick);
      render();
    })
    .catch(function (err) {
      if (manifest) showError("Error rendering viewer: " + err);
    });
})();
