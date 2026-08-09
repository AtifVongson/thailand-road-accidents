/* Slide 14c's map — a second, independent MapLibre instance (item 3, the
 * re-applied WHERE/WHEN split, redesigned as three scroll-driven acts rather
 * than two static lists). Same rule as map-tab3.js: progress is a scalar in
 * [0, 1] from scroll position, camera and paint are a function of it, jumpTo
 * only, no flyTo/easeTo.
 *
 * The 14 excess-risk sections have no coordinates in the source data (route
 * + province + km marker only) — assets/data/slide14c_sections.json
 * province-anchors each one against real roads.json/provinces.json geometry.
 * Both that file and slide14c_when.json are built by
 * analysis/scripts/15_build_slide14c.py; nothing here computes a statistic,
 * this module only draws numbers it is handed.
 *
 * The anchor is honest to "this route, this province," not to the exact km
 * marker — 15_build_slide14c.py places it by walking the real route
 * geometry: one point on the line for a section alone in its province,
 * several sections in the same (route, province) spread across the real
 * path in km order. That spread is why every anchor sits within a metre of
 * the drawn line (the first version averaged coordinates instead, which put
 * two Bangkok-area anchors 9-11km off the road — averaging points on a
 * curve does not land on the curve) and why six Route 7 / Chon Buri
 * sections read as six distinct points strung along ~33km of the corridor
 * once the camera drills in, not one point wearing a count badge.
 *
 * Act 1 (p < 1/3): national frame, provinces faded back, dots fade in
 * coloured by excess ratio. Act 2 ([1/3, 2/3)): camera drills into the
 * Route 7/9 corridor, dots recolour by route category, Routes 7 and 9 draw
 * in full — real geometry, not illustration — each carrying a simplified
 * route-number shield (white/black, no Garuda emblem — reproducing the
 * actual government emblem isn't attempted here). Act 3 ([2/3, 1]): map
 * holds Act 2's state; nothing in the WHEN figures is spatial, so nothing
 * on the map pretends to animate for it, and the panel carries the three
 * multipliers instead. */
(function () {
  "use strict";

  var THAI = [97.2, 5.5, 105.8, 20.6];
  var ROUTE_CODE = { 7: "0007", 9: "0009" };
  var clamp = function (x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  function smoothstep(t) { var x = clamp(t, 0, 1); return x * x * (3 - 2 * x); }
  function seg(p, a, b) { return smoothstep((p - a) / (b - a)); }

  var P1 = 1 / 3, P2 = 2 / 3;
  var A2 = function (f) { return P1 + (P2 - P1) * f; };   // fraction through act 2

  var mapEl = document.getElementById("map14c");
  if (!mapEl) return;

  var map = new maplibregl.Map({
    container: "map14c",
    style: { version: 8, sources: {}, layers: [
      { id: "bg14c", type: "background", paint: { "background-color": "#fcfcfb" } },
    ] },
    bounds: THAI, fitBoundsOptions: { padding: 30 },
    scrollZoom: false, dragPan: false, dragRotate: false, doubleClickZoom: false,
    touchZoomRotate: false, keyboard: false,
    attributionControl: { customAttribution:
      "Geometry: ArcGIS DOH/DRR &amp; GADM 4.1 (geography only) &middot; Figures: Datasource/ 2021-2025" },
  });

  Promise.all([
    fetch("assets/data/roads.json").then(function (r) { return r.json(); }),
    fetch("assets/data/provinces.json").then(function (r) { return r.json(); }),
    fetch("assets/data/slide14c_sections.json").then(function (r) { return r.json(); }),
    fetch("assets/data/slide14c_when.json").then(function (r) { return r.json(); }),
    new Promise(function (res) { map.on("load", res); }),
  ]).then(function (loaded) {
    var roads = loaded[0], prov = loaded[1];
    var sections = loaded[2].sections, when = loaded[3];

    map.addSource("prov14c", { type: "geojson", data: prov });
    map.addLayer({ id: "prov14c-fill", type: "fill", source: "prov14c", paint: {
      "fill-color": "#d8d6cd", "fill-opacity": 0.95,
    } });
    map.addLayer({ id: "prov14c-line", type: "line", source: "prov14c", paint: {
      "line-color": "#b3b0a4",
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.6, 7, 1, 11, 1.6],
      "line-opacity": 0.9,
    } });

    var route79 = { type: "FeatureCollection", features: roads.features.filter(function (f) {
      return f.properties.agency === "ทล." &&
        (f.properties.code === ROUTE_CODE[7] || f.properties.code === ROUTE_CODE[9]);
    }) };
    map.addSource("route79", { type: "geojson", data: route79 });
    map.addLayer({ id: "route79-line", type: "line", source: "route79",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#eb6834",
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.4, 7, 2.6, 11, 5],
        "line-opacity": 0,
      } });

    var dotsGeo = { type: "FeatureCollection", features: sections.map(function (s) {
      return { type: "Feature", geometry: { type: "Point", coordinates: [s.lng, s.lat] },
        properties: s };
    }) };
    map.addSource("dots14c", { type: "geojson", data: dotsGeo });

    // Two layers, same points: rank-coloured (Act 1) and category-coloured
    // (Act 2/3), crossfaded by opacity rather than tweening a colour
    // property across two heterogeneous scales.
    var radiusExpr = ["interpolate", ["linear"], ["get", "ratio"], 1.6, 5, 12.9, 15];
    map.addLayer({ id: "dots-rank", type: "circle", source: "dots14c", paint: {
      "circle-radius": radiusExpr,
      "circle-color": ["interpolate", ["linear"], ["get", "ratio"],
        1.6, "#f9b697", 5, "#eb6834", 9, "#c74e20", 12.9, "#5c210d"],
      "circle-opacity": 0,
      "circle-stroke-width": 1, "circle-stroke-color": "#fcfcfb",
    } });
    map.addLayer({ id: "dots-category", type: "circle", source: "dots14c", paint: {
      "circle-radius": radiusExpr,
      "circle-color": ["match", ["get", "category"],
        "motorway", "#eb6834", "ordinary", "#52514e", "#52514e"],
      "circle-opacity": 0,
      "circle-stroke-width": 1, "circle-stroke-color": "#fcfcfb",
    } });

    /* The drill-down camera. cameraForBounds does the projection maths, so
     * the target is derived from the route geometry actually loaded rather
     * than from a hardcoded box that would silently drift if roads.json were
     * ever re-exported. Both cameras are plain {center, zoom} and every
     * frame between them is a lerp — the same shape map-tab3.js uses. */
    var CAM_NATIONAL = { center: [map.getCenter().lng, map.getCenter().lat], zoom: map.getZoom() };
    var b = new maplibregl.LngLatBounds();
    route79.features.forEach(function (f) {
      f.geometry.coordinates.forEach(function (c) { b.extend(c); });
    });
    var fitted = map.cameraForBounds(b, { padding: 48 });
    var CAM_ROUTE79 = fitted
      ? { center: [fitted.center.lng, fitted.center.lat], zoom: fitted.zoom }
      : CAM_NATIONAL;

    // Route-number shields, one per route, at the midpoint (by vertex
    // index) of that route's longest single segment feature — a label
    // position, not a data claim, so it doesn't need the anchor script's
    // arc-length precision. Simplified white/black shield, no Garuda
    // emblem: reproducing the actual government road-sign artwork isn't
    // attempted here (sourced from en.wikipedia.org/wiki/Road_signs_in_Thailand
    // and wiki.aaroads.com/wiki/Road_signs_in_Thailand — white shield,
    // Garuda emblem, black route number is the real design; this keeps
    // only the white/black/route-number part). A MapLibre Marker, not a
    // symbol layer: the style carries no glyphs URL on purpose (a venue
    // with no network still has to render this map), and Marker keeps
    // itself positioned through the camera move without a projection loop
    // of our own.
    function shieldEl(number) {
      var el = document.createElement("div");
      el.className = "route-shield";
      el.innerHTML =
        '<svg width="30" height="36" viewBox="0 0 30 36" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<path d="M2,4 Q2,1 5,1 L25,1 Q28,1 28,4 L28,16 Q28,27 15,35 Q2,27 2,16 Z" ' +
        'fill="#fcfcfb" stroke="#26251f" stroke-width="2"/>' +
        '<text x="15" y="19" text-anchor="middle" font-weight="800" font-size="14" fill="#26251f">' +
        number + '</text></svg>';
      el.setAttribute("aria-label", "Route " + number);
      el.style.opacity = 0;
      return el;
    }
    var shields = [7, 9].map(function (route) {
      var feats = route79.features.filter(function (f) {
        return f.properties.code === ROUTE_CODE[route];
      });
      var longest = feats.reduce(function (a, b) {
        return b.geometry.coordinates.length > a.geometry.coordinates.length ? b : a;
      }, feats[0]);
      var mid = longest.geometry.coordinates[Math.floor(longest.geometry.coordinates.length / 2)];
      var el = shieldEl(route);
      new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat(mid).addTo(map);
      return el;
    });

    var caption = document.getElementById("map14c-caption");
    var motorwayN = sections.filter(function (s) { return s.category === "motorway"; }).length;
    var ordinaryN = sections.length - motorwayN;

    function rankList() {
      return sections.map(function (s) {
        return "<li><b>#" + s.rank + "</b> Route " + s.route + " &middot; " + s.province +
          " &middot; km " + Math.round(s.km) +
          " <span class=\"ratio\">" + s.ratio.toFixed(1) + "&times; expected</span></li>";
      }).join("");
    }

    function whenBars() {
      var max = Math.max.apply(null, when.bars.map(function (x) { return x.multiple; }));
      return when.bars.map(function (x) {
        return "<div class=\"wb-row\">" +
          "<div class=\"wb-head\"><span class=\"wb-name\">" + x.label + "</span>" +
          "<span class=\"wb-mult\">" + x.multiple.toFixed(1) + "&times;</span></div>" +
          "<div class=\"wb-track\"><div class=\"wb-bar " + x.key + "\" style=\"width:" +
          (100 * x.multiple / max).toFixed(1) + "%\"></div></div>" +
          "<div class=\"wb-detail\">" + x.detail + "</div></div>";
      }).join("");
    }

    var ACT1 = "<h3>Fourteen sections, ranked</h3>" +
      "<p>These are the sections crashing furthest above what their own traffic volume " +
      "predicts &mdash; not the busiest roads on the network, the ones most overshooting " +
      "their own baseline.</p>" +
      "<ol class=\"rank-list\">" + rankList() + "</ol>";

    var ACT2 = "<h3>Eleven of fourteen, two routes</h3>" +
      "<p>The map has drilled into the Route 7 and Route 9 corridor &mdash; Bangkok out to " +
      "the eastern seaboard. Both are motorway-grade: higher speed, higher volume, drawn " +
      "here in full.</p>" +
      "<div class=\"stat-row\"><span class=\"dot motorway\"></span>" + motorwayN +
      " of 14 on Routes 7/9 (motorway)</div>" +
      "<div class=\"stat-row\"><span class=\"dot ordinary\"></span>" + ordinaryN +
      " of 14 on Routes 1/4 (ordinary highway)</div>" +
      "<p class=\"note\">Six of the eleven are all Route 7 in Chon Buri &mdash; strung out " +
      "along roughly 33km of the corridor by their km marker, not stacked in one place. The " +
      ordinaryN + " ordinary-highway sections sit outside this frame &mdash; Tak and Nakhon " +
      "Sawan to the north, Phetchaburi to the south-west.</p>" +
      "<p class=\"note\">A different pattern from the choropleth two screens up: deaths per " +
      "crash run highest in the north-east &mdash; 6 of the 10 highest-rate provinces, led " +
      "by Mukdahan at 29.0 per 100 crashes &mdash; while these fourteen sections sit on the " +
      "eastern seaboard and the north-south trunk roads instead.</p>";

    var ACT3 = "<h3>When to staff it</h3>" +
      "<p>None of this is where &mdash; it's when. Three timescales, each one a peak " +
      "against its own quiet baseline:</p>" +
      "<div class=\"when-bars\">" + whenBars() + "</div>" +
      "<ul class=\"when-list\">" +
      "<li><b>Daily</b> &mdash; crashes peak late afternoon, deaths around 19:00.</li>" +
      "<li><b>Monthly</b> &mdash; April needs roughly 1.9&times; the checkpoint staffing " +
      "that September needs.</li>" +
      "<li><b>Seasonal</b> &mdash; during the Seven Dangerous Days (Songkran/New Year), " +
      "staffing should surge to roughly 3.1&times; normal.</li>" +
      "</ul>" +
      "<p class=\"note\">" + when.baseline_note + "</p>";

    caption.innerHTML = ACT1;

    var lastAct = 0;
    function applyState(p) {
      var dotsIn = seg(p, 0, P1 * 0.7);
      var provFade = 1 - 0.85 * seg(p, 0, P1 * 0.5);
      var catBlend = seg(p, P1 * 0.85, A2(0.4));
      var routeIn = seg(p, P1 * 0.9, A2(0.4));
      var drill = seg(p, P1 * 0.95, A2(0.55));
      var shieldIn = seg(p, A2(0.3), A2(0.7));

      map.jumpTo({
        center: [lerp(CAM_NATIONAL.center[0], CAM_ROUTE79.center[0], drill),
                 lerp(CAM_NATIONAL.center[1], CAM_ROUTE79.center[1], drill)],
        zoom: lerp(CAM_NATIONAL.zoom, CAM_ROUTE79.zoom, drill),
      });

      map.setPaintProperty("prov14c-fill", "fill-opacity", 0.95 * provFade);
      map.setPaintProperty("prov14c-line", "line-opacity", 0.9 * provFade);
      map.setPaintProperty("dots-rank", "circle-opacity", dotsIn * (1 - catBlend));
      map.setPaintProperty("dots-category", "circle-opacity", dotsIn * catBlend);
      map.setPaintProperty("route79-line", "line-opacity", routeIn * 0.85);
      shields.forEach(function (el) { el.style.opacity = shieldIn; });

      var act = p < P1 ? 0 : (p < P2 ? 1 : 2);
      if (act !== lastAct) {
        caption.innerHTML = act === 0 ? ACT1 : (act === 1 ? ACT2 : ACT3);
        lastAct = act;
      }
    }
    applyState(0);

    var section = document.getElementById("map14c-scroll");
    function tick() {
      var r = section.getBoundingClientRect();
      var p = ChartLayout.progressFor(r.top, r.height, window.innerHeight);
      applyState(p);
    }
    addEventListener("scroll", tick, { passive: true });
    addEventListener("resize", tick);
    tick();
  });
})();
