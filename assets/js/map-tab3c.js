/* Slide 14c's map — a second, independent MapLibre instance (item 3, the
 * re-applied WHERE/WHEN split, redesigned as three scroll-driven acts rather
 * than two static lists). Same rule as map-tab3.js: progress is a scalar in
 * [0, 1] from scroll position, camera and paint are a function of it, jumpTo
 * only, no flyTo/easeTo. The camera itself never moves here — the whole
 * story (Tak to the eastern seaboard) fits in one national frame, so there
 * is nothing to pan to.
 *
 * The 14 excess-risk sections have no coordinates in the source data (route
 * + province + km marker only) — assets/data/slide14c_sections.json
 * province-anchors each one against real roads.json/provinces.json geometry
 * (see scripts/ for how; computed once, not at runtime). The anchor is
 * honest to "this route, this province," not to the exact km marker, which
 * is why it's stated as text and not implied by pin placement. Six of the
 * fourteen share one anchor (all "Route 7, Chon Buri") — that collision is
 * the finding, not a bug, and is why no on-map labels are attempted; the
 * ranked list lives in the text panel instead.
 *
 * Act 1 (p < 1/3): national map, faded/desaturated, dots fade in coloured
 * by excess ratio. Act 2 ([1/3, 2/3)): dots recolour by route category
 * (motorway 7/9 vs ordinary 1/4), Routes 7 and 9 draw in full — real
 * geometry, not illustration. Act 3 ([2/3, 1]): map holds Act 2's state;
 * nothing in the WHEN figures is spatial, so nothing on the map pretends to
 * animate for it. */
(function () {
  "use strict";

  var THAI = [97.2, 5.5, 105.8, 20.6];
  var ROUTE_CODE = { 7: "0007", 9: "0009" };
  var clamp = function (x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; };
  function smoothstep(t) { var x = clamp(t, 0, 1); return x * x * (3 - 2 * x); }
  function seg(p, a, b) { return smoothstep((p - a) / (b - a)); }

  var P1 = 1 / 3, P2 = 2 / 3;

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
    new Promise(function (res) { map.on("load", res); }),
  ]).then(function (loaded) {
    var roads = loaded[0], prov = loaded[1], sections = loaded[2].sections;

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

    var ACT1 = "<h3>Fourteen sections, ranked</h3>" +
      "<p>These are the sections crashing furthest above what their own traffic volume " +
      "predicts &mdash; not the busiest roads on the network, the ones most overshooting " +
      "their own baseline.</p>" +
      "<ol class=\"rank-list\">" + rankList() + "</ol>";

    var ACT2 = "<h3>Eleven of fourteen, two routes</h3>" +
      "<p>Route 7 and Route 9 are motorway-grade &mdash; higher speed, higher volume, drawn " +
      "in full at right. Route 1 and Route 4 carry the rest as ordinary highway.</p>" +
      "<div class=\"stat-row\"><span class=\"dot motorway\"></span>" + motorwayN +
      " of 14 on Routes 7/9 (motorway)</div>" +
      "<div class=\"stat-row\"><span class=\"dot ordinary\"></span>" + ordinaryN +
      " of 14 on Routes 1/4 (ordinary highway)</div>" +
      "<p class=\"note\">A different pattern from the choropleth two screens up: deaths per " +
      "crash run highest in the north-east &mdash; 6 of the 10 highest-rate provinces, led " +
      "by Mukdahan at 29.0 per 100 crashes &mdash; while these fourteen sections sit on the " +
      "eastern seaboard and the north-south trunk roads instead.</p>";

    var ACT3 = "<h3>When to staff it</h3>" +
      "<p>None of this is where &mdash; it's when. Three timescales, one recommendation: " +
      "match capacity to when crashes actually happen.</p>" +
      "<ul class=\"when-list\">" +
      "<li><b>Daily</b> &mdash; evening/night peak, around 19:00.</li>" +
      "<li><b>Monthly</b> &mdash; April needs roughly 1.9&times; the checkpoint staffing " +
      "that September needs.</li>" +
      "<li><b>Seasonal</b> &mdash; during the Seven Dangerous Days (Songkran/New Year), " +
      "staffing should surge to roughly 3.1&times; normal.</li>" +
      "</ul>";

    caption.innerHTML = ACT1;

    var lastAct = 0;
    function applyState(p) {
      var dotsIn = seg(p, 0, P1 * 0.7);
      var provFade = 1 - 0.85 * seg(p, 0, P1 * 0.5);
      var catBlend = seg(p, P1 * 0.85, P1 + (P2 - P1) * 0.4);
      var routeIn = seg(p, P1 * 0.9, P1 + (P2 - P1) * 0.4);

      map.setPaintProperty("prov14c-fill", "fill-opacity", 0.95 * provFade);
      map.setPaintProperty("prov14c-line", "line-opacity", 0.9 * provFade);
      map.setPaintProperty("dots-rank", "circle-opacity", dotsIn * (1 - catBlend));
      map.setPaintProperty("dots-category", "circle-opacity", dotsIn * catBlend);
      map.setPaintProperty("route79-line", "line-opacity", routeIn * 0.85);

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
