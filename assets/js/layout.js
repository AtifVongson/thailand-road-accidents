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
        });
      }

      var i = focusRank[r.key];
      var y = lerp(r.y, plot.y + i * bandH + o.bandTopPad, grow);
      var h = lerp(r.height, focusBarH, grow);
      var w = lerp(r.width, (c.crashes / maxCrashes) * plot.w, grow);
      return Object.assign({}, r, {
        y: y, height: h, width: w, opacity: 1, valueX: plot.x + w + 12,
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
    margin: { top: 132, right: 64, bottom: 86, left: 100 },
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
    margin: { top: 108, right: 56, bottom: 60, left: 84 },
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
        x: o.width - 40, y: panels.crashes.y - 12,
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
    swapIn: swapIn,
    swapOut: swapOut,
    mixHex: mixHex,
    niceTicks: niceTicks,
    progressFor: progressFor,
    slide04: slide04,
    slide04Act3: slide04Act3,
    slide04Story: slide04Story,
    SLIDE04_ACT3_START: SLIDE04_ACT3_START,
    slide08: slide08,
    slide09: slide09,
    slide12: slide12,
    SLIDE04_DEFAULTS: SLIDE04_DEFAULTS,
    SLIDE08_DEFAULTS: SLIDE08_DEFAULTS,
    SLIDE09_DEFAULTS: SLIDE09_DEFAULTS,
    SLIDE12_DEFAULTS: SLIDE12_DEFAULTS,
  };
});
