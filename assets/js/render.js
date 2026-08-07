/* Turns geometry from layout.js into SVG elements. Nothing else belongs here.
 *
 * No scales, no ticks, no interpolation, no data reshaping — if a number is
 * computed in this file, it is in the wrong file, because nothing here can be
 * tested without a browser and this project has never had a dependable one.
 *
 * Elements are created once and then updated in place, so scrolling mutates
 * attributes rather than rebuilding the DOM on every frame.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChartRender = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";

  function el(name, attrs, text) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) if (attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function set(node, attrs) {
    for (var k in attrs) if (attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
  }

  function getLayout() {
    return typeof ChartLayout !== "undefined" ? ChartLayout : require("./layout.js");
  }

  /* -------------------------------------------------- shared: bar reorder */

  /* Slides 4 and 8 are the same shape — a headline pair, a crossfading axis,
   * and a set of rows whose position, length and colour are all the layout
   * module returns. `layoutFn` is `ChartLayout.slide04` or `.slide08`. */
  function mountBarChart(mount, layoutFn, data, options, ariaLabel) {
    var L = getLayout();
    var first = layoutFn(data, 0, options);

    var svg = el("svg", {
      class: "chart",
      viewBox: "0 0 " + first.viewBox.width + " " + first.viewBox.height,
      role: "img", "aria-label": ariaLabel,
    });

    var gGrid = el("g", { class: "c-grid" });
    var gBars = el("g", { class: "c-bars" });
    var gText = el("g", { class: "c-text" });
    svg.appendChild(gGrid); svg.appendChild(gBars); svg.appendChild(gText);

    var headings = first.headings.map(function (h) {
      var t = el("text", { class: "c-heading", x: 40, y: 62 }, h.text);
      gText.appendChild(t);
      return t;
    });
    var subtitle = el("text", { class: "c-subtitle", x: 40, y: 94 }, first.subtitle);
    gText.appendChild(subtitle);
    gText.appendChild(el("text", {
      class: "c-source", x: first.sourceX, y: first.viewBox.height - 18, "text-anchor": "end",
    }, first.source));

    var baseline = el("line", {
      class: "c-baseline", x1: first.plot.x, x2: first.plot.x,
      y1: first.plot.y - 10, y2: first.plot.y + first.plot.h,
    });
    gGrid.appendChild(baseline);

    var tickGroups = first.tickSets.map(function (ts) {
      var g = el("g", {});
      var parts = ts.ticks.map(function (t) {
        var line = el("line", {
          class: "c-gridline", x1: t.x, x2: t.x,
          y1: first.plot.y - 10, y2: first.plot.y + first.plot.h,
        });
        var label = el("text", {
          class: "c-tick", x: t.x, y: first.plot.y + first.plot.h + 24,
        }, t.label);
        g.appendChild(line); g.appendChild(label);
        return { line: line, label: label };
      });
      gGrid.appendChild(g);
      return { group: g, parts: parts };
    });

    var axisTitles = first.axisTitles.map(function (a) {
      var t = el("text", { class: "c-axistitle", x: a.x, y: a.y }, a.text);
      gText.appendChild(t);
      return t;
    });

    var rows = {};
    first.rows.forEach(function (r) {
      var g = el("g", {});
      var bar = el("rect", { class: "c-bar", rx: 3, x: r.x, height: r.height });
      var name = el("text", { class: "c-rowlabel" + (r.onBothLists ? " is-both" : "") }, r.label);
      var values = r.values.map(function (v) {
        var t = el("text", { class: "c-value" }, v.text);
        g.appendChild(t);
        return t;
      });
      // Optional second line under the row label — Slide 4's act 3 uses it to
      // keep each cause's death rate on screen while the bar switches to
      // showing how many crashes that rate came from. Layouts that never
      // return `subLabel` (slide 8) create no node at all.
      var sub = r.subLabel === undefined ? null
        : el("text", { class: "c-sublabel" }, r.subLabel.text);
      // Stroke-only enclosure, drawn in front of its bar but behind the text,
      // so it can never obscure a number.
      var halo = r.halo === undefined ? null : el("rect", { class: "c-halo", rx: 6 });
      g.insertBefore(bar, g.firstChild);
      if (halo) g.insertBefore(halo, bar.nextSibling);
      g.appendChild(name);
      if (sub) g.appendChild(sub);
      gBars.appendChild(g);
      rows[r.key] = { g: g, bar: bar, name: name, values: values, sub: sub, halo: halo };
    });

    mount.appendChild(svg);

    function update(progress) {
      var m = layoutFn(data, progress, options);

      m.rows.forEach(function (r) {
        var n = rows[r.key];
        n.g.setAttribute("opacity", r.opacity.toFixed(3));
        // height is animated too, not just position: act 3's three survivors
        // grow into a plot that was carrying eighteen rows a moment earlier.
        set(n.bar, { y: r.y, height: r.height, width: Math.max(0, r.width), fill: r.color });
        set(n.name, { x: r.labelX, y: r.y + r.height / 2 });
        if (n.sub) {
          set(n.sub, { x: r.subLabel.x, y: r.subLabel.y,
                       opacity: r.subLabel.opacity.toFixed(3) });
        }
        if (n.halo) {
          set(n.halo, { x: r.halo.x, y: r.halo.y, width: r.halo.width,
                        height: r.halo.height, opacity: r.halo.opacity.toFixed(3) });
        }
        if (r.emphasis !== undefined) {
          n.g.classList.toggle("is-emphasis", !!r.emphasis);
        }
        r.values.forEach(function (v, i) {
          set(n.values[i], { x: r.valueX, y: r.y + r.height / 2, opacity: v.opacity.toFixed(3) });
          n.values[i].textContent = v.text;
        });
      });

      // Only written when it actually changes: this runs on every scroll frame,
      // and assigning textContent unconditionally re-lays out the text node.
      if (subtitle.textContent !== m.subtitle) subtitle.textContent = m.subtitle;

      m.tickSets.forEach(function (ts, i) {
        tickGroups[i].group.setAttribute("opacity", ts.ticks[0].opacity.toFixed(3));
        ts.ticks.forEach(function (t, j) {
          var part = tickGroups[i].parts[j];
          if (!part) return;
          set(part.line, { x1: t.x, x2: t.x });
          set(part.label, { x: t.x });
          part.label.textContent = t.label;
        });
      });

      m.axisTitles.forEach(function (a, i) { axisTitles[i].setAttribute("opacity", a.opacity.toFixed(3)); });
      m.headings.forEach(function (h, i) { headings[i].setAttribute("opacity", h.opacity.toFixed(3)); });
    }

    update(0);
    return { svg: svg, update: update };
  }

  function slide04(mount, data, options) {
    var L = getLayout();
    return mountBarChart(mount, L.slide04, data, options,
      "Highway crash causes, reordering from most common to most lethal");
  }

  // The three-act version: reorder, then the evidence behind the top three.
  // Same mount, same DOM, one scalar — see slide04Story() in layout.js.
  function slide04Story(mount, data, options) {
    var L = getLayout();
    return mountBarChart(mount, L.slide04Story, data, options,
      "Highway crash causes reordering from most common to most lethal, then the "
      + "number of crashes behind each of the three highest death rates");
  }

  function slide08(mount, data, options) {
    var L = getLayout();
    return mountBarChart(mount, L.slide08, data, options,
      "Provinces ranked by crashes, reordering into provinces ranked by deaths");
  }

  /* ----------------------------------------- slide 5: three panels of bars */

  /* Bins never move sideways and the y-axis is fixed across both acts, so the
   * gridlines, the even-split rule, the panel titles and the x tick labels are
   * written once at mount and never touched again. Only bar heights, bar colour,
   * callout opacity and the two swapping headings change per frame. */
  function slide05(mount, data, options) {
    var L = getLayout();
    var first = L.slide05(data, 0, options);

    var svg = el("svg", {
      class: "chart",
      viewBox: "0 0 " + first.viewBox.width + " " + first.viewBox.height,
      role: "img",
      "aria-label": "Crashes by hour, day of week and month, re-heighting to show "
        + "the same three views by deaths",
    });

    var gGrid = el("g", { class: "c-grid" });
    var gBars = el("g", { class: "c-bars" });
    var gText = el("g", { class: "c-text" });
    svg.appendChild(gGrid); svg.appendChild(gBars); svg.appendChild(gText);

    var headings = first.headings.map(function (h) {
      var t = el("text", { class: "c-heading", x: 40, y: 62 }, h.text);
      gText.appendChild(t);
      return t;
    });
    gText.appendChild(el("text", { class: "c-subtitle", x: 40, y: 94 }, first.subtitle));
    var axisTitles = first.axisTitles.map(function (a) {
      var t = el("text", { class: "c-axistitle", x: a.x, y: a.y,
                           "text-anchor": a.anchor }, a.text);
      gText.appendChild(t);
      return t;
    });
    gText.appendChild(el("text", {
      class: "c-source", x: first.sourceX, y: first.viewBox.height - 18, "text-anchor": "end",
    }, first.source));

    var bars = {}, notes = {};
    first.panels.forEach(function (panel) {
      gText.appendChild(el("text", {
        class: "c-paneltitle", x: panel.x, y: panel.y - 16,
      }, panel.title));

      panel.yTicks.forEach(function (tk) {
        gGrid.appendChild(el("line", {
          class: "c-gridline", x1: panel.x, x2: panel.x + panel.w, y1: tk.y, y2: tk.y,
        }));
        gGrid.appendChild(el("text", {
          class: "c-tick", x: panel.x - 10, y: tk.y + 5, "text-anchor": "end",
        }, tk.label));
      });

      gGrid.appendChild(el("line", {
        class: "c-evenline", x1: panel.x, x2: panel.x + panel.w,
        y1: panel.evenLine.y, y2: panel.evenLine.y,
      }));
      gGrid.appendChild(el("text", {
        class: "c-evenlabel", x: panel.x + panel.w, y: panel.evenLine.y - 6,
      }, panel.evenLine.label));

      gGrid.appendChild(el("line", {
        class: "c-baseline", x1: panel.x, x2: panel.x + panel.w,
        y1: panel.y + panel.h, y2: panel.y + panel.h,
      }));

      panel.xTicks.forEach(function (tk) {
        gText.appendChild(el("text", {
          class: "c-tick", x: tk.x, y: panel.y + panel.h + 24,
        }, tk.label));
      });

      panel.bars.forEach(function (b) {
        var rect = el("rect", { class: "c-bar", x: b.x, width: b.width, rx: 1.5 });
        gBars.appendChild(rect);
        bars[b.key] = rect;
      });

      panel.notes.forEach(function (n) {
        var t = el("text", {
          class: "c-note" + (n.anchor === "start" ? " is-start" : ""),
        }, n.text);
        gText.appendChild(t);
        notes[n.key] = t;
      });
    });

    mount.appendChild(svg);

    function update(progress) {
      var m = L.slide05(data, progress, options);
      m.panels.forEach(function (panel) {
        panel.bars.forEach(function (b) {
          set(bars[b.key], { y: b.y, height: Math.max(0, b.height), fill: b.color });
        });
        panel.notes.forEach(function (n) {
          set(notes[n.key], { x: n.x, y: n.y, opacity: n.opacity.toFixed(3) });
        });
      });
      m.headings.forEach(function (h, i) { headings[i].setAttribute("opacity", h.opacity); });
      m.axisTitles.forEach(function (a, i) { axisTitles[i].setAttribute("opacity", a.opacity); });
    }

    update(0);
    return { svg: svg, update: update };
  }

  /* --------------------------------------------------- slide 9: scatter */

  function slide09(mount, data, options) {
    var L = getLayout();
    var first = L.slide09(data, 0, options);

    var svg = el("svg", {
      class: "chart",
      viewBox: "0 0 " + first.viewBox.width + " " + first.viewBox.height,
      role: "img",
      "aria-label": "AADT against crash count, morphing into AADT against fatality rate",
    });

    var gGrid = el("g", { class: "c-grid" });
    var gTrend = el("g", { class: "c-trend" });
    var gPoints = el("g", { class: "c-points" });
    var gText = el("g", { class: "c-text" });
    svg.appendChild(gGrid); svg.appendChild(gTrend); svg.appendChild(gPoints); svg.appendChild(gText);

    var headings = first.headings.map(function (h) {
      var t = el("text", { class: "c-heading", x: 40, y: 62 }, h.text);
      gText.appendChild(t);
      return t;
    });
    gText.appendChild(el("text", { class: "c-subtitle", x: 40, y: 94 }, first.subtitle));
    gText.appendChild(el("text", {
      class: "c-source", x: first.sourceX, y: first.viewBox.height - 18, "text-anchor": "end",
    }, first.source));
    var xAxisTitle = el("text", {
      class: "c-axistitle", x: first.xAxisTitle.x, y: first.xAxisTitle.y, "text-anchor": "middle",
    }, first.xAxisTitle.text);
    gText.appendChild(xAxisTitle);

    var axisTitles = first.axisTitles.map(function (a) {
      var t = el("text", { class: "c-axistitle", x: a.x, y: a.y }, a.text);
      gText.appendChild(t);
      return t;
    });

    // x grid — never moves, drawn once
    first.xTicks.forEach(function (t) {
      gGrid.appendChild(el("line", {
        class: "c-gridline", x1: t.x, x2: t.x, y1: first.plot.y - 10, y2: first.plot.y + first.plot.h,
      }));
      gGrid.appendChild(el("text", { class: "c-tick", x: t.x, y: first.plot.y + first.plot.h + 26 }, t.label));
    });

    var tickGroups = first.tickSets.map(function (ts) {
      var g = el("g", {});
      var parts = ts.ticks.map(function (t) {
        var label = el("text", {
          class: "c-tick", x: first.plot.x - 14, y: t.y, "text-anchor": "end",
        }, t.label);
        g.appendChild(label);
        return { label: label };
      });
      gGrid.appendChild(g);
      return { group: g, parts: parts };
    });

    var trend = el("path", { class: "c-trendline", fill: "none", "stroke-width": 3, d: first.trendPath });
    gTrend.appendChild(trend);

    var points = {};
    first.points.forEach(function (pt) {
      var c = el("circle", { class: "c-point", r: pt.r });
      gPoints.appendChild(c);
      points[pt.key] = c;
    });

    mount.appendChild(svg);

    function update(progress) {
      var m = L.slide09(data, progress, options);

      set(trend, { d: m.trendPath, stroke: m.trendColor });
      m.points.forEach(function (pt) {
        set(points[pt.key], { cx: pt.x, cy: pt.y, fill: pt.color });
      });

      m.tickSets.forEach(function (ts, i) {
        tickGroups[i].group.setAttribute("opacity", ts.ticks[0] ? ts.ticks[0].opacity.toFixed(3) : 0);
        ts.ticks.forEach(function (t, j) {
          var part = tickGroups[i].parts[j];
          if (!part) return;
          set(part.label, { y: t.y });
          part.label.textContent = t.label;
        });
      });

      m.axisTitles.forEach(function (a, i) { axisTitles[i].setAttribute("opacity", a.opacity.toFixed(3)); });
      m.headings.forEach(function (h, i) { headings[i].setAttribute("opacity", h.opacity.toFixed(3)); });
    }

    update(0);
    return { svg: svg, update: update };
  }

  /* ------------------------------------------------- slide 12: reveal */

  function slide12(mount, data, options) {
    var L = getLayout();
    var first = L.slide12(data, 0, options);

    var svg = el("svg", {
      class: "chart",
      viewBox: "0 0 " + first.viewBox.width + " " + first.viewBox.height,
      role: "img",
      "aria-label": "Monthly crashes and deaths with the Seven Dangerous Days windows shaded",
    });

    var gBands = el("g", { class: "c-bands" });
    var gGrid = el("g", { class: "c-grid" });
    var gLines = el("g", { class: "c-lines" });
    var gText = el("g", { class: "c-text" });
    svg.appendChild(gBands); svg.appendChild(gGrid); svg.appendChild(gLines); svg.appendChild(gText);

    gText.appendChild(el("text", { class: "c-heading", x: 40, y: 50 }, first.heading));
    gText.appendChild(el("text", { class: "c-subtitle", x: 40, y: 78 }, first.subtitle));
    gText.appendChild(el("text", {
      class: "c-source", x: first.sourceX, y: first.viewBox.height - 14, "text-anchor": "end",
    }, first.source));
    var summary = el("text", {
      class: "c-summary", x: first.summary.x, y: first.summary.y, "text-anchor": "end",
    }, first.summary.text);
    gText.appendChild(summary);

    first.xTicks.forEach(function (t) {
      gGrid.appendChild(el("text", {
        class: "c-tick", x: t.x, y: first.panels[1].y + first.panels[1].h + 24, "text-anchor": "middle",
      }, t.label));
    });

    var panelNodes = first.panels.map(function (panel) {
      gText.appendChild(el("text", {
        class: "c-axistitle", x: first.plot.x, y: panel.y - 12,
      }, panel.title));
      var tickGroup = el("g", {});
      var ticks = panel.ticks.map(function (t) {
        var line = el("line", {
          class: "c-gridline", x1: first.plot.x, x2: first.plot.x + first.plot.w, y1: t.y, y2: t.y,
        });
        var label = el("text", {
          class: "c-tick", x: first.plot.x - 12, y: t.y, "text-anchor": "end",
        }, t.label);
        tickGroup.appendChild(line); tickGroup.appendChild(label);
        return { line: line, label: label };
      });
      gGrid.appendChild(tickGroup);
      var path = el("path", { class: "c-line", fill: "none", "stroke-width": 2.4, stroke: panel.color, d: panel.line.path });
      gLines.appendChild(path);
      return { path: path, ticks: ticks };
    });

    var bandNodes = first.bands.map(function () {
      var rect = el("rect", { class: "c-band" });
      gBands.appendChild(rect);
      return { rect: rect };
    });

    mount.appendChild(svg);

    function update(progress) {
      var m = L.slide12(data, progress, options);

      m.panels.forEach(function (panel, i) {
        set(panelNodes[i].path, { d: panel.line.path });
        panel.ticks.forEach(function (t, j) {
          var part = panelNodes[i].ticks[j];
          if (!part) return;
          set(part.line, { y1: t.y, y2: t.y });
          set(part.label, { y: t.y });
        });
      });

      m.bands.forEach(function (b, i) {
        var n = bandNodes[i];
        set(n.rect, {
          x: b.x, width: b.width, y: first.panels[0].y,
          height: first.panels[1].y + first.panels[1].h - first.panels[0].y,
          opacity: b.opacity.toFixed(3),
        });
      });

      set(summary, { opacity: m.summary.opacity.toFixed(3) });
    }

    update(0);
    return { svg: svg, update: update };
  }

  return { slide04: slide04, slide04Story: slide04Story, slide05: slide05,
           slide08: slide08, slide09: slide09, slide12: slide12 };
});
