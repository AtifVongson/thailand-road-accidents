/* Pure layout maths for the scroll-driven charts. NO DOM ACCESS.
 *
 * This module is importable in Node and is where every scale, tick, coordinate
 * and interpolation lives. `render.js` turns what comes back into SVG elements
 * and does nothing else.
 *
 * The split is not stylistic. No browser in this project has ever reliably
 * rendered a page in an authoring session — the Browser pane does not composite,
 * so requestAnimationFrame never fires (see analysis/prototype/NOTES.md §8) — so
 * the layout maths has to be verifiable without one. `12_qa_chart_layout.js`
 * imports this file and feeds it the real exported chart data.
 *
 * Animation state is one scalar, `progress`, in [0, 1]. Layout is a pure
 * function of it. Progress 0 and progress 1 must each be a complete, correct,
 * readable chart, so a fast scroll always lands somewhere valid and a chart that
 * never animates is still right.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChartLayout = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* The same hex values as analysis/scripts/theme.py, so the matplotlib figures
   * and the live charts are one visual system. assets/css/charts.css carries
   * these as custom properties and the QA script asserts all three agree.
   * Blue means volume, orange means severity, without exception. */
  var PALETTE = {
    surface: "#fcfcfb",
    ink: "#0b0b0b",
    ink2: "#52514e",
    muted: "#898781",
    grid: "#e1e0d9",
    axis: "#c3c2b7",
    volume: "#2a78d6",
    severity: "#eb6834",
  };

  /* ------------------------------------------------------------- numbers */

  var clamp = function (x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; };
  var lerp = function (a, b, t) { return a + (b - a) * t; };

  // Cubic ease used for position, so rows settle rather than arriving at speed.
  function smoothstep(t) {
    var x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
  }

  /* A crossfade with a gap in the middle: the "crashes" number is gone before
   * the "deaths" number appears. Interpolating between two counts would put a
   * number on screen that is true of neither, which is worse than showing none.
   * Used for the value labels and the axis ticks — mid-flight the bars are
   * partway between two normalisations, so no scale on them is honest. */
  function fadeOut(p) { return clamp(1 - 2 * p, 0, 1); }
  function fadeIn(p) { return clamp(2 * p - 1, 0, 1); }

  /* Stricter than fadeOut/fadeIn: visible only within `REST_BAND` of an endpoint,
   * so a label is on screen at rest and gone for essentially the whole morph.
   *
   * Slide 8 gets away with the gentler gapped fade because its value labels are
   * attached to rows, and a row's identity survives the reorder. Slide 5's
   * callouts are claims about *which bar is the extreme*, and the extreme
   * changes identity partway through — 16:00 is the busiest hour, 19:00 is the
   * deadliest. A half-faded "peak 16:00" still pointing at 16:00 while the tallest
   * bar has become 19:00 is not an imprecise label, it is a false one. So these
   * are off before the bars have visibly moved.
   */
  var REST_BAND = 0.02;
  function atRestOut(p) { return clamp(1 - clamp(p, 0, 1) / REST_BAND, 0, 1); }
  function atRestIn(p) { return clamp((clamp(p, 0, 1) - (1 - REST_BAND)) / REST_BAND, 0, 1); }

  /* A hard swap at the midpoint, for the heading and the axis title.
   *
   * Two earlier attempts were both wrong on screen. A gapped fade left the chart
   * with no title at all through the middle of the scroll, which is where a
   * presenter spends most of their time. A sum-to-one fade fixed that but
   * rendered both strings at half opacity on the same baseline — and since they
   * differ only in their last word, "crashes" and "deaths" came out overstruck
   * on top of each other. Exactly one label is visible at any progress. */
  function swapOut(p) { return p < 0.5 ? 1 : 0; }
  function swapIn(p) { return p < 0.5 ? 0 : 1; }

  function hexToRgb(hex) {
    var h = hex.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
            parseInt(h.slice(4, 6), 16)];
  }

  function mixHex(a, b, t) {
    var x = hexToRgb(a), y = hexToRgb(b), out = "#";
    for (var i = 0; i < 3; i++) {
      var v = Math.round(lerp(x[i], y[i], clamp(t, 0, 1)));
      out += (v < 16 ? "0" : "") + v.toString(16);
    }
    return out;
  }

  /* Ticks on a 1 / 2 / 5 x 10^k ladder, always including zero and never
   * exceeding `max`, so no tick is drawn past the end of the data. */
  function niceTicks(max, target) {
    var count = target || 5;
    if (!(max > 0) || !isFinite(max)) return [0];
    var raw = max / count;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
    var out = [];
    for (var v = 0; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  /* Same 1/2/5 ladder as niceTicks, but for a range that doesn't start at
   * zero — a dumbbell's domain is a tight band around real values, not a bar
   * chart that has to justify its baseline. */
  function niceTicksRange(min, max, target) {
    var count = target || 4;
    var span = max - min;
    if (!(span > 0) || !isFinite(span)) return [min];
    var raw = span / count;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
    var start = Math.ceil(min / step) * step;
    var out = [];
    for (var v = start; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  var fmt = function (n) { return Math.round(n).toLocaleString("en-US"); };
  var mean = function (xs) { return xs.reduce(function (a, b) { return a + b; }, 0) / xs.length; };

  /* Scroll position -> progress. Kept here, pure, so whichever scroll treatment
   * ticket 08 settles on only has to produce a scalar; nothing about the chart
   * depends on how that scalar was arrived at. */
  function progressFor(elementTop, elementHeight, viewportHeight) {
    var travel = elementHeight - viewportHeight;
    if (!(travel > 0)) return elementTop <= 0 ? 1 : 0;
    return clamp(-elementTop / travel, 0, 1);
  }

  /* Which scroll position an arrow key should move to, given the stops a slide
   * defines. Pure, so the one piece of the keyboard stepper that has ever had a
   * bug in it is testable without a browser — the rest (a listener and a tween)
   * is trivial and stays in the page.
   *
   * `anchors` are absolute document Y positions in ascending order, spanning the
   * slide end to end: the intro first, then one per act. Absolute, not
   * chart-progress fractions, because a presenter arrives at the top of the
   * *outer* section, where the lead-in fills the screen and the chart has not
   * pinned yet — a stepper keyed to the pinned region never engages there, and
   * the first press skips the whole chart. That was the bug.
   *
   * Returns null in two distinct situations that both mean "not mine": the
   * scroll is outside this slide entirely, or it is at the slide's first or last
   * stop and moving further out. In both cases the page's own handler should
   * fall through to transport.js and move to the neighbouring section.
   *
   * `tol` is generous in px because a browser's own smooth scroll lands a pixel
   * or two off a target and the page clamps at its very bottom — but it must
   * stay far smaller than the gap between two stops.
   */
  function nextStop(anchors, scrollY, direction, tol) {
    if (!anchors || !anchors.length) return null;
    if (!isFinite(scrollY) || !isFinite(direction) || direction === 0) return null;
    var t = isFinite(tol) ? Math.abs(tol) : 0;
    var first = anchors[0], last = anchors[anchors.length - 1];
    if (scrollY < first - t || scrollY > last + t) return null;

    var i;
    if (direction > 0) {
      for (i = 0; i < anchors.length; i++) if (anchors[i] > scrollY + t) return anchors[i];
    } else {
      for (i = anchors.length - 1; i >= 0; i--) if (anchors[i] < scrollY - t) return anchors[i];
    }
    return null;
  }

  /* ----------------------------------------- slide 5: when, on both metrics */

  var SLIDE05_DEFAULTS = {
    width: 1280,
    height: 720,
    margin: { top: 138, right: 44, bottom: 104, left: 66 },
    // panelRatios still carry fig01_when's width_ratios, but the two pictures
    // diverged on 9 Aug 2026: the live chart gained the night-window highlight,
    // per-panel titles and a legend, and the deck figure did not. Deliberate —
    // the presentation runs live in a browser and the deck is the backup. Do not
    // read the shared ratios as a promise that the two still match.
    panelRatios: [1.5, 1, 1.2],
    panelGap: 54,
    barShare: 0.72,        // of a slot; the rest is the gap between bars
    headroom: 1.15,        // the space callouts sit in, above the tallest bar
    xTickEvery: { hour: 3, dow: 1, month: 1 },
    noteCharWidth: 6.6,    // ~0.55em at the 12px callout, for overflow clamping
    // 19:00-04:00 inclusive: ten hours carrying 34.6% of crashes and 41.9% of
    // deaths, both recomputed from the bin counts rather than read off the
    // prose. The window wraps midnight, so on a 00->23 axis it draws as two
    // blocks at opposite edges — which is why it needs the legend to read as one
    // thing. Re-basing the axis to start at 05:00 would make it contiguous and
    // was considered and declined; it would desync the x ticks from the deck.
    nightHours: [19, 20, 21, 22, 23, 0, 1, 2, 3, 4],
    // Two acts on one scalar. The hour panel flips first because it is the
    // slide's subject, then the other two together. Each panel reads its own
    // local progress off this split, so a panel's callouts gate on ITS OWN
    // motion — gating on global progress would print the hour panel's number
    // while its bars were still interpolating across two denominators.
    actStops: { hour: [0, 0.5], dow: [0.5, 1], month: [0.5, 1] },
  };

  /* Three panels re-heighting from share-of-crashes to share-of-deaths, in two
   * acts: the hour panel first, then the weekday and month panels together.
   * Nothing reorders — the bins are chronological and stay put — so the only
   * thing that moves is height, which is the whole point: 16:00 sags and 19:00
   * climbs past it.
   *
   * Staging costs the chart its single shared heading and axis title. Between
   * the acts the hour panel is showing deaths while the other two still show
   * crashes, and one label above all three would be false for part of every
   * scroll. So the metric moved INTO the panel titles, which flip one act at a
   * time and are therefore true at every position. That is also why the titles
   * repeat "When crashes happen" rather than sharing a stem: mid-scroll, the
   * repetition is what lets an audience see one panel has moved on and two have
   * not.
   *
   * The hour panel additionally greys everything outside 19:00-04:00. Hue still
   * carries the metric — blue crashes, orange deaths, per the palette rule at
   * the top of this file — and the grey carries the window, so the two encodings
   * do not collide. Worth knowing when reading the crash act: the tallest bar in
   * the hour panel is 16:00, which is OUTSIDE the window and therefore grey,
   * while 02:00, the quietest hour, is inside it and coloured. That is not a
   * rendering fault, it is the argument — the busiest hour is not the deadliest,
   * which is exactly why a schedule built on traffic volume misses this window.
   *
   * The y-axis is FIXED across both acts, per panel, at `headroom` x the larger
   * of the two metrics' maxima. This is the decision the chart turns on. Scaling
   * each act to its own maximum would keep the tallest bar at full height in
   * both, which cancels exactly the thing being shown: the evening's rise would
   * be absorbed by the frame growing with it, and the afternoon would appear to
   * collapse further than it does. That is the same normalisation artefact that
   * inverted a trendline on slide 9.
   *
   * A fixed axis is only readable against a fixed anchor, which is what the
   * even-split line is for: 100/n is true of crashes, true of deaths, and true
   * at every point between, so it is the one mark that never fades. The y ticks
   * are likewise metric-free here — both acts are percentages on one scale — so
   * unlike slide 8's, they never need to crossfade.
   */
  function slide05(data, progress, options) {
    var o = Object.assign({}, SLIDE05_DEFAULTS, options || {});
    var p = clamp(progress, 0, 1);

    // A panel's own 0->1 across its act, so every panel-local decision — bar
    // height, hue, title swap, callout gating — is answered by its own motion
    // and not by where the scroll happens to be overall.
    function localOf(key) {
      var stop = o.actStops[key] || [0, 1];
      return clamp((p - stop[0]) / (stop[1] - stop[0]), 0, 1);
    }
    var nightSet = {};
    o.nightHours.forEach(function (h) { nightSet[h] = true; });

    var plot = {
      x: o.margin.left, y: o.margin.top,
      w: o.width - o.margin.left - o.margin.right,
      h: o.height - o.margin.top - o.margin.bottom,
    };

    var ratios = o.panelRatios;
    var ratioSum = ratios.reduce(function (a, b) { return a + b; }, 0);
    var usable = plot.w - o.panelGap * (data.panels.length - 1);

    var cursor = plot.x;
    var panels = data.panels.map(function (src, pi) {
      var w = usable * (ratios[pi] || 1) / ratioSum;
      var local = localOf(src.key);
      var t = smoothstep(local);
      var panel = { key: src.key, title: src.title, x: cursor, y: plot.y, w: w, h: plot.h,
                    local: local };
      cursor += w + o.panelGap;

      var bins = src.bins;
      // One fixed domain for both acts. Taking the max over BOTH metrics is what
      // makes the two acts comparable; taking it per act is the artefact above.
      var yMax = o.headroom * bins.reduce(function (m, b) {
        return Math.max(m, b.pc_crash, b.pc_death);
      }, 0);
      var yOf = function (v) { return panel.y + panel.h - (v / yMax) * panel.h; };

      var slot = panel.w / bins.length;
      var barW = slot * o.barShare;

      // Only the hour panel has a window to mark. The weekday panel's claim is
      // that nothing stands out, and the month panel carries the April-against-
      // September ratio that Tab 3's staffing case rests on — greying either
      // would argue against a finding the deck makes elsewhere.
      var windowed = src.key === "hour";
      var metricHue = mixHex(PALETTE.volume, PALETTE.severity, t);

      var bars = bins.map(function (b, i) {
        var value = lerp(b.pc_crash, b.pc_death, t);
        var y = yOf(value);
        var inWindow = !windowed || !!nightSet[parseInt(b.label, 10)];
        return {
          key: src.key + "-" + b.label,
          label: b.label,
          x: panel.x + i * slot + (slot - barW) / 2,
          width: barW,
          y: y,
          height: panel.y + panel.h - y,
          inWindow: inWindow,
          color: inWindow ? metricHue : PALETTE.grid,
          value: value,
        };
      });

      var every = o.xTickEvery[src.key] || 1;
      var xTicks = bins.reduce(function (acc, b, i) {
        if (i % every === 0) acc.push({ index: i, x: bars[i].x + barW / 2, label: b.label });
        return acc;
      }, []);

      var yTicks = niceTicks(yMax, 4).map(function (v) {
        return { value: v, y: yOf(v), label: String(+v.toFixed(1)) };
      });

      /* Callouts. Two sets per panel, one per act, each visible only at its own
       * end of the scroll. Positioned above the bar they describe and clamped
       * inside the panel, because the extreme can sit in the first or last slot
       * (02:00, 04:00) where a centred label would hang off the plot. */
      function noteAt(bin, i, text, opacity) {
        var half = text.length * o.noteCharWidth / 2;
        var centre = bars[i].x + barW / 2;
        return {
          key: src.key + "-" + text,
          text: text,
          x: clamp(centre, panel.x + half, panel.x + panel.w - half),
          y: bars[i].y - 13,
          anchorX: centre,
          width: half * 2,
          opacity: opacity,
        };
      }

      function extreme(field, pick) {
        var best = 0;
        for (var i = 1; i < bins.length; i++) {
          if (pick(bins[i][field], bins[best][field])) best = i;
        }
        return best;
      }
      var hi = function (a, b) { return a > b; }, lo = function (a, b) { return a < b; };
      var name = function (b) { return src.key === "hour" ? b.label + ":00" : b.label; };
      var pct = function (v) { return v.toFixed(1) + "%"; };

      var notes = [];
      // Gated on the panel's own progress, not the scroll's. Same rule as
      // before and for the same reason: a bar mid-flight is interpolating
      // between two denominators, so it is not a share of anything and no
      // number may sit on it. Staging just moves where "mid-flight" is.
      [["pc_crash", atRestOut(local)], ["pc_death", atRestIn(local)]].forEach(function (pair) {
        var field = pair[0], op = pair[1];
        var peak = extreme(field, hi);
        if (src.key === "hour") {
          // The window's share, not the extremes. The peak/low pair was
          // replaced on 9 Aug: with the highlight on, "peak 16:00" labels a
          // grey bar and "low 02:00" labels a coloured one, which reads as a
          // contradiction rather than as the point. The window share is also
          // the number the slide's closing sentence rests on.
          var raw = field === "pc_crash" ? "crashes" : "deaths";
          var tot = field === "pc_crash" ? data.total_crashes : data.total_deaths;
          // Recomputed from the counts, not summed from the rounded percentages
          // — summing pc_death over the window gives 42.0%, which would put a
          // number on screen that contradicts the prose's 41.9%.
          var inWin = bins.reduce(function (a, b) {
            return a + (nightSet[parseInt(b.label, 10)] ? b[raw] : 0);
          }, 0);
          notes.push({
            key: src.key + "-window-" + field,
            text: "19:00–04:00: " + pct(100 * inWin / tot) + " of " + raw,
            x: panel.x + 4, y: panel.y + 18, anchorX: panel.x + 4,
            width: 0, opacity: op, anchor: "start",
          });
          return;
        }
        if (src.key === "dow") {
          // The weekday panel's claim is the absence of a peak, so naming one
          // would argue against the slide. It gets the spread instead.
          var lowB = bins[extreme(field, lo)], hiB = bins[peak];
          // Inside the panel, in the headroom above the bars — not above the
          // panel, where it landed on the panel title. Same placement the
          // matplotlib figure uses for this note.
          notes.push({
            key: src.key + "-spread-" + field, text: "a spread of only "
              + pct(lowB[field]) + "–" + pct(hiB[field]),
            x: panel.x + 4, y: panel.y + 18, anchorX: panel.x + 4,
            width: 0, opacity: op, anchor: "start",
          });
          return;
        }
        // Month only — hour and dow both returned above.
        var tag = bins[peak].note ? " (" + bins[peak].note + ")" : "";
        notes.push(noteAt(bins[peak], peak, "peak " + name(bins[peak])
          + " " + pct(bins[peak][field]) + tag, op));
      });

      // "By hour" -> "by hour", so the dimension reads as the tail of a sentence
      // rather than a second heading.
      var dim = src.title.charAt(0).toLowerCase() + src.title.slice(1);

      return Object.assign(panel, {
        yMax: yMax, bars: bars, xTicks: xTicks, yTicks: yTicks, notes: notes,
        // Two titles per panel, hard-swapped at this panel's own midpoint. The
        // hard swap is inherited from the chart heading these replaced: a fade
        // renders both strings on one baseline, and since they differ only in
        // one word, "crashes" and "deaths" come out overstruck.
        titles: [
          { text: "When crashes happen, " + dim, opacity: swapOut(local) },
          { text: "When deaths happen, " + dim, opacity: swapIn(local) },
        ],
        // Metric-independent, so it is drawn once at full opacity and never
        // fades: the only thing on screen that stays true mid-morph.
        //
        // Sits OUTSIDE the panel's right edge as of 9 Aug — inside, right-
        // aligned, it was overdrawn by whatever bar occupied the last slot. The
        // word "even" went with the move: the full "even 14.3%" needs 73px and
        // the gap between panels is 54px, so the number alone is what fits. The
        // dashed line and the legend carry the meaning the word used to.
        evenLine: { value: src.even_split, y: yOf(src.even_split),
                    label: src.even_split.toFixed(1) + "%",
                    labelX: panel.x + panel.w + 6 },
      });
    });

    // The chart-level heading and axis title were removed on 9 Aug. Both said
    // one thing about all three panels, and once the panels stopped flipping
    // together there was no one thing true of all three. Their content did not
    // disappear — it moved into the per-panel titles above, which is the only
    // place it can be stated correctly now.
    return {
      viewBox: { width: o.width, height: o.height },
      plot: plot, progress: p,
      subtitle: "Hours differ far more than days do — and more so by deaths than "
              + "by crashes. Line marks an even share.",
      // Names the two blocks at opposite ends of the hour axis as one window.
      // Without it the highlight reads as two unrelated groups, because the
      // window wraps midnight and the axis does not.
      legend: {
        text: "19:00–04:00",
        color: mixHex(PALETTE.volume, PALETTE.severity, smoothstep(localOf("hour"))),
        x: 40, y: 62, swatch: 11,
      },
      panels: panels,
      source: data.source,
      sourceX: o.width - 40,
    };
  }

  /* ------------------------------------- slide 6: the conditions carousel */

  // Where each stop sits on the slide's single scalar. Stop 0 -> 1 is the metric
  // flip with no rotation; 1 -> 2 and 2 -> 3 are the two rotations.
  var SLIDE06_STOPS = [0, 1 / 3, 2 / 3, 1];

  var SLIDE06_DEFAULTS = {
    width: 1280,
    height: 840,
    // Every card is laid out in this local space and then placed by a transform,
    // so one scale factor carries bar geometry and type size together. Without
    // it, text would have to be re-sized per position and would drift out of
    // proportion with the bars it labels.
    cardWidth: 1280,
    cardHeight: 380,
    smallWidth: 620,
    // Ellipse, not a circle: three positions on a true circle 660px across need
    // over 900px of vertical travel, which does not fit above the source line.
    // The path is still one closed loop and still reads as rotation.
    centre: { x: 640, y: 533 },
    radius: { x: 381, y: 223 },
    // 12 o'clock, 4 o'clock, 8 o'clock, measured clockwise from the top.
    baseAngles: [0, 120, 240],
    // The vertical strip cards may occupy: clear of the heading above and the
    // limitation line and source below.
    band: { top: 100, bottom: 770 },
    labelGutter: 300,
    panelGap: 50,
    headerH: 70,
    // Bars are scaled to the panel MINUS this, so the value label sitting past
    // the end of the longest bar still fits. The severity panel ends flush with
    // the card's right edge, so without it every card's longest bar — 32.0 on
    // vehicle, 52.4 on weather — pushed its own label off the canvas.
    valueRoom: 58,
    barShare: 0.6,
    headroom: 1.05,
    restBand: 0.02,
    dimOffTop: 0.55,      // opacity of a card away from the top position
    labelGate: 0.6,       // prominence below which value labels are suppressed
  };

  /* Three cards on one ellipse, rotating counter-clockwise, each flipping its
   * own left-hand metric once, at the point it is shown as the main card —
   * not all three together at card 0's flip. See cardFlipWindow, below,
   * for why each card's window falls where it does.
   *
   * Counter-clockwise, not clockwise: leftward is where finished things go in a
   * left-to-right reading order, so the card being explained descends to the
   * bottom-left and the next one rises from the bottom-right. Clockwise would
   * send the just-covered card into the position an audience reads as "next".
   *
   * Cards stay upright — only their position and scale change. A tilted bar
   * chart is unreadable, so nothing here rotates about its own centre.
   *
   * The same card is drawn at every position rather than a placard that becomes
   * a chart on arrival. If the thing at the bottom were a different artefact
   * from the thing that arrives at the top, the audience would be watching
   * content get swapped and the circular motion would be a lie about what is
   * happening. What changes with prominence is detail density, not identity:
   * value labels switch off below `labelGate`, because a label too small to read
   * is noise rather than information.
   *
   * Both panels use a domain fixed across both metrics, for the reason slide 5
   * documents at length: re-normalising per act cancels the change being shown.
   * The severity panel does not move at all under the flip — a death rate is the
   * same number under either framing — and that stillness is worth seeing.
   */
  function slide06(data, progress, options) {
    var o = Object.assign({}, SLIDE06_DEFAULTS, options || {});
    var p = clamp(progress, 0, 1);
    var S = SLIDE06_STOPS;

    // The metric flip owns the first segment; the two rotations own the rest.
    // Each segment eases independently so a card settles at each stop rather
    // than sweeping through it.
    var rot = smoothstep(clamp((p - S[1]) / (S[2] - S[1]), 0, 1))
            + smoothstep(clamp((p - S[2]) / (S[3] - S[2]), 0, 1));
    var phi = -120 * rot;   // negative = counter-clockwise

    /* Until 9 Aug, one shared `metricT` drove every card's colour, row order,
     * value labels and panel title at once — so road and weather flipped to
     * "deaths" in lock-step with vehicle's own hold-and-flip segment, while
     * still small and off to the side, never yet the card being shown.
     *
     * Card 0 keeps its dedicated hold: it owns the whole first segment
     * [S[0], S[1]] and flips while stationary at the top, exactly as before.
     * Cards 1 and 2 have no such hold — they only ever pass through the top,
     * mid-rotation — so their window is centred on the exact moment their own
     * prominence overtakes the card ahead of them. With three cards spaced
     * 120° apart and a single -120° rotation per segment, that crossover is
     * provably at the segment's own midpoint: prominence is a function of
     * cos(theta), the two competing cards' angles are always 120° apart, and
     * cos(phi) = cos(120+phi) at phi=-60 — which lands at local segment
     * progress 0.5 because smoothstep(0.5) is exactly 0.5. Verified
     * numerically against this same formula, not just derived on paper.
     */
    function cardFlipWindow(ci) {
      if (ci === 0) return [S[0], S[1]];
      var segStart = S[ci], segEnd = S[ci + 1];
      var mid = (segStart + segEnd) / 2;
      var half = (segEnd - segStart) / 4;
      return [mid - half, mid + half];
    }

    var RAD = Math.PI / 180;
    var cards = data.cards.map(function (src, ci) {
      var win = cardFlipWindow(ci);
      // Local to this card: 0 before its window opens, 1 from the moment it
      // closes, ratcheting forward the same way card 0 always has — a card
      // that has already been shown as the main chart does not revert to
      // "crashes" framing on its way back down.
      var mp = clamp((p - win[0]) / (win[1] - win[0]), 0, 1);
      var metricT = smoothstep(mp);
      var theta = (o.baseAngles[ci] + phi) * RAD;
      // 1 at the top, 0 at either bottom position, smooth in between.
      var prom = clamp((Math.cos(theta) + 0.5) / 1.5, 0, 1);
      var cx = o.centre.x + o.radius.x * Math.sin(theta);
      var cy = o.centre.y - o.radius.y * Math.cos(theta);

      /* A card is as wide as prominence wants, or as wide as fits where it
       * currently is, whichever is smaller.
       *
       * The second clause is not defensive padding — without it the carousel is
       * broken in the middle of every rotation. Prominence rises with cos(theta)
       * while the card is still far from centre, so at 10 o'clock a card wants
       * 83% scale at cx = 310 and hangs 220px off the left edge. Capping width
       * at twice the distance to the nearer edge makes a card grow as it
       * approaches the top rather than on its way there, which is also what the
       * motion should look like. */
      var room = 2 * Math.min(cx, o.width - cx);
      var width = Math.min(lerp(o.smallWidth, o.cardWidth, prom), room);
      var scale = width / o.cardWidth;

      /* The three stops sit at 12, 4 and 8 o'clock, but a card rotating between
       * the two bottom stops passes through 6 o'clock, which is 111px lower than
       * either of them — far enough to land on the limitation line. Clamping the
       * centre into the card band flattens that dip without moving any stop,
       * since no stop is near the clamp. */
      var halfH = o.cardHeight * scale / 2;
      cy = clamp(cy, o.band.top + halfH, o.band.bottom - halfH);

      var rows = src.categories;
      var n = rows.length;
      // Fixed across both metrics, so a bar that grows really did grow.
      var volMax = o.headroom * rows.reduce(function (m, r) {
        return Math.max(m, r.pc_crash, r.pc_death);
      }, 0);
      var sevMax = o.headroom * rows.reduce(function (m, r) {
        return Math.max(m, r.death_rate);
      }, 0);

      var panelW = (o.cardWidth - o.labelGutter - o.panelGap) / 2;
      var barSpan = panelW - o.valueRoom;
      var volX = o.labelGutter;
      var sevX = o.labelGutter + panelW + o.panelGap;
      var rowsTop = o.headerH;
      var slotH = (o.cardHeight - rowsTop) / n;
      var barH = slotH * o.barShare;

      // Value labels are the one thing that must not survive the flip on the
      // volume side: mid-morph a bar is between share-of-crashes and
      // share-of-deaths and is a share of neither. The severity panel is exempt
      // because its number does not change — only its row's slot does.
      var gate = clamp((prom - o.labelGate) / (1 - o.labelGate), 0, 1);
      var outOp = atRestOut(mp) * gate;
      var inOp = atRestIn(mp) * gate;

      var laidRows = rows.map(function (r) {
        var slot = lerp(r.rank_crashes - 1, r.rank_deaths - 1, metricT);
        var y = rowsTop + slot * slotH + (slotH - barH) / 2;
        var volValue = lerp(r.pc_crash, r.pc_death, metricT);
        return {
          key: src.key + "-" + r.label,
          label: r.label,
          thin: !!r.thin,
          y: y, height: barH,
          labelX: o.labelGutter - 14,
          vol: {
            x: volX, width: (volValue / volMax) * barSpan,
            color: mixHex(PALETTE.volume, PALETTE.severity, metricT),
            values: [
              { text: r.pc_crash.toFixed(1) + "%", opacity: outOp },
              { text: r.pc_death.toFixed(1) + "%", opacity: inOp },
            ],
            valueX: volX + (volValue / volMax) * barSpan + 10,
          },
          sev: {
            x: sevX, width: (r.death_rate / sevMax) * barSpan,
            // Thin categories are drawn in axis grey, never in severity orange:
            // overcast's 52.4 per 100 would otherwise be the longest bar on the
            // card, off 248 crashes. Shown, but never as evidence.
            color: r.thin ? PALETTE.axis : PALETTE.severity,
            values: [{ text: r.death_rate.toFixed(1), opacity: gate }],
            valueX: sevX + (r.death_rate / sevMax) * barSpan + 10,
            // Motorcycle's severity bar is the one this card's whole argument
            // rests on — 32.0 against a 12.6 all-crash line — so it carries a
            // second, non-colour encoding as well as the hue. A diagonal
            // texture separates it from the seven other orange bars on this
            // panel without relying on shade alone. No other row gets it: the
            // point is to mark the one bar the slide argues from, not to
            // decorate every row.
            texture: src.key === "vehicle" && r.label === "Motorcycle",
          },
        };
      });

      return {
        key: src.key,
        title: src.title,
        note: src.note,
        prominence: prom,
        opacity: lerp(o.dimOffTop, 1, prom),
        // One transform per card carries position and scale together, so bars
        // and type stay in proportion at every point on the loop.
        transform: { x: cx - o.cardWidth * scale / 2,
                     y: cy - o.cardHeight * scale / 2, scale: scale },
        centre: { x: cx, y: cy },
        width: o.cardWidth * scale, height: o.cardHeight * scale,
        panelTitleY: 44,
        panels: [
          { key: "volume", x: volX, width: panelW, max: volMax,
            titles: [
              { text: "% of all crashes", opacity: swapOut(mp) },
              { text: "% of all deaths", opacity: swapIn(mp) },
            ] },
          { key: "severity", x: sevX, width: panelW, max: sevMax,
            titles: [{ text: "Deaths per 100 crashes", opacity: 1 }],
            // Below the panel title's baseline, not level with it: the all-crash
            // rule falls at x≈968 on the vehicle card, which is inside the run of
            // the title text above it.
            baseline: { value: data.base_death_rate, labelY: rowsTop - 8,
                        x: sevX + (data.base_death_rate / sevMax) * barSpan,
                        label: "all crashes " + data.base_death_rate.toFixed(1) } },
        ],
        rows: laidRows,
        rowsTop: rowsTop, slotH: slotH,
      };
    });

    /* One heading per card, hard-swapped on whichever card is nearest the top.
     * Not a crossfade: mid-rotation the outgoing and incoming cards both sit at
     * 0.67 prominence, so a prominence-weighted fade would render two different
     * headings at two-thirds opacity on the same baseline — the overstrike the
     * comment on swapOut/swapIn describes. Exactly one is visible at any p. */
    var leadIdx = 0;
    for (var ci2 = 1; ci2 < cards.length; ci2++) {
      if (cards[ci2].prominence > cards[leadIdx].prominence) leadIdx = ci2;
    }
    var COPY = {
      vehicle: {
        heading: "Motorcycles are a seventh of crashes and over a third of deaths",
        subtitle: "The left panel counts crashes, then deaths. The right panel is a "
                + "rate and does not move.",
      },
      road: {
        heading: "Straight road is where crashes are both most common and most deadly",
        subtitle: "Not curves, as is usually assumed.",
      },
      weather: {
        heading: "Clear weather is most crashes — and deadlier per crash than rain",
        subtitle: null,   // falls back to the card's own note from the export
      },
    };

    var mi = data.motorcycle_involvement;
    return {
      viewBox: { width: o.width, height: o.height },
      // No single "metric" scalar any more — as of 9 Aug each card carries its
      // own flip progress (see cardFlipWindow above), so one shared number
      // would not mean the same thing for all three. Nothing outside this
      // function ever read the old field.
      progress: p, rotation: phi,
      stops: S, leadCard: cards[leadIdx].key,
      headings: cards.map(function (c, i) {
        return { key: c.key, text: (COPY[c.key] || {}).heading || c.title,
                 opacity: i === leadIdx ? 1 : 0 };
      }),
      subtitles: cards.map(function (c, i) {
        return { key: c.key,
                 text: (COPY[c.key] || {}).subtitle || c.note || "",
                 opacity: i === leadIdx ? 1 : 0 };
      }),
      cards: cards,
      /* Sits in the open canvas directly below the card, not beside the
       * Motorcycle bar itself — measured, not assumed: the bar's own row has
       * only 15.5px of clearance to the row below it (both panels share one
       * `y` per row, so severity climbs with volume as the card flips), nowhere
       * near enough for a second line of legible text. The area below the
       * card's rendered bottom edge (y=500 at full size) is genuinely open —
       * the existing limitation note two rows down doesn't start until
       * y=782 — so the recommendation goes there instead, directly under the
       * card rather than pixel-adjacent to the one bar it is about.
       *
       * This is a recommendation, not a measurement — unlike the limitation
       * note below, which states what the data shows. Kept as its own object
       * rather than folded into `limitation.lines` so that distinction stays
       * visible in the data, not just in the wording. */
      insight: {
        text: "Insight: motorcycle-focused enforcement and training should be "
            + "a staffing priority.",
        x: 40, y: 524,
        opacity: cards[0].prominence,
      },
      /* The strongest motorcycle number in the file is the one no bar here can
       * carry, so it is stated instead of omitted. Tied to the vehicle card's
       * prominence, because it is a caveat about that card and would be
       * confusing floating under the weather card. */
      // Two lines, not one: as a single string this runs about 2,000px on a
      // 1,280px canvas. The fuller wording lives in the page below the chart.
      limitation: {
        lines: [
          { text: "A motorcycle is involved in crashes accounting for " + mi.pc_death
                + "% of deaths — the largest single fact in this file.",
            x: 40, y: o.height - 58 },
          { text: "Involvement overlaps — per-type shares sum to " + mi.share_sum_pc
                + "% — so it is not a share of a whole. This card counts each crash "
                + "once, by first vehicle.",
            x: 40, y: o.height - 36 },
        ],
        opacity: cards[0].prominence,
      },
      source: data.source,
      sourceX: o.width - 40,
    };
  }

  /* --------------------------------- slide 10: excess over what volume explains */

  var SLIDE10_DEFAULTS = {
    width: 1280,
    height: 720,
    // Deep top margin because three lines stack above the plot — heading,
    // subtitle and the scope note — and both panels then hang a title just under
    // them. At 132 the scope note and the axis titles were 6px apart and
    // overstruck. Deep bottom margin for the same reason: tick labels, then an
    // axis title, then the source line.
    margin: { top: 160, right: 44, bottom: 96, left: 74 },
    panelGap: 96,
    panelSplit: 0.46,     // left panel's share of the plot width
    topN: 14,
    barShare: 0.6,
    headroom: 1.28,       // room past the longest bar for its "+N (Rx)" label
    pointR: 4.4,
    topPointR: 6.2,
    labelGutter: 208,     // for the ranked list's Route/province/km labels
  };

  /* Two panels on one scalar. The scatter establishes the model; the ranking
   * names the sections that beat it.
   *
   * Act 1 is every section against what a negative-binomial model predicts from
   * traffic volume, on log-log axes with a parity line. Log axes because both
   * quantities span two orders of magnitude — 6 to 749 expected, 10 to 1,893
   * actual — and on a linear scale the bottom half of the sections collapse into
   * the corner. Parity is then the 45° line, and "above the line" is literally
   * "crashes more than volume explains".
   *
   * Act 2 fades the 146 sections that are not the story, lights the worst 14 in
   * severity orange, and grows their overshoot as a ranked list beside the
   * scatter. The points do not move: the ranking is a second view of the same
   * marks, not a re-plot, so a section keeps its identity across the act.
   *
   * The model is fitted in Python and only its predictions are exported — this
   * module does no statistics, and `expected` is never recomputed here.
   */
  function slide10(data, progress, options) {
    var o = Object.assign({}, SLIDE10_DEFAULTS, options || {});
    var p = clamp(progress, 0, 1);
    var t = smoothstep(p);
    var pts = data.points;

    var plot = {
      x: o.margin.left, y: o.margin.top,
      w: o.width - o.margin.left - o.margin.right,
      h: o.height - o.margin.top - o.margin.bottom,
    };
    var leftW = (plot.w - o.panelGap) * o.panelSplit;
    var rightW = plot.w - o.panelGap - leftW;
    var scatter = { x: plot.x, y: plot.y, w: leftW, h: plot.h };
    var rank = { x: plot.x + leftW + o.panelGap, y: plot.y, w: rightW, h: plot.h };

    // One shared domain for both axes, so the parity line is a true 45 degrees
    // and "above the line" is a fair reading rather than an artefact of two
    // different scales.
    var lo = pts.reduce(function (m, r) {
      return Math.min(m, r.expected, r.crashes);
    }, Infinity) * 0.7;
    var hi = pts.reduce(function (m, r) {
      return Math.max(m, r.expected, r.crashes);
    }, 0) * 1.3;
    var logLo = Math.log(lo), logHi = Math.log(hi);
    var sx = function (v) { return scatter.x + (Math.log(v) - logLo) / (logHi - logLo) * scatter.w; };
    var sy = function (v) { return scatter.y + scatter.h - (Math.log(v) - logLo) / (logHi - logLo) * scatter.h; };

    // Decade ticks (1, 10, 100, 1000) that fall inside the domain.
    var decades = [];
    for (var e = Math.ceil(logLo / Math.LN10); Math.pow(10, e) <= hi; e++) {
      var dv = Math.pow(10, e);
      decades.push({ value: dv, x: sx(dv), y: sy(dv), label: fmt(dv) });
    }

    var tops = pts.filter(function (r) { return r.top; })
                  .sort(function (a, b) { return b.excess - a.excess; });
    var maxExcess = tops.reduce(function (m, r) { return Math.max(m, r.excess); }, 0);
    var slotH = rank.h / o.topN;
    var barH = slotH * o.barShare;
    var barMax = rank.w - o.labelGutter;

    var points = pts.map(function (r, i) {
      return {
        key: "s" + i,
        cx: sx(r.expected), cy: sy(r.crashes),
        r: r.top ? lerp(o.pointR, o.topPointR, t) : o.pointR,
        // The 146 sections that are not the story recede rather than vanish:
        // dropping them would make act 2 look like a different dataset.
        opacity: r.top ? 1 : lerp(0.55, 0.16, t),
        color: r.top ? mixHex(PALETTE.grid, PALETTE.severity, t) : PALETTE.grid,
        top: !!r.top,
      };
    });

    var rows = tops.map(function (r, i) {
      var y = rank.y + i * slotH + (slotH - barH) / 2;
      return {
        key: "t" + i,
        label: r.label,
        y: y, height: barH,
        x: rank.x + o.labelGutter,
        width: (r.excess / (maxExcess * o.headroom)) * barMax * t,
        labelX: rank.x + o.labelGutter - 12,
        valueX: rank.x + o.labelGutter
              + (r.excess / (maxExcess * o.headroom)) * barMax * t + 10,
        value: "+" + fmt(r.excess) + "  (" + r.ratio.toFixed(1) + "×)",
        // The whole panel arrives together rather than row by row: this is one
        // list being revealed, not a race between fourteen bars.
        opacity: t,
      };
    });

    var pct = Math.round(data.model.deviance_explained * 100);
    return {
      viewBox: { width: o.width, height: o.height },
      plot: plot, scatter: scatter, rank: rank, progress: p,
      headings: [
        { text: "Which sections crash more than traffic volume can explain",
          opacity: swapOut(p) },
        { text: "Fourteen sections crash far more than volume can explain",
          opacity: swapIn(p) },
      ],
      // Two runs, not one string: the model line plus the scope note measures
      // about 2,000px on a 1,280px canvas, and an SVG text run does not wrap.
      subtitle: "Measured against a negative-binomial model predicting crashes from "
              + "AADT × length × years — it explains " + pct + "% of the variation",
      scopeNote: { text: data.scope_note, x: 40, y: 108 },
      parity: { x1: sx(lo), y1: sy(lo), x2: sx(hi), y2: sy(hi),
                label: "Above the line = crashes more than it should" },
      decades: decades,
      axisTitles: [
        { text: "Crashes the model expected", x: scatter.x + scatter.w / 2,
          y: scatter.y + scatter.h + 46, anchor: "middle" },
        { text: "Crashes that actually happened", x: scatter.x,
          y: scatter.y - 14, anchor: "start" },
      ],
      points: points,
      rows: rows,
      rankTitle: { text: "The " + o.topN + " biggest overshoots",
                   x: rank.x, y: rank.y - 14, opacity: t },
      rankAxis: { text: "Crashes above the expected number (5-year total)",
                  x: rank.x + o.labelGutter, y: rank.y + rank.h + 46, opacity: t },
      source: data.source,
      sourceX: o.width - 40,
    };
  }

  /* ------------------------------- shared: a plot box from a margin object */

  function plotBox(o) {
    return { x: o.margin.left, y: o.margin.top,
             w: o.width - o.margin.left - o.margin.right,
             h: o.height - o.margin.top - o.margin.bottom };
  }

  /* Decade ticks for a log axis, as values that fall inside [lo, hi]. */
  function decadeTicks(lo, hi) {
    var out = [];
    for (var e = Math.ceil(Math.log(lo) / Math.LN10); Math.pow(10, e) <= hi; e++) {
      out.push(Math.pow(10, e));
    }
    return out;
  }

  /* ------------------------------------- slide 7: two counts rising together */

  var SLIDE07_DEFAULTS = {
    width: 1280, height: 720,
    margin: { top: 148, right: 60, bottom: 96, left: 96 },
    headroom: 1.08,
    pointR: 5.2,
  };

  /* One point per province: crashes involving a motorcycle against crashes that
   * do not. The two series partition each province's total exactly once, so the
   * scatter is a decomposition rather than two loosely related counts.
   *
   * Act 1 is the cloud. Act 2 draws the least-squares fit across it and states
   * the correlation. The fit is computed in Python and passed in — this module
   * does no statistics — and it is drawn last because the claim being made is
   * "these rise together", which the eye should reach before the line asserts it.
   */
  function slide07(data, progress, options) {
    var o = Object.assign({}, SLIDE07_DEFAULTS, options || {});
    var p = clamp(progress, 0, 1);
    var t = smoothstep(p);
    var plot = plotBox(o);
    var pts = data.points;

    var xMax = o.headroom * pts.reduce(function (m, r) { return Math.max(m, r.with_mc); }, 0);
    var yMax = o.headroom * pts.reduce(function (m, r) { return Math.max(m, r.without_mc); }, 0);
    var sx = function (v) { return plot.x + (v / xMax) * plot.w; };
    var sy = function (v) { return plot.y + plot.h - (v / yMax) * plot.h; };

    // The fit is drawn only across the span the data actually covers, so it
    // never implies a prediction outside the observed range.
    var xLo = 0, xHi = pts.reduce(function (m, r) { return Math.max(m, r.with_mc); }, 0);
    var fitY = function (x) { return data.fit.slope * x + data.fit.intercept; };

    return {
      viewBox: { width: o.width, height: o.height },
      plot: plot, progress: p,
      headings: [
        { text: "Motorcycle and other crashes rise together", opacity: swapOut(p) },
        { text: "The strongest relationship in the file", opacity: swapIn(p) },
      ],
      subtitle: "One point per province, all 77. Crashes involving a motorcycle "
              + "against crashes that do not.",
      points: pts.map(function (r, i) {
        return { key: "p" + i, label: r.label, cx: sx(r.with_mc), cy: sy(r.without_mc),
                 r: o.pointR, color: PALETTE.volume, opacity: 0.72 };
      }),
      fit: {
        x1: sx(xLo), y1: sy(fitY(xLo)),
        // Grows out across the cloud rather than appearing whole.
        x2: sx(lerp(xLo, xHi, t)), y2: sy(fitY(lerp(xLo, xHi, t))),
        opacity: t,
      },
      stat: {
        // Only at rest: mid-draw the line is a partial claim and a correlation
        // printed beside it would look like it belonged to the drawn part.
        text: "Pearson r = " + data.pearson_r.toFixed(2)
            + "   ·   Spearman ρ = " + data.spearman_r.toFixed(2)
            + "   ·   p < 0.001",
        x: plot.x + 20, y: plot.y + 30, opacity: atRestIn(p),
      },
      axisTitles: [
        { text: data.axis_x, x: plot.x + plot.w / 2, y: plot.y + plot.h + 52,
          anchor: "middle" },
        { text: data.axis_y, x: plot.x, y: plot.y - 16, anchor: "start" },
      ],
      xTicks: niceTicks(xMax, 5).map(function (v) {
        return { value: v, x: sx(v), label: fmt(v) };
      }),
      yTicks: niceTicks(yMax, 5).map(function (v) {
        return { value: v, y: sy(v), label: fmt(v) };
      }),
      source: data.source, sourceX: o.width - 40,
    };
  }

  /* --------------------------------- slide 10b: five kinds of road section */

  var SLIDE10B_DEFAULTS = {
    // Deep top margin: each panel stacks a name, a description and a count above
    // it, and the shared y-axis label needs a band of its own above those. At 190
    // the axis label and the first panel's caption were 4px apart and overstruck.
    width: 1280, height: 720,
    margin: { top: 210, right: 44, bottom: 96, left: 74 },
    panelGap: 22,
    pointR: 3.2,
    focusR: 4.6,
  };

  /* Five small multiples over one shared scatter — crash rate against deaths per
   * crash, log x — with every section drawn faintly in all five and one
   * archetype picked out in each. Progress walks the focus across them, so a
   * presenter steps through the five kinds rather than pointing at a wall of
   * panels.
   *
   * Every panel shares one pair of scales. Giving each its own would let a
   * cluster's spread look like a property of that cluster rather than of the
   * axis it was drawn on, which is the whole failure mode small multiples exist
   * to avoid.
   */
  function slide10b(data, progress, options) {
    var o = Object.assign({}, SLIDE10B_DEFAULTS, options || {});
    var p = clamp(progress, 0, 1);
    var plot = plotBox(o);
    var k = data.clusters.length;

    // Focus walks 0 -> k-1. Each whole number is a stop.
    var focus = p * (k - 1);

    var pts = data.points;
    var rLo = pts.reduce(function (m, r) { return Math.min(m, r.crash_rate); }, Infinity) * 0.8;
    var rHi = pts.reduce(function (m, r) { return Math.max(m, r.crash_rate); }, 0) * 1.2;
    var sHi = pts.reduce(function (m, r) { return Math.max(m, r.deaths_per_crash); }, 0) * 1.12;
    var logLo = Math.log(rLo), logHi = Math.log(rHi);

    var panelW = (plot.w - o.panelGap * (k - 1)) / k;

    var panels = data.clusters.map(function (c, i) {
      var x = plot.x + i * (panelW + o.panelGap);
      var sx = function (v) { return x + (Math.log(v) - logLo) / (logHi - logLo) * panelW; };
      var sy = function (v) { return plot.y + plot.h - (v / sHi) * plot.h; };
      // 1 on the focused panel, falling away either side, so neighbours stay
      // legible instead of switching off.
      var near = clamp(1 - Math.abs(focus - i), 0, 1);

      return {
        key: c.label, label: c.label, note: c.note,
        cluster: c.cluster, x: x, y: plot.y, w: panelW, h: plot.h,
        focus: near,
        caption: c.sections + " sections · " + c.death_share.toFixed(0)
               + "% of deaths in the sample",
        points: pts.map(function (r, j) {
          var mine = r.cluster === c.cluster;
          return {
            key: "c" + i + "-" + j,
            cx: sx(r.crash_rate), cy: sy(r.deaths_per_crash),
            r: mine ? lerp(o.pointR, o.focusR, near) : o.pointR,
            color: mine ? PALETTE.volume : PALETTE.grid,
            opacity: mine ? lerp(0.45, 0.9, near) : 0.5,
            mine: mine,
          };
        }),
        xTicks: decadeTicks(rLo, rHi).map(function (v) {
          return { value: v, x: sx(v), label: fmt(v) };
        }),
      };
    });

    return {
      viewBox: { width: o.width, height: o.height },
      plot: plot, progress: p, focus: focus,
      stops: data.clusters.map(function (_, i) { return i / (k - 1); }),
      heading: "Five kinds of road section, separated by k-means on four variables",
      subtitle: data.features.join(" · ") + "   (k = " + data.k
              + ", silhouette " + data.silhouette + ")",
      panels: panels,
      axisTitles: [
        { text: "Crash rate (per 100 million vehicle-km)",
          x: plot.x + plot.w / 2, y: plot.y + plot.h + 50, anchor: "middle" },
        // Above the per-panel label stack, not beside it: all five panels share
        // this axis, so it reads as a header for the whole strip.
        { text: "Deaths per crash", x: plot.x, y: plot.y - 96, anchor: "start" },
      ],
      yTicks: niceTicks(sHi, 4).map(function (v) {
        return { value: v, y: plot.y + plot.h - (v / sHi) * plot.h,
                 label: v.toFixed(2) };
      }),
      source: data.source, sourceX: o.width - 40,
    };
  }

  /* ------------------------ slide 11: what the overshooting sections share */

  var SLIDE11_DEFAULTS = {
    width: 1280, height: 720,
    margin: { top: 176, right: 44, bottom: 120, left: 74 },
    panelGap: 34,
    barShare: 0.34,       // of a panel's width, per bar
    headroom: 1.26,
  };

  /* Six paired comparisons, each on its own scale.
   *
   * Deliberately six separate panels with no shared axis: thousands of vehicles
   * a day, a percentage, a rate per 100 million vehicle-km and deaths per 100
   * crashes have nothing in common to share an axis with, and forcing them onto
   * one would invent a relationship — the rule volume_vs_severity states in
   * 02_figs_descriptive.py. Each panel is therefore its own question, and only
   * the pairing is comparable.
   *
   * Panel order is an argument, not a list. Traffic, heavy vehicles and crash
   * rate all run high; then motorcycle involvement and deaths per crash both
   * collapse. The motorcycle panel sits immediately left of the deaths panel
   * because it is the mechanism for it — a third the motorcycle involvement,
   * a sixth the deaths per crash — and the eye reads left to right.
   *
   * Act 1 shows the 146 ordinary sections alone; act 2 grows the 14 overshooting
   * ones beside them. Establishing normal before showing the exception is what
   * makes the last two panels land — the overshooting sections crash four times
   * as often and kill a sixth as much.
   */
  function slide11(data, progress, options) {
    var o = Object.assign({}, SLIDE11_DEFAULTS, options || {});
    var p = clamp(progress, 0, 1);
    var t = smoothstep(p);
    var plot = plotBox(o);
    var ms = data.measures;
    var n = ms.length;
    var panelW = (plot.w - o.panelGap * (n - 1)) / n;
    var barW = panelW * o.barShare;

    var panels = ms.map(function (m, i) {
      var x = plot.x + i * (panelW + o.panelGap);
      var top = Math.max(m.overshooting, m.others) * o.headroom;
      var hOf = function (v) { return (v / top) * plot.h; };
      // Others on the left as the baseline, overshooting on the right as the
      // departure from it — the direction the sentence runs.
      var gap = (panelW - barW * 2) / 3;
      var bars = [
        { key: m.label + "-others", which: "others", label: "All others",
          x: x + gap, width: barW, value: m.others,
          height: hOf(m.others), y: plot.y + plot.h - hOf(m.others),
          color: PALETTE.axis, opacity: 1 },
        { key: m.label + "-over", which: "overshooting", label: "Overshooting",
          x: x + gap * 2 + barW, width: barW, value: m.overshooting,
          height: hOf(m.overshooting) * t,
          y: plot.y + plot.h - hOf(m.overshooting) * t,
          color: PALETTE.severity, opacity: t },
      ];
      return {
        key: m.label, title: m.label, unit: m.unit, ratio: m.ratio,
        x: x, y: plot.y, w: panelW, h: plot.h, max: top,
        bars: bars.map(function (b) {
          return Object.assign(b, {
            valueX: b.x + b.width / 2,
            valueY: b.y - 10,
            // The overshooting number only once its bar has stopped growing:
            // a value label on a bar still in flight names a height, not a
            // measurement.
            valueOpacity: b.which === "others" ? 1 : atRestIn(p),
          });
        }),
      };
    });

    return {
      viewBox: { width: o.width, height: o.height },
      plot: plot, progress: p,
      headings: [
        { text: "The ordinary sections, for comparison", opacity: swapOut(p) },
        { text: "What the over-crashing sections have in common", opacity: swapIn(p) },
      ],
      subtitle: "The " + data.top_n + " biggest overshoots against the other "
              + data.others + " — " + data.motorway_share.toFixed(0)
              + "% of them are motorway, Routes 7 and 9",
      panels: panels,
      legend: [
        { text: "All others", color: PALETTE.axis, opacity: 1 },
        { text: "Overshooting", color: PALETTE.severity, opacity: t },
      ],
      source: data.source, sourceX: o.width - 40,
    };
  }

  /* ---------------------------------------- slide 13: the forecast, and its test */

  var SLIDE13_DEFAULTS = {
    width: 1280, height: 760,
    margin: { top: 150, right: 52, bottom: 92, left: 88 },
    panelGap: 44,
    headroom: 1.12,
  };

  /* Two stacked panels, crashes above deaths, sharing an x axis of 72 months —
   * 60 observed and 12 forecast. Separate panels rather than one dual axis, the
   * same rule slide 12 follows: different units, and overlaying them invents a
   * relationship.
   *
   * The history is always fully drawn. What `progress` moves is the forecast:
   * the central line extends month by month and its bands open behind it, so
   * uncertainty is seen widening with distance rather than presented as a
   * finished shape. The 95% band is drawn under the 80%, both from the same
   * exported bounds, and a check asserts they nest.
   */
  function slide13(data, progress, options) {
    var o = Object.assign({}, SLIDE13_DEFAULTS, options || {});
    var p = clamp(progress, 0, 1);
    var t = smoothstep(p);
    var plot = plotBox(o);
    var kinds = ["crashes", "deaths"];
    var panelH = (plot.h - o.panelGap) / 2;

    var nHist = data.series.crashes.history.length;
    var nFc = data.series.crashes.forecast.length;
    var total = nHist + nFc;
    var xOf = function (i) { return plot.x + (i / (total - 1)) * plot.w; };
    var reveal = t * nFc;   // how many forecast months are on screen

    var panels = kinds.map(function (kind, pi) {
      var s = data.series[kind];
      var y0 = plot.y + pi * (panelH + o.panelGap);
      var top = o.headroom * Math.max(
        s.history.reduce(function (m, r) { return Math.max(m, r.value); }, 0),
        s.forecast.reduce(function (m, r) { return Math.max(m, r.hi95); }, 0));
      var yOf = function (v) { return y0 + panelH - (v / top) * panelH; };

      var hist = s.history.map(function (r, i) {
        return [xOf(i), yOf(r.value)];
      });

      // The forecast is drawn from the last observed point so the two series
      // meet rather than starting a gap the eye has to close.
      var shown = Math.min(nFc, Math.floor(reveal));
      var frac = reveal - shown;
      var fc = [[xOf(nHist - 1), yOf(s.history[nHist - 1].value)]];
      for (var i = 0; i < shown; i++) fc.push([xOf(nHist + i), yOf(s.forecast[i].value)]);
      if (shown < nFc && frac > 0) {
        var prev = shown === 0 ? s.history[nHist - 1].value : s.forecast[shown - 1].value;
        fc.push([xOf(nHist - 1 + shown + frac),
                 yOf(lerp(prev, s.forecast[shown].value, frac))]);
      }

      function band(loKey, hiKey) {
        if (reveal <= 0) return "";
        var up = [], down = [];
        var last = Math.min(nFc, Math.ceil(reveal));
        for (var i = 0; i < last; i++) {
          var w = clamp(reveal - i, 0, 1);
          var mid = s.forecast[i].value;
          up.push([xOf(nHist + i), yOf(lerp(mid, s.forecast[i][hiKey], w))]);
          down.unshift([xOf(nHist + i), yOf(lerp(mid, s.forecast[i][loKey], w))]);
        }
        var start = [xOf(nHist - 1), yOf(s.history[nHist - 1].value)];
        var pts = [start].concat(up, down, [start]);
        return "M " + pts.map(function (q) {
          return q[0].toFixed(2) + "," + q[1].toFixed(2);
        }).join(" L ") + " Z";
      }

      var path = function (ps) {
        return "M " + ps.map(function (q) {
          return q[0].toFixed(2) + "," + q[1].toFixed(2);
        }).join(" L ");
      };

      return {
        key: kind, y: y0, h: panelH, max: top,
        title: kind === "crashes" ? "Crashes per month" : "Deaths per month",
        color: kind === "crashes" ? PALETTE.volume : PALETTE.severity,
        history: path(hist),
        forecast: path(fc),
        band95: band("lo95", "hi95"),
        band80: band("lo80", "hi80"),
        divider: { x: xOf(nHist - 1), y1: y0, y2: y0 + panelH },
        ticks: niceTicks(top, 4).map(function (v) {
          return { value: v, y: yOf(v), label: fmt(v) };
        }),
        // MAPE belongs to the backtest, not the forecast, so it is stated with
        // the naive comparison it only means something against.
        score: { text: "backtested at MAPE " + s.mape.toFixed(1) + "% against "
                     + s.naive_mape.toFixed(1) + "% for assuming last year repeats",
                 x: plot.x + plot.w, y: y0 - 10, opacity: atRestIn(p) },
      };
    });

    var xTicks = [];
    for (var i = 0; i < total; i += 12) {
      var m = i < nHist ? data.series.crashes.history[i].month
                        : data.series.crashes.forecast[i - nHist].month;
      xTicks.push({ index: i, x: xOf(i), label: m.slice(0, 4) });
    }

    return {
      viewBox: { width: o.width, height: o.height },
      plot: plot, progress: p, reveal: reveal,
      headings: [
        { text: "Five years observed", opacity: swapOut(p) },
        { text: "Planning next year's checkpoint capacity", opacity: swapIn(p) },
      ],
      subtitle: "SARIMA on log counts, twelve months ahead. Bands are 80% and 95% "
              + "intervals, widening with distance.",
      panels: panels, xTicks: xTicks,
      callout: {
        text: "April 2026: " + fmt(data.peak.value) + " crashes (80% interval "
            + fmt(data.peak.lo80) + "–" + fmt(data.peak.hi80) + ") · September is "
            + "the trough at " + fmt(data.trough.value),
        x: 40, y: o.height - 44, opacity: atRestIn(p),
      },
      source: data.source, sourceX: o.width - 40,
    };
  }

  /* ------------------------------------ slide 13b: testing the reporting lag */

  var SLIDE13B_DEFAULTS = {
    // Four rows stack below the plot — tick labels, an axis title, the verdict
    // and the COVID caveat. At 92 the axis title and the caveat shared a
    // baseline and the ticks ran into the verdict.
    width: 1280, height: 660,
    margin: { top: 150, right: 44, bottom: 150, left: 88 },
    panelGap: 88,
    panelSplit: 0.48,
    pointR: 5,
    barShare: 0.6,
    headroom: 1.18,
  };

  /* The concern, tested rather than assumed: months late in the year have a much
   * shorter window to be reported in, so if undercounting were real they would
   * come out low.
   *
   * Left, every month against the length of its reporting window, log x because
   * the windows span 24 to 551 days. Right, the five Decembers ordered by window
   * length — the cleanest possible comparison, since it holds the month constant
   * and varies only the window. Act 2 reveals the Decembers, because the scatter
   * is the test and the Decembers are the verdict.
   */
  function slide13b(data, progress, options) {
    var o = Object.assign({}, SLIDE13B_DEFAULTS, options || {});
    var p = clamp(progress, 0, 1);
    var t = smoothstep(p);
    var plot = plotBox(o);
    var leftW = (plot.w - o.panelGap) * o.panelSplit;
    var rightW = plot.w - o.panelGap - leftW;
    var left = { x: plot.x, y: plot.y, w: leftW, h: plot.h };
    var right = { x: plot.x + leftW + o.panelGap, y: plot.y, w: rightW, h: plot.h };

    var pts = data.points;
    var wLo = pts.reduce(function (m, r) { return Math.min(m, r.window); }, Infinity) * 0.75;
    var wHi = pts.reduce(function (m, r) { return Math.max(m, r.window); }, 0) * 1.3;
    var cHi = o.headroom * pts.reduce(function (m, r) { return Math.max(m, r.crashes); }, 0);
    var logLo = Math.log(wLo), logHi = Math.log(wHi);
    var sx = function (v) { return left.x + (Math.log(v) - logLo) / (logHi - logLo) * left.w; };
    var sy = function (v) { return left.y + left.h - (v / cHi) * left.h; };

    var decs = data.decembers;
    var slotH = right.h / decs.length;
    var barH = slotH * o.barShare;
    var barMax = right.w - 190;
    var decMax = o.headroom * decs.reduce(function (m, r) { return Math.max(m, r.crashes); }, 0);

    return {
      viewBox: { width: o.width, height: o.height },
      plot: plot, left: left, right: right, progress: p,
      headings: [
        { text: "Testing the reporting-lag concern", opacity: swapOut(p) },
        { text: "No undercount found — the correlation runs the wrong way",
          opacity: swapIn(p) },
      ],
      subtitle: "Each yearly file closes at a different time, so months late in the "
              + "year have far less time to be reported in.",
      points: pts.map(function (r, i) {
        return {
          key: "m" + i, month: r.month, late: !!r.late,
          cx: sx(r.window), cy: sy(r.crashes), r: o.pointR,
          // November and December are the short-window months, so they are the
          // ones the concern is actually about.
          color: r.late ? PALETTE.severity : PALETTE.grid,
          opacity: r.late ? 0.95 : 0.6,
        };
      }),
      xTicks: decadeTicks(wLo, wHi).map(function (v) {
        return { value: v, x: sx(v), label: fmt(v) };
      }),
      yTicks: niceTicks(cHi, 4).map(function (v) {
        return { value: v, y: sy(v), label: fmt(v) };
      }),
      axisTitles: [
        { text: data.axis_x, x: left.x + left.w / 2, y: left.y + left.h + 50,
          anchor: "middle" },
        { text: data.axis_y, x: left.x, y: left.y - 16, anchor: "start" },
      ],
      legend: { text: "November and December", color: PALETTE.severity,
                x: left.x + 14, y: left.y + 24 },
      rows: decs.map(function (r, i) {
        var y = right.y + i * slotH + (slotH - barH) / 2;
        return {
          key: r.label, label: r.label + "  ·  " + r.window + "-day window",
          y: y, height: barH, x: right.x + 190,
          width: (r.crashes / decMax) * barMax * t,
          labelX: right.x + 178,
          valueX: right.x + 190 + (r.crashes / decMax) * barMax * t + 10,
          value: fmt(r.crashes), opacity: t,
        };
      }),
      rankTitle: { text: "Each December, ordered by reporting window",
                   x: right.x, y: right.y - 16, opacity: t },
      verdict: {
        text: "Correlation between window length and monthly count = "
            + (data.correlation > 0 ? "+" : "") + data.correlation.toFixed(2)
            + " — negative, the opposite of what undercounting would produce, "
            + "so no adjustment is applied.",
        x: 40, y: o.height - 64, opacity: atRestIn(p),
      },
      caveat: { text: data.caveat, x: 40, y: o.height - 40, opacity: atRestIn(p) },
      source: data.source, sourceX: o.width - 40,
    };
  }

  /* ------------------------------------------- slide 13c: forecast vs. reality */

  var SLIDE13C_DEFAULTS = {
    width: 1280, height: 580,
    // top clears the 34px heading and the 17px subtitle with room for a panel
    // title and a band label above the first band; bottom clears the second
    // panel's ticks, the caveat and the source, each on its own baseline.
    margin: { top: 150, right: 60, bottom: 96, left: 60 },
    panelGap: 96,
    padFrac: 0.16,   // domain padding beyond the data extent, each side
    pointR: 9,
  };

  /* Two horizontal dumbbells, crashes above deaths, each on its own x axis —
   * the same "small multiples, not a shared scale" rule slide12 and slide13
   * both follow, since 2,471 crashes and 320 deaths do not share a unit.
   *
   * Not scroll-driven: this is one comparison, not a story that unfolds with
   * distance, so `progress` is accepted for interface symmetry with every
   * other chart's update(progress) but changes nothing that is drawn.
   * Progress 0 and 1 being the same complete chart is the invariant every
   * other slide in this file works to earn; here it's just trivially true.
   */
  function slide13c(data, progress, options) {
    var o = Object.assign({}, SLIDE13C_DEFAULTS, options || {});
    var p = clamp(progress, 0, 1);   // accepted, unused — see comment above
    var plot = plotBox(o);
    var panelH = (plot.h - o.panelGap) / 2;

    var panels = data.metrics.map(function (m, i) {
      var y0 = plot.y + i * (panelH + o.panelGap);
      var vals = [m.y2025, m.y2026_actual, m.forecast_lo80, m.forecast_hi80];
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      var pad = (hi - lo) * o.padFrac;
      var dLo = lo - pad, dHi = hi + pad;
      var xOf = function (v) { return plot.x + (v - dLo) / (dHi - dLo) * plot.w; };
      var midY = y0 + panelH / 2;
      var held = m.y2026_actual >= m.forecast_lo80 && m.y2026_actual <= m.forecast_hi80;

      return {
        key: m.key, title: m.title, y: y0, h: panelH,
        color: m.key === "crashes" ? PALETTE.volume : PALETTE.severity,
        // Two stacked rows above the band, not one: the title is left-anchored
        // and the band label is centred on the band, so a wide enough band
        // would slide underneath the title if they shared a baseline.
        titleY: y0 - 32,
        band: { x: xOf(m.forecast_lo80), y: y0, height: panelH,
                width: xOf(m.forecast_hi80) - xOf(m.forecast_lo80) },
        bandLabel: { text: "80% predicted range: " + fmt(m.forecast_lo80) + "–"
                         + fmt(m.forecast_hi80),
                     x: xOf((m.forecast_lo80 + m.forecast_hi80) / 2), y: y0 - 12 },
        stick: { x1: xOf(m.y2025), x2: xOf(m.y2026_actual), y: midY },
        p2025: { cx: xOf(m.y2025), cy: midY, r: o.pointR,
                 label: "Apr 2025", value: fmt(m.y2025),
                 labelY: midY - 26, valueY: midY - 8 },
        p2026: { cx: xOf(m.y2026_actual), cy: midY, r: o.pointR, held: held,
                 label: "Apr 2026 (provisional)", value: fmt(m.y2026_actual),
                 labelY: midY + 30, valueY: midY + 48 },
        ticks: niceTicksRange(dLo, dHi, 4).map(function (v) {
          return { value: v, x: xOf(v), label: fmt(v) };
        }),
        axisY: y0 + panelH + 28,
      };
    });

    return {
      viewBox: { width: o.width, height: o.height },
      plot: plot, progress: p,
      heading: "Checking the forecast against April",
      subtitle: "April 2025 vs. April 2026 (provisional), against the forecast's own "
              + "80% interval",
      panels: panels,
      // Its own line above the source, which is right-anchored on the bottom
      // baseline — sharing that baseline overlapped the two strings.
      caveat: { text: data.snapshot_note, x: 40, y: o.height - 38 },
      source: data.source, sourceX: o.width - 40,
    };
  }

  /* -------------------------------------------------- slide 8: the reorder */

  var SLIDE08_DEFAULTS = {
    width: 1280,
    height: 720,
    margin: { top: 128, right: 152, bottom: 76, left: 236 },
    topN: 12,
    spareSlots: 2,      // room below the list for rows entering and leaving
    barShare: 0.62,     // of a row slot; the rest is the gap between bars
    exitSpacing: 0.55,  // slots between rows parked off the bottom of the list
    stagger: 0.02,      // progress offset per row, so the ranking resolves top-down
    labelCharWidth: 9.2,  // ~0.54em at the 17px row label, for overflow checking
  };

  /* One ranked list of provinces physically reordering into the other.
   *
   * The two top-12 lists share only 8 provinces, so the chart is laid out over
   * the *union* of both: 16 rows. Four enter as the ranking changes and four
   * leave. A row that is off one list is parked just past the last visible slot
   * and faded, rather than dropped — dropping it would make the reorder look
   * like a redraw.
   *
   * Bar length is each province's share of its own metric's maximum, because
   * crashes (max 11,115) and deaths (max 485) do not share a unit. Both ends
   * therefore use the full plot width, and the axis and value labels crossfade
   * with the bars so the number on screen always matches the metric it belongs
   * to.
   */
  function slide08(data, progress, options) {
    var o = Object.assign({}, SLIDE08_DEFAULTS, options || {});
    var p = clamp(progress, 0, 1);
    var N = o.topN;

    var plot = {
      x: o.margin.left,
      y: o.margin.top,
      w: o.width - o.margin.left - o.margin.right,
      h: o.height - o.margin.top - o.margin.bottom,
    };
    var rowH = plot.h / (N + o.spareSlots);
    var barH = rowH * o.barShare;

    var all = data.provinces;
    var shown = all.filter(function (d) {
      return d.rank_crashes <= N || d.rank_deaths <= N;
    });

    var maxCrashes = Math.max.apply(null, shown.map(function (d) { return d.crashes; }));
    var maxDeaths = Math.max.apply(null, shown.map(function (d) { return d.deaths; }));

    // Rows parked off the list get consecutive slots in their own rank order, so
    // they leave in the order they were beaten rather than landing on each other.
    function parkOrder(key) {
      return shown.filter(function (d) { return d[key] > N; })
                  .sort(function (a, b) { return a[key] - b[key]; })
                  .map(function (d) { return d.label; });
    }
    var parked = { crashes: parkOrder("rank_crashes"), deaths: parkOrder("rank_deaths") };

    function slotOf(rank, label, which) {
      if (rank <= N) return rank - 1;
      var i = parked[which].indexOf(label);
      return N + (i < 0 ? 0 : i) * o.exitSpacing;
    }

    /* Each row runs its own progress, offset by where it finishes, so the new
     * ranking resolves from the top down instead of all sixteen rows crossing at
     * once — which read as a pile-up at the midpoint. The offsets still resolve
     * to exactly 0 and 1 at the endpoints, so both ends stay pixel-identical to
     * the unstaggered layout. Only geometry is staggered; the text layer switches
     * globally, so the chart never says "crashes" for one row and "deaths" for
     * its neighbour. */
    var finishOrder = shown.slice().sort(function (a, b) {
      return a.rank_deaths - b.rank_deaths;
    }).map(function (d) { return d.label; });
    var span = 1 - o.stagger * Math.max(0, shown.length - 1);

    var rows = shown.map(function (d) {
      var local = smoothstep((p - finishOrder.indexOf(d.label) * o.stagger) / span);
      var slot0 = slotOf(d.rank_crashes, d.label, "crashes");
      var slot1 = slotOf(d.rank_deaths, d.label, "deaths");
      var slot = lerp(slot0, slot1, local);
      var frac = lerp(d.crashes / maxCrashes, d.deaths / maxDeaths, local);
      var vis0 = d.rank_crashes <= N ? 1 : 0;
      var vis1 = d.rank_deaths <= N ? 1 : 0;
      var w = frac * plot.w;
      return {
        key: d.label,
        label: d.label,
        y: plot.y + slot * rowH,
        height: barH,
        x: plot.x,
        width: w,
        color: mixHex(PALETTE.volume, PALETTE.severity, local),
        opacity: lerp(vis0, vis1, local),
        onBothLists: vis0 === 1 && vis1 === 1,
        labelX: plot.x - 14,
        labelWidth: d.label.length * o.labelCharWidth,
        valueX: plot.x + w + 12,
        values: [
          { text: fmt(d.crashes), opacity: fadeOut(p) },
          { text: fmt(d.deaths), opacity: fadeIn(p) },
        ],
        rankFrom: d.rank_crashes,
        rankTo: d.rank_deaths,
      };
    });

    function tickSet(max, opacity) {
      return niceTicks(max, 5).map(function (v) {
        return { value: v, x: plot.x + (v / max) * plot.w, label: fmt(v), opacity: opacity };
      });
    }

    return {
      viewBox: { width: o.width, height: o.height },
      plot: plot,
      rowHeight: rowH,
      progress: p,
      rows: rows,
      tickSets: [
        { metric: "crashes", ticks: tickSet(maxCrashes, fadeOut(p)) },
        { metric: "deaths", ticks: tickSet(maxDeaths, fadeIn(p)) },
      ],
      axisTitles: [
        { text: "Crashes", opacity: swapOut(p), x: plot.x, y: plot.y + plot.h + 52 },
        { text: "Deaths", opacity: swapIn(p), x: plot.x, y: plot.y + plot.h + 52 },
      ],
      headings: [
        { text: "The 12 provinces with the most crashes", opacity: swapOut(p) },
        { text: "The 12 provinces with the most deaths", opacity: swapIn(p) },
      ],
      subtitle: "Only 8 provinces are on both lists. Bangkok has the most crashes "
              + "and does not reach the top 12 for deaths.",
      // Bottom-right, because the axis title owns the bottom-left corner.
      source: "Highway accident records, Ministry of Transport, 2021–2025",
      sourceX: o.width - 40,
      totals: { crashes: data.total_crashes, deaths: data.total_deaths },
    };
  }

  /* ---------------------------------------------- slide 4: cause reorder */

  var SLIDE04_DEFAULTS = {
    width: 1280,
    height: 720,
    // left is wide enough for "Unfamiliar route / inexperience" (32 chars) at
    // labelCharWidth — the longest cause name in the folded taxonomy.
    margin: { top: 128, right: 160, bottom: 76, left: 306 },
    barShare: 0.66,
    stagger: 0.012,        // smaller than slide08's — 18 rows, not 16, over the full range
    labelCharWidth: 8.4,
  };

  /* Bars reorder from most-common cause to most-lethal cause. All 18 causes
   * clearing the figure pipeline's 200-crash threshold are shown at both ends —
   * unlike slide 8, nothing enters or leaves, so this needs none of slide08's
   * union/park machinery, only the reorder-plus-crossfade half of it.
   *
   * Share of crashes and deaths-per-100 do not share a unit, so — same rule as
   * slide 8 — bar length is each cause's fraction of its own metric's maximum,
   * and the value label and axis crossfade with it rather than showing an
   * interpolated number that is true of neither metric.
   */
  function slide04(data, progress, options) {
    var o = Object.assign({}, SLIDE04_DEFAULTS, options || {});
    var p = clamp(progress, 0, 1);
    var causes = data.causes;
    var N = causes.length;

    var plot = {
      x: o.margin.left, y: o.margin.top,
      w: o.width - o.margin.left - o.margin.right,
      h: o.height - o.margin.top - o.margin.bottom,
    };
    var rowH = plot.h / N;
    var barH = rowH * o.barShare;

    var maxShare = Math.max.apply(null, causes.map(function (c) { return c.share; }));
    var maxRate = Math.max.apply(null, causes.map(function (c) { return c.death_rate; }));

    // Ranks computed here rather than trusted from file order, so a reordered
    // export cannot silently change which end of the chart is "most common".
    var byShare = causes.slice().sort(function (a, b) { return b.share - a.share; });
    var byRate = causes.slice().sort(function (a, b) { return b.death_rate - a.death_rate; });
    var rank0 = {}, rank1 = {};
    byShare.forEach(function (c, i) { rank0[c.label] = i; });
    byRate.forEach(function (c, i) { rank1[c.label] = i; });

    var finishOrder = byRate.map(function (c) { return c.label; });
    var span = 1 - o.stagger * Math.max(0, N - 1);

    var rows = causes.map(function (c) {
      var local = smoothstep((p - finishOrder.indexOf(c.label) * o.stagger) / span);
      var slot = lerp(rank0[c.label], rank1[c.label], local);
      var frac = lerp(c.share / maxShare, c.death_rate / maxRate, local);
      var w = frac * plot.w;
      return {
        key: c.label, label: c.label,
        y: plot.y + slot * rowH, height: barH, x: plot.x, width: w,
        color: mixHex(PALETTE.volume, PALETTE.severity, local),
        opacity: 1,
        labelX: plot.x - 14,
        labelWidth: c.label.length * o.labelCharWidth,
        valueX: plot.x + w + 12,
        values: [
          { text: c.share.toFixed(1) + "%", opacity: fadeOut(p) },
          { text: c.death_rate.toFixed(1), opacity: fadeIn(p) },
        ],
        rankFrom: rank0[c.label], rankTo: rank1[c.label],
      };
    });

    function tickSet(max, opacity, isPercent) {
      return niceTicks(max, 5).map(function (v) {
        return {
          value: v, x: plot.x + (v / max) * plot.w,
          label: isPercent ? v.toFixed(0) + "%" : fmt(v), opacity: opacity,
        };
      });
    }

    return {
      viewBox: { width: o.width, height: o.height },
      plot: plot, rowHeight: rowH, progress: p, rows: rows,
      tickSets: [
        { metric: "share", ticks: tickSet(maxShare, fadeOut(p), true) },
        { metric: "death_rate", ticks: tickSet(maxRate, fadeIn(p), false) },
      ],
      axisTitles: [
        { text: "% of all crashes", opacity: swapOut(p), x: plot.x, y: plot.y + plot.h + 52 },
        { text: "Deaths per 100 crashes", opacity: swapIn(p), x: plot.x, y: plot.y + plot.h + 52 },
      ],
      headings: [
        { text: "The most common causes", opacity: swapOut(p) },
        { text: "The most lethal causes", opacity: swapIn(p) },
      ],
      // Placeholder wording — Slide 4's caption is pinned to the agreed limitation
      // copy (ticket 10) and is revisited once that text is final, per ticket 20.
      // The geometry above does not change when the words do.
      subtitle: "Speeding is 71% of crashes but kills below the average rate. "
              + "Alcohol sits in the deadliest tier, alongside several smaller causes.",
      source: "Highway accident records, Ministry of Transport, 2021–2025",
      sourceX: o.width - 40,
      totals: { crashes: data.total_crashes, deaths: data.total_deaths },
    };
  }

  /* ------------------------------- slide 4, act 3: the evidence behind a rate */

  var SLIDE04_ACT3_DEFAULTS = {
    focusCount: 3,
    focusBarShare: 0.26,   // of a 3-row band, which is 6x taller than an 18-row one
    bandTopPad: 22,        // band top -> bar top
    subLabelGap: 30,       // bar bottom -> the muted "44.8 deaths per 100" line
    loserFadeEnd: 0.4,     // losers are gone before the survivors start moving
    expandStart: 0.3,
    // The cause the surrounding slide is actually about. Named rather than
    // inferred: alcohol is the deck's headline cause and finishes *last* of the
    // three by rate, so nothing about its position marks it out — which is the
    // whole reason act 3 exists, and the reason it needs enclosing by hand.
    emphasisLabel: "Alcohol",
    haloPad: 10,
  };

  /* Acts 1 and 2 raise a question they cannot settle: the lethal ranking is led
   * by two causes carrying a few hundred crashes each, so is alcohol's third
   * place the real finding or a small-sample artefact? Act 3 answers it.
   *
   * The three survivors keep the vertical position the death-rate ranking gave
   * them — position still means "how deadly" — while bar length crossfades to
   * how many crashes each rate was computed from. Alcohol therefore finishes
   * last in the list and longest on the page, and that mismatch is the whole
   * argument: its 22.0 rests on 1,565 crashes against roughly 450 for the two
   * ranked above it. Deliberately NOT a re-sort — re-sorting by crash count
   * would read as "ranked by crashes" and throw the tension away.
   *
   * Built by interpolating away from slide04(data, 1) rather than re-deriving
   * the ranking, so scene 2's end state and act 3's start state are the same
   * geometry by construction and cannot drift apart.
   */
  function slide04Act3(data, progress, options) {
    var o = Object.assign({}, SLIDE04_DEFAULTS, SLIDE04_ACT3_DEFAULTS, options || {});
    var q = clamp(progress, 0, 1);
    var base = slide04(data, 1, options);
    var plot = base.plot;

    // Losers clear the stage before the survivors expand into it. Doing both at
    // once overlaps rows 1-3 with rows 4-18 mid-flight.
    var leave = clamp(q / o.loserFadeEnd, 0, 1);
    var grow = smoothstep(clamp((q - o.expandStart) / (1 - o.expandStart), 0, 1));

    var byRate = data.causes.slice().sort(function (a, b) { return b.death_rate - a.death_rate; });
    var focus = byRate.slice(0, o.focusCount);
    var focusRank = {};
    focus.forEach(function (c, i) { focusRank[c.label] = i; });
    var maxCrashes = Math.max.apply(null, focus.map(function (c) { return c.crashes; }));

    var bandH = plot.h / o.focusCount;
    var focusBarH = bandH * o.focusBarShare;

    var byLabel = {};
    data.causes.forEach(function (c) { byLabel[c.label] = c; });

    var rows = base.rows.map(function (r) {
      var c = byLabel[r.key];
      var isFocus = focusRank[r.key] !== undefined;

      if (!isFocus) {
        // Fades where it stands. A row on its way out that also moves reads as
        // a fourth ranking rather than as an exit.
        return Object.assign({}, r, {
          opacity: 1 - leave,
          // Its value label fades on the same schedule as the survivors', not
          // on the row's own. Leaving it lit and relying on the row group's
          // opacity to hide it would make the layout assert two contradictory
          // things about one frame, and only the DOM would know which won.
          values: r.values.map(function (v, k) {
            return { text: v.text, opacity: k === 1 ? fadeOut(q) : 0 };
          }).concat([{ text: fmt(c.crashes), opacity: 0 }]),
          subLabel: { text: c.death_rate.toFixed(1) + " deaths per 100", opacity: 0,
                      x: r.labelX, y: r.y + r.height + o.subLabelGap },
          halo: haloFor(r, o, 0),
          emphasis: false,
        });
      }

      var i = focusRank[r.key];
      var y = lerp(r.y, plot.y + i * bandH + o.bandTopPad, grow);
      var h = lerp(r.height, focusBarH, grow);
      var w = lerp(r.width, (c.crashes / maxCrashes) * plot.w, grow);
      var isEmph = r.key === o.emphasisLabel;
      return Object.assign({}, r, {
        y: y, height: h, width: w, opacity: 1, valueX: plot.x + w + 12,
        // Enclosure and bold type arrive with the count they are pointing at,
        // so nothing is marked out before there is a reason to look at it.
        halo: haloFor({ x: r.x, y: y, width: w, height: h }, o, isEmph ? fadeIn(q) : 0),
        emphasis: isEmph && q >= 0.5,
        // The same gapped crossfade acts 1-2 use: the rate is off the bar
        // before the count arrives, because a number interpolated between
        // 22.0 and 1,565 is true of neither.
        values: r.values.map(function (v, k) {
          return { text: v.text, opacity: k === 1 ? fadeOut(q) : 0 };
        }).concat([{ text: fmt(c.crashes), opacity: fadeIn(q) }]),
        subLabel: {
          text: c.death_rate.toFixed(1) + " deaths per 100",
          opacity: fadeIn(q), x: r.labelX, y: y + h + o.subLabelGap,
        },
      });
    });

    return Object.assign({}, base, {
      rows: rows,
      tickSets: [
        { metric: "share", ticks: base.tickSets[0].ticks.map(function (t) {
            return Object.assign({}, t, { opacity: 0 }); }) },
        { metric: "death_rate", ticks: base.tickSets[1].ticks.map(function (t) {
            return Object.assign({}, t, { opacity: fadeOut(q) }); }) },
        { metric: "crashes", ticks: crashTicks(plot, maxCrashes, fadeIn(q)) },
      ],
      axisTitles: base.axisTitles.map(function (a, i) {
        return Object.assign({}, a, { opacity: i === 1 ? swapOut(q) : 0 });
      }).concat([{ text: "Crashes recorded", opacity: swapIn(q),
                   x: plot.x, y: plot.y + plot.h + 52 }]),
      headings: base.headings.map(function (hd, i) {
        return Object.assign({}, hd, { opacity: i === 1 ? swapOut(q) : 0 });
      }).concat([{ text: "The evidence behind each rate", opacity: swapIn(q) }]),
      subtitle: q < 0.5 ? base.subtitle
        : "Bar length is now how many crashes each rate was computed from — "
          + fmt(focus[o.focusCount - 1].crashes) + " for "
          + focus[o.focusCount - 1].label.toLowerCase() + ", against "
          + focus.slice(0, o.focusCount - 1).map(function (c) { return fmt(c.crashes); }).join(" and ")
          + " for the two ranked above it.",
      progress: q,
    });
  }

  // The enclosure drawn round an emphasised bar. Returned for every row at
  // every progress (opacity 0 where it should not show) because render.js
  // builds its nodes once, at progress 0 — a shape that appears later would
  // never get one.
  function haloFor(bar, o, opacity) {
    return {
      x: bar.x - o.haloPad, y: bar.y - o.haloPad,
      width: Math.max(0, bar.width) + o.haloPad * 2,
      height: bar.height + o.haloPad * 2,
      opacity: opacity,
    };
  }

  // Tick count must not vary with progress: render.js builds one node per tick
  // at mount time and only moves them afterwards.
  function crashTicks(plot, maxCrashes, opacity) {
    return niceTicks(maxCrashes, 4).map(function (v) {
      return { value: v, x: plot.x + (v / maxCrashes) * plot.w, label: fmt(v), opacity: opacity };
    });
  }

  /* The whole Slide 4 story as one scalar, so the page holds no act arithmetic
   * and the seam between acts is covered by the check script rather than by a
   * number typed into an HTML file. slide04() itself is untouched — it remains
   * the two-act reorder, with its own invariants intact.
   *
   * Acts 1-2 are padded up to act 3's richer shape (a third value per row, a
   * third tick set, axis title and heading, all at opacity 0) because render.js
   * builds its DOM once, from the layout returned at progress 0.
   */
  var SLIDE04_ACT3_START = 2 / 3;

  function slide04Story(data, progress, options) {
    var p = clamp(progress, 0, 1);
    if (p >= SLIDE04_ACT3_START) {
      return slide04Act3(data, (p - SLIDE04_ACT3_START) / (1 - SLIDE04_ACT3_START), options);
    }

    var o = Object.assign({}, SLIDE04_DEFAULTS, SLIDE04_ACT3_DEFAULTS, options || {});
    var m = slide04(data, p / SLIDE04_ACT3_START, options);
    var byRate = data.causes.slice().sort(function (a, b) { return b.death_rate - a.death_rate; });
    var maxCrashes = Math.max.apply(null, byRate.slice(0, o.focusCount)
      .map(function (c) { return c.crashes; }));
    var byLabel = {};
    data.causes.forEach(function (c) { byLabel[c.label] = c; });

    return Object.assign({}, m, {
      rows: m.rows.map(function (r) {
        var c = byLabel[r.key];
        return Object.assign({}, r, {
          values: r.values.concat([{ text: fmt(c.crashes), opacity: 0 }]),
          subLabel: { text: c.death_rate.toFixed(1) + " deaths per 100", opacity: 0,
                      x: r.labelX, y: r.y + r.height + o.subLabelGap },
          halo: haloFor(r, o, 0),
          emphasis: false,
        });
      }),
      tickSets: m.tickSets.concat([
        { metric: "crashes", ticks: crashTicks(m.plot, maxCrashes, 0) },
      ]),
      axisTitles: m.axisTitles.concat([
        { text: "Crashes recorded", opacity: 0, x: m.plot.x, y: m.plot.y + m.plot.h + 52 },
      ]),
      headings: m.headings.concat([{ text: "The evidence behind each rate", opacity: 0 }]),
      progress: p,
    });
  }

  /* ------------------------------------------------- slide 9: AADT scatter */

  var SLIDE09_DEFAULTS = {
    width: 1280,
    height: 720,
    // Bottom margin carries tick labels, then the x-axis title, then the source
    // line. At 86 the axis title and the source overlapped by a pixel.
    margin: { top: 132, right: 64, bottom: 104, left: 100 },
    pointRadius: 5,
    trendSamples: 40,
    // Round AADT values worth a tick, filtered to what the data actually spans.
    tickCandidates: [1000, 3000, 10000, 30000, 100000, 200000],
  };

  /* AADT vs crash count flattens into AADT vs fatality rate, on one shared,
   * unmoving x-axis (natural-log of AADT) — the ticket's explicit requirement,
   * because independently rescaling either panel's x-axis could make a flat
   * relationship look like it is flattening for the wrong reason.
   *
   * Points reposition by their own fraction of each metric's maximum, the same
   * convention slides 4 and 8 use for a bar's length — reasonable there because
   * a bar only has to be legible, not compared in steepness to another bar.
   *
   * The trendline cannot use that convention and stay honest. Deaths-per-crash
   * (max ~55 per 100) sits inside a far smaller range than crash counts
   * (max 1,893), so a max-fraction trendline for the *weak* relationship comes
   * out looking just as steep as the *strong* one — a rescaling artefact on the
   * y-axis standing in for the one the ticket already calls out on x. Instead
   * the trendline's steepness is drawn directly from what "flatter" actually
   * means here: `panel_a.pearson_r` (0.50) against `panel_b.pearson_r` (-0.17),
   * the two numbers the deck itself reports. The line is centred and its total
   * rise is proportional to |r| — an explanatory schematic of the correlation
   * strength, not a literal regression line through the point cloud, and
   * documented as such rather than presented as more precise than it is.
   */
  function slide09(data, progress, options) {
    var o = Object.assign({}, SLIDE09_DEFAULTS, options || {});
    var p = clamp(progress, 0, 1);
    var eased = smoothstep(p);
    var pts = data.points;

    var plot = {
      x: o.margin.left, y: o.margin.top,
      w: o.width - o.margin.left - o.margin.right,
      h: o.height - o.margin.top - o.margin.bottom,
    };

    var logs = pts.map(function (d) { return Math.log(d.aadt); });
    var minLog = Math.min.apply(null, logs), maxLog = Math.max.apply(null, logs);
    var maxCrashes = Math.max.apply(null, pts.map(function (d) { return d.crashes; }));
    // Displayed as deaths per 100 crashes throughout the project — never invent
    // a second unit for the same quantity.
    var maxDpc = Math.max.apply(null, pts.map(function (d) { return d.deaths_per_crash * 100; }));

    function xOf(aadt) {
      return plot.x + (Math.log(aadt) - minLog) / (maxLog - minLog) * plot.w;
    }
    function yOf(frac) { return plot.y + (1 - clamp(frac, 0, 1)) * plot.h; }

    var points = pts.map(function (d, i) {
      var fracA = d.crashes / maxCrashes;
      var fracB = (d.deaths_per_crash * 100) / maxDpc;
      return {
        key: "p" + i, route: d.route, province: d.province,
        x: xOf(d.aadt), y: yOf(lerp(fracA, fracB, eased)),
        r: o.pointRadius,
        color: mixHex(PALETTE.volume, PALETTE.severity, eased),
      };
    });

    var A = data.panel_a, B = data.panel_b;
    // Total rise across the panel, as a fraction of plot height, scaled by the
    // correlation strength — 1.0 would span the full plot; AMP caps it well
    // inside so a |r| near 1 still leaves margin at top and bottom. Centred on
    // the point cloud's own mean fraction (most crash counts are small, so that
    // mean sits low), not the plot's geometric midpoint — a line correctly
    // sized for "how steep" but centred somewhere the data never visits would
    // read as unconnected to the scatter it sits above.
    var AMP = 0.84;
    var ampA = Math.sign(A.slope || A.pearson_r) * Math.abs(A.pearson_r) * AMP;
    var ampB = Math.sign(B.slope || B.pearson_r) * Math.abs(B.pearson_r) * AMP;
    var centerA = mean(pts.map(function (d) { return d.crashes / maxCrashes; }));
    var centerB = mean(pts.map(function (d) { return (d.deaths_per_crash * 100) / maxDpc; }));
    var trend = [];
    for (var i = 0; i <= o.trendSamples; i++) {
      var t = i / o.trendSamples;
      var lx = lerp(minLog, maxLog, t);
      var fracA = clamp(centerA + ampA * (t - 0.5), 0, 1);
      var fracB = clamp(centerB + ampB * (t - 0.5), 0, 1);
      trend.push([plot.x + t * plot.w, yOf(lerp(fracA, fracB, eased))]);
    }
    var trendPath = "M " + trend.map(function (pt) {
      return pt[0].toFixed(2) + "," + pt[1].toFixed(2);
    }).join(" L ");

    var loAadt = Math.exp(minLog), hiAadt = Math.exp(maxLog);
    var xTicks = o.tickCandidates
      .filter(function (v) { return v >= loAadt * 0.98 && v <= hiAadt * 1.02; })
      .map(function (v) {
        return { value: v, x: xOf(v), label: v >= 1000 ? (v / 1000) + "k" : String(v) };
      });

    function yTickSet(max, opacity, isRate) {
      return niceTicks(max, 5).map(function (v) {
        return { value: v, y: yOf(v / max), label: isRate ? v.toFixed(0) : fmt(v), opacity: opacity };
      });
    }

    return {
      viewBox: { width: o.width, height: o.height },
      plot: plot, progress: p,
      points: points,
      trendPath: trendPath,
      trendColor: mixHex(PALETTE.volume, PALETTE.severity, eased),
      xTicks: xTicks,
      tickSets: [
        { metric: "crashes", ticks: yTickSet(maxCrashes, fadeOut(p), false) },
        { metric: "deaths_per_crash", ticks: yTickSet(maxDpc, fadeIn(p), true) },
      ],
      axisTitles: [
        { text: "Crashes per section (5-year total)", opacity: swapOut(p),
          x: plot.x, y: plot.y - 16 },
        { text: "Deaths per 100 crashes", opacity: swapIn(p), x: plot.x, y: plot.y - 16 },
      ],
      xAxisTitle: { text: "Annual average daily traffic (log scale)",
                   x: plot.x + plot.w / 2, y: plot.y + plot.h + 54 },
      headings: [
        { text: "Traffic volume predicts how many crashes happen", opacity: swapOut(p) },
        { text: "...but not how deadly they are", opacity: swapIn(p) },
      ],
      subtitle: "160 survey sections on the six main highway routes. Same x-axis "
              + "throughout, so the flattening trendline is a real comparison.",
      source: "Highway accident records + AADT, Dept. of Highways / Dept. of Rural Roads, 2021–2025",
      sourceX: o.width - 40,
      scopeNote: data.scope_note,
    };
  }

  /* --------------------------------------------- slide 12: monthly reveal */

  var SLIDE12_DEFAULTS = {
    width: 1280,
    height: 720,
    // Top margin stacks a heading, a subtitle, the campaign-window summary and
    // then each panel's own title. At 108 the subtitle ran into the first panel
    // title, and at full reveal the summary landed on the subtitle as well.
    margin: { top: 150, right: 56, bottom: 60, left: 84 },
    panelGap: 44,
    headroom: 1.18,          // matches fig12_monthly_series's own ax.set_ylim(0, max*1.18)
    bandApproach: 2.2,       // months of lead-in before a campaign window shades in
    xTickEvery: 12,          // one tick per January
  };

  /* The monthly series draws in as the presenter scrolls, and the Seven
   * Dangerous Days windows shade in just ahead of the reveal reaching them —
   * "on approach" rather than snapping on, so the eye is cued before the
   * number is spoken.
   *
   * Crashes and deaths get their own stacked panel rather than a shared or
   * dual axis, the same rule the matplotlib figures already follow: they are
   * different units, and forcing them onto one scale invents a relationship
   * (see the comment on volume_vs_severity in 02_figs_descriptive.py).
   *
   * `progress` is a reveal fraction, not a swap point: 0 shows the frame with
   * nothing drawn yet, 1 shows the complete five-year series with every window
   * shaded and labelled. Both are deliberately valid, readable states — "shows
   * nothing yet" is not the same defect as "shows something wrong".
   */
  function slide12(data, progress, options) {
    var o = Object.assign({}, SLIDE12_DEFAULTS, options || {});
    var p = clamp(progress, 0, 1);
    var months = data.months;
    var last = months.length - 1;
    var reveal = p * last;

    var plot = {
      x: o.margin.left, y: o.margin.top,
      w: o.width - o.margin.left - o.margin.right,
      h: o.height - o.margin.top - o.margin.bottom,
    };
    var panelH = (plot.h - o.panelGap) / 2;
    var panels = {
      crashes: { key: "crashes", y: plot.y, h: panelH, color: PALETTE.volume,
                title: "Crashes per month" },
      deaths: { key: "deaths", y: plot.y + panelH + o.panelGap, h: panelH,
               color: PALETTE.severity, title: "Deaths per month" },
    };
    var domainMax = {
      crashes: Math.max.apply(null, months.map(function (m) { return m.crashes; })) * o.headroom,
      deaths: Math.max.apply(null, months.map(function (m) { return m.deaths; })) * o.headroom,
    };

    function xOf(i) { return plot.x + (i / last) * plot.w; }
    function yOf(panel, v, max) { return panel.y + panel.h - (v / max) * panel.h; }

    function buildPath(key) {
      var panel = panels[key], max = domainMax[key];
      var full = Math.min(last, Math.floor(reveal));
      var pts = [];
      for (var i = 0; i <= full; i++) {
        pts.push([xOf(i), yOf(panel, months[i][key], max)]);
      }
      if (full < last) {
        var frac = reveal - full;
        var v = lerp(months[full][key], months[full + 1][key], frac);
        pts.push([xOf(full + frac), yOf(panel, v, max)]);
      }
      return "M " + pts.map(function (pt) {
        return pt[0].toFixed(2) + "," + pt[1].toFixed(2);
      }).join(" L ");
    }

    var lines = {
      crashes: { path: buildPath("crashes"), color: panels.crashes.color },
      deaths: { path: buildPath("deaths"), color: panels.deaths.color },
    };

    // Only calendar months that actually exist in the data get a band — the
    // last New Year window's January half falls after Dec 2025 and is honestly
    // absent, not padded in.
    var idxOf = {};
    months.forEach(function (m, i) { idxOf[m.month] = i; });
    var bands = [];
    for (var y = 2021; y <= 2025; y++) {
      var apr = idxOf[y + "-04"];
      if (apr !== undefined) {
        bands.push({ type: "songkran", year: y, start: apr, end: apr,
                    multiple: data.campaign_windows.songkran_11_17_apr.crash_multiple });
      }
      var dec = idxOf[y + "-12"], jan = idxOf[(y + 1) + "-01"];
      if (dec !== undefined) {
        bands.push({ type: "new_year", year: y, start: dec, end: jan !== undefined ? jan : dec,
                    multiple: data.campaign_windows.new_year_30dec_5jan.crash_multiple });
      }
    }

    function bandOpacity(b) {
      return b.start <= reveal ? 1 : clamp((reveal - (b.start - o.bandApproach)) / o.bandApproach, 0, 1);
    }

    var bandGeom = bands.map(function (b) {
      // A single-month band still needs visible width: pad half a month slot
      // either side rather than collapsing to a zero-width line.
      var padded = b.start === b.end;
      var x0 = xOf(b.start) - (padded ? (plot.w / last) * 0.42 : 0);
      var x1 = xOf(b.end) + (padded ? (plot.w / last) * 0.42 : 0);
      return {
        type: b.type, year: b.year, x: x0, width: Math.max(0, x1 - x0),
        opacity: bandOpacity(b) * 0.24,
        // Month indices, not pixels — exposed so a check can confirm a band
        // starts lighting up before the reveal cursor reaches it, not at it.
        startIndex: b.start, endIndex: b.end,
      };
    });

    // Ten occurrences across five years have no room for ten persistent labels
    // on a 1280px-wide chart without overlapping each other — a first attempt
    // at per-band multiplier text did exactly that. One summary reads instead,
    // fading in once the reveal is essentially complete.
    var summaryOpacity = clamp((reveal - (last - 2.4)) / 2.4, 0, 1);

    var xTicks = [];
    for (var i = 0; i <= last; i += o.xTickEvery) {
      xTicks.push({ index: i, x: xOf(i), label: months[i].month.slice(0, 4) });
    }

    function yTickSet(key) {
      var panel = panels[key], max = domainMax[key];
      return niceTicks(max, 4).map(function (v) {
        return { value: v, y: yOf(panel, v, max), label: fmt(v) };
      });
    }

    return {
      viewBox: { width: o.width, height: o.height },
      plot: plot, progress: p, reveal: reveal,
      panels: [
        Object.assign({}, panels.crashes, { line: lines.crashes,
          ticks: yTickSet("crashes") }),
        Object.assign({}, panels.deaths, { line: lines.deaths,
          ticks: yTickSet("deaths") }),
      ],
      bands: bandGeom,
      xTicks: xTicks,
      heading: "Festivals drive the year, not the calendar average",
      // Placeholder — pinned to the settled limitation copy (ticket 10) before
      // rehearsal, same as slide 4. Multipliers are read from `campaign_windows`
      // only; `superseded_windows` in the export exists purely to trace numbers
      // that moved between drafts and must never reach a chart.
      subtitle: "Seven Dangerous Days: Songkran 11–17 April, New Year 30 December – "
              + "5 January. Shaded as the series reaches each one.",
      // Right-anchored on the same baseline as the crashes panel's own title,
      // so it reads as this panel's second line rather than colliding with the
      // year ticks along the bottom of the deaths panel below.
      summary: {
        text: "Songkran runs " + data.campaign_windows.songkran_11_17_apr.crash_multiple.toFixed(2)
            + "× an ordinary day · New Year " + data.campaign_windows.new_year_30dec_5jan.crash_multiple.toFixed(2)
            + "× — level with each other",
        opacity: summaryOpacity,
        // Its own line between the subtitle and the panel titles, right-anchored.
        // On the panel-title baseline it overlapped the subtitle, which runs most
        // of the width.
        x: o.width - 40, y: o.margin.top - 50,
      },
      source: "Highway accident records, Ministry of Transport, 2021–2025",
      sourceX: o.width - 40,
    };
  }

  return {
    PALETTE: PALETTE,
    clamp: clamp,
    lerp: lerp,
    smoothstep: smoothstep,
    fadeIn: fadeIn,
    fadeOut: fadeOut,
    atRestIn: atRestIn,
    atRestOut: atRestOut,
    REST_BAND: REST_BAND,
    swapIn: swapIn,
    swapOut: swapOut,
    mixHex: mixHex,
    niceTicks: niceTicks,
    progressFor: progressFor,
    nextStop: nextStop,
    slide04: slide04,
    slide04Act3: slide04Act3,
    slide04Story: slide04Story,
    SLIDE04_ACT3_START: SLIDE04_ACT3_START,
    slide05: slide05,
    SLIDE05_DEFAULTS: SLIDE05_DEFAULTS,
    slide06: slide06,
    SLIDE06_DEFAULTS: SLIDE06_DEFAULTS,
    SLIDE06_STOPS: SLIDE06_STOPS,
    slide07: slide07,
    SLIDE07_DEFAULTS: SLIDE07_DEFAULTS,
    slide08: slide08,
    slide10: slide10,
    SLIDE10_DEFAULTS: SLIDE10_DEFAULTS,
    slide10b: slide10b,
    SLIDE10B_DEFAULTS: SLIDE10B_DEFAULTS,
    slide11: slide11,
    SLIDE11_DEFAULTS: SLIDE11_DEFAULTS,
    slide13: slide13,
    SLIDE13_DEFAULTS: SLIDE13_DEFAULTS,
    slide13b: slide13b,
    SLIDE13B_DEFAULTS: SLIDE13B_DEFAULTS,
    slide13c: slide13c,
    SLIDE13C_DEFAULTS: SLIDE13C_DEFAULTS,
    niceTicksRange: niceTicksRange,
    slide09: slide09,
    slide12: slide12,
    SLIDE04_DEFAULTS: SLIDE04_DEFAULTS,
    SLIDE08_DEFAULTS: SLIDE08_DEFAULTS,
    SLIDE09_DEFAULTS: SLIDE09_DEFAULTS,
    SLIDE12_DEFAULTS: SLIDE12_DEFAULTS,
  };
});
