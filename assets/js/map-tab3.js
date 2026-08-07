/* Slide 14's map — one MapLibre instance, two framed states on one canvas
 * (ticket 09): C, the national choropleth, establishes where deaths
 * concentrate; scrolling into the pinned section moves the camera into the
 * north-east and fades in A, the road network + fatal crashes.
 *
 * Not part of assets/js/layout.js — MapLibre expressions and camera calls
 * are not pure-layout-testable the way SVG geometry is, so this stays a
 * small hand-rolled script instead of a fifth layout.js chart. It still
 * follows the same rule everything else on the site follows: progress is a
 * scalar in [0, 1] derived from scroll position, camera and paint are a
 * function of it, and nothing moves on its own clock (no flyTo/easeTo,
 * which animate on a timer — jumpTo only). scrollZoom/dragPan stay off so
 * the wheel scrolls the *page* — that's what drives the transition — until
 * "Explore" is pressed for Q&A.
 */
(function () {
  "use strict";

  var ORANGE = ["#fde3d6", "#f9b697", "#f4855a", "#eb6834", "#c74e20", "#923615", "#5c210d"];
  var nf = function (n) { return (+n).toLocaleString("en-US"); };
  var clamp = function (x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  function smoothstep(t) { var x = clamp(t, 0, 1); return x * x * (3 - 2 * x); }
  function fadeOutHalf(p) { return clamp(1 - 2 * p, 0, 1); }   // C: gone by the midpoint
  function fadeInHalf(p) { return clamp(2 * p - 1, 0, 1); }    // A: starts at the midpoint

  var THAI = [97.2, 5.5, 105.8, 20.6];
  var CAM_A = { center: [102.8, 16.0], zoom: 7.4 };            // validated shot: NOTES.md 8.3, "A_zoomed_northeast"

  var mapEl = document.getElementById("map");
  if (!mapEl) return;

  var map = new maplibregl.Map({
    container: "map",
    style: { version: 8, sources: {}, layers: [
      { id: "bg", type: "background", paint: { "background-color": "#fcfcfb" } },
    ] },
    bounds: THAI, fitBoundsOptions: { padding: 40 },
    scrollZoom: false, dragPan: false, dragRotate: false, doubleClickZoom: false,
    touchZoomRotate: false, keyboard: false,
    attributionControl: { customAttribution:
      "Geometry: ArcGIS DOH/DRR &amp; GADM 4.1 (geography only) &middot; Figures: Datasource/ 2021-2025" },
  });

  var CAM_C = null; // read off the fitBounds result once the style has loaded

  Promise.all([
    fetch("assets/data/roads.json").then(function (r) { return r.json(); }),
    fetch("assets/data/fatal_points.json").then(function (r) { return r.json(); }),
    fetch("assets/data/provinces.json").then(function (r) { return r.json(); }),
    new Promise(function (res) { map.on("load", res); }),
  ]).then(function (loaded) {
    var roads = loaded[0], fatal = loaded[1], prov = loaded[2];
    CAM_C = { center: [map.getCenter().lng, map.getCenter().lat], zoom: map.getZoom() };

    map.addSource("roads", { type: "geojson", data: roads });
    map.addSource("fatal", { type: "geojson", data: fatal });
    map.addSource("prov", { type: "geojson", data: prov });

    // C — province choropleth, deaths per 100 crashes, quantile stops over
    // the real distribution (crash data is skewed; even spacing would leave
    // almost every province in the first colour band).
    var rates = prov.features.map(function (f) { return f.properties.death_rate; }).sort(function (a, b) { return a - b; });
    var q = function (p) { return rates[Math.floor(p * (rates.length - 1))]; };
    map.addLayer({ id: "prov-fill", type: "fill", source: "prov", paint: {
      "fill-color": ["interpolate", ["linear"], ["get", "death_rate"],
        q(0), ORANGE[0], q(0.25), ORANGE[1], q(0.5), ORANGE[2],
        q(0.75), ORANGE[3], q(0.9), ORANGE[4], q(1), ORANGE[5]],
      "fill-opacity": 0.95,
    } });
    // Province borders are the constant skeleton under both states.
    map.addLayer({ id: "prov-line", type: "line", source: "prov", paint: {
      "line-color": "#9b9890",
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.8, 7, 1.3, 11, 2.2],
      "line-opacity": 0.95,
    } });

    // A — road network + fatal crashes. Rural first, national on top, so the
    // trunk network is never hidden by a local road.
    map.addLayer({ id: "road-rural", type: "line", source: "roads",
      filter: ["==", ["get", "agency"], "ทช."],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#9ec5f4",
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.25, 7, 0.7, 11, 1.8, 14, 3],
        "line-opacity": 0,
      } });
    map.addLayer({ id: "road-main", type: "line", source: "roads",
      filter: ["==", ["get", "agency"], "ทล."],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#184f95",
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.65, 7, 1.6, 11, 4.5, 14, 8],
        "line-opacity": 0,
      } });
    map.addLayer({ id: "road-hit", type: "line", source: "roads",
      paint: { "line-color": "#000", "line-opacity": 0, "line-width": 14 } });
    map.addLayer({ id: "fatal-dot", type: "circle", source: "fatal", paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"],
        4, ["interpolate", ["linear"], ["get", "d"], 1, 1.7, 5, 4],
        8, ["interpolate", ["linear"], ["get", "d"], 1, 3.2, 5, 8.5],
        13, ["interpolate", ["linear"], ["get", "d"], 1, 6, 5, 19]],
      "circle-color": ["interpolate", ["linear"], ["get", "d"],
        1, "#eb6834", 2, "#dc5a28", 4, "#923615", 6, "#5c210d"],
      "circle-opacity": 0,
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 4, 0.6, 9, 1],
      "circle-stroke-color": "#fcfcfb",
    } });

    var legend = document.getElementById("map-legend");
    var caption = document.getElementById("map-caption");
    legend.innerHTML =
      '<div class="t">Deaths per 100 crashes</div>' +
      '<div class="map-ramp" style="background:linear-gradient(90deg,' + ORANGE.slice(0, 6).join(",") + ')"></div>' +
      '<div class="map-ends"><span>' + q(0) + '</span><span>' + q(1) + '</span></div>';

    var CAPTION_C = '<h3>Deaths per 100 crashes, by province</h3>' +
      '<p>77 provinces. The north-east runs dark; Bangkok, with the country’s most ' +
      "crashes, is pale — its highest crash count does not make it a death hot spot.</p>";
    var CAPTION_A = '<h3>Fatal crashes and the road network</h3>' +
      '<p>Dark blue is national highway (DOH), light blue is rural road (DRR). Dot size and ' +
      "colour scale with deaths in that crash — this is the deployment recommendation's payoff view.</p>";
    caption.innerHTML = CAPTION_C;

    var exploring = false;
    var lastP = 0;

    function applyState(p) {
      lastP = p;
      var e = smoothstep(p);
      map.jumpTo({
        center: [lerp(CAM_C.center[0], CAM_A.center[0], e), lerp(CAM_C.center[1], CAM_A.center[1], e)],
        zoom: lerp(CAM_C.zoom, CAM_A.zoom, e),
      });

      var outC = fadeOutHalf(p), inA = fadeInHalf(p);
      map.setPaintProperty("prov-fill", "fill-opacity", 0.95 * outC);
      map.setPaintProperty("road-rural", "line-opacity",
        ["interpolate", ["linear"], ["zoom"], 4, 0.55 * inA, 8, 0.9 * inA]);
      map.setPaintProperty("road-main", "line-opacity",
        ["interpolate", ["linear"], ["zoom"], 4, 0.8 * inA, 8, 0.95 * inA]);
      map.setPaintProperty("fatal-dot", "circle-opacity", 0.92 * inA);

      caption.innerHTML = p < 0.5 ? CAPTION_C : CAPTION_A;
    }
    applyState(0);

    var section = document.getElementById("map-scroll");
    function tick() {
      if (exploring) return;
      var r = section.getBoundingClientRect();
      var p = ChartLayout.progressFor(r.top, r.height, window.innerHeight);
      applyState(p);
    }
    addEventListener("scroll", tick, { passive: true });
    addEventListener("resize", tick);
    tick();

    // Explore — unlocks interaction for Q&A only. Camera and paint stop
    // following scroll while it's on, so a presenter's manual pan/zoom isn't
    // fought by the next scroll tick.
    var btn = document.getElementById("map-explore");
    var navAdded = false;
    btn.addEventListener("click", function () {
      exploring = !exploring;
      btn.textContent = exploring ? "Watching" : "Explore";
      btn.classList.toggle("on", exploring);
      [map.scrollZoom, map.dragPan, map.doubleClickZoom, map.touchZoomRotate].forEach(function (h) {
        exploring ? h.enable() : h.disable();
      });
      if (exploring && !navAdded) {
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
        navAdded = true;
      }
      if (!exploring) applyState(lastP); // snap back to the scroll-driven state
    });

    // Minimal hover/click detail — enough for Q&A, not the full analytical
    // panel the prototype had (metrics toggle, cause filter): out of scope
    // for the ship decision in ticket 09, which asks for watched vs
    // explorable, not for the prototype's whole UI to move house.
    var hover = document.getElementById("map-hover");
    function showHover(e, html) {
      hover.innerHTML = html; hover.style.display = "block";
      hover.style.left = Math.min(e.point.x + 16, innerWidth - 260) + "px";
      hover.style.top = (e.point.y + 16 + mapEl.getBoundingClientRect().top) + "px";
    }
    var hideHover = function () { hover.style.display = "none"; };
    map.on("mousemove", "road-hit", function (e) {
      var p = e.features[0].properties;
      showHover(e, "<b>" + p.code + "</b> &middot; " + (p.agency === "ทล." ? "Highway" : "Rural") +
        "<br>" + nf(p.n) + " crashes &middot; " + nf(p.deaths) + " deaths");
    });
    map.on("mouseleave", "road-hit", hideHover);
    map.on("mousemove", "prov-fill", function (e) {
      var p = e.features[0].properties;
      showHover(e, "<b>" + p.name + "</b><br>" + nf(p.n) + " crashes &middot; " + nf(p.deaths) +
        " deaths<br>" + p.death_rate + " deaths per 100 crashes");
    });
    map.on("mouseleave", "prov-fill", hideHover);
  });
})();
