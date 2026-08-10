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
   * gridlines, the even-split rule and the x tick labels are written once at
   * mount and never touched again. Bar heights, bar colour, callout opacity,
   * the legend swatch's fill and the panel titles' opacity change per frame.
   *
   * The panel titles moved into that per-frame set on 9 Aug, when the panels
   * stopped flipping together: each panel now carries two titles, one per
   * metric, and swaps them on its own act rather than sharing one heading with
   * the other two. There is no chart-level heading or axis title any more. */
  function slide05(mount, data, options) {
    var L = getLayout();
    var first = L.slide05(data, 0, options);

    var svg = el("svg", {
      class: "chart",
      viewBox: "0 0 " + first.viewBox.width + " " + first.viewBox.height,
      role: "img",
      "aria-label": "Crashes by hour, day of week and month, re-heighting to show "
        + "the same three views by deaths. On the hour panel, 13:00 to 16:00 is "
        + "highlighted while the chart reads crashes, then 19:00 to 04:00 while "
        + "it reads deaths; the rest are greyed.",
    });

    var gGrid = el("g", { class: "c-grid" });
    var gBars = el("g", { class: "c-bars" });
    var gText = el("g", { class: "c-text" });
    svg.appendChild(gGrid); svg.appendChild(gBars); svg.appendChild(gText);

    // No chart-level heading or axis title: with the panels flipping in two
    // acts, neither could be true of all three at once. The metric now rides on
    // each panel's own title.
    var lg = first.legend;
    var legendSwatch = el("rect", {
      class: "c-legendswatch", x: lg.x, y: lg.y - lg.swatch,
      width: lg.swatch, height: lg.swatch, rx: 1.5,
    });
    gText.appendChild(legendSwatch);
    // Two overlaid labels, hard-swapped by opacity — same pattern as the panel
    // titles below, and for the same reason: the window the legend names
    // changes identity between acts, so only one string may ever be painted.
    var legendLabels = lg.labels.map(function (lb) {
      var t = el("text", {
        class: "c-legendlabel", x: lg.x + lg.swatch + 8, y: lg.y,
      }, lb.text);
      gText.appendChild(t);
      return t;
    });
    gText.appendChild(el("text", { class: "c-subtitle", x: 40, y: 94 }, first.subtitle));
    gText.appendChild(el("text", {
      class: "c-source", x: first.sourceX, y: first.viewBox.height - 18, "text-anchor": "end",
    }, first.source));

    var bars = {}, notes = {}, panelTitles = {};
    first.panels.forEach(function (panel) {
      // Two overlaid titles per panel, one per metric, hard-swapped so only one
      // is ever painted — same reason the chart heading they replaced did.
      panelTitles[panel.key] = panel.titles.map(function (ti) {
        var t = el("text", {
          class: "c-paneltitle", x: panel.x, y: panel.y - 16,
        }, ti.text);
        gText.appendChild(t);
        return t;
      });

      panel.yTicks.forEach(function (tk) {
        gGrid.appendChild(el("line", {
          class: "c-gridline", x1: panel.x, x2: panel.x + panel.w, y1: tk.y, y2: tk.y,
        }));
        gGrid.appendChild(el("text", {
          class: "c-tick c-tick-y", x: panel.x - 10, y: tk.y + 5, "text-anchor": "end",
        }, tk.label));
      });

      gGrid.appendChild(el("line", {
        class: "c-evenline", x1: panel.x, x2: panel.x + panel.w,
        y1: panel.evenLine.y, y2: panel.evenLine.y,
      }));
      // Beside the line's right end, outside the panel — not above it, inside,
      // where a tall bar in the last slot drew straight over it. Vertically
      // centred on the line now that nothing forces it above.
      gGrid.appendChild(el("text", {
        class: "c-evenlabel", x: panel.evenLine.labelX, y: panel.evenLine.y + 4,
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
      m.panels.forEach(function (panel) {
        panel.titles.forEach(function (ti, i) {
          panelTitles[panel.key][i].setAttribute("opacity", ti.opacity);
        });
      });
      // The swatch tracks the hour panel's hue so the legend never claims a
      // colour the bars are not currently wearing.
      legendSwatch.setAttribute("fill", m.legend.color);
      m.legend.labels.forEach(function (lb, i) {
        legendLabels[i].setAttribute("opacity", lb.opacity);
      });
    }

    update(0);
    return { svg: svg, update: update };
  }

  /* ------------------------------------ slide 6: the conditions carousel */

  /* Each card is drawn once in the layout module's local card space and then
   * placed by a single transform, so one scale factor moves bars and type
   * together. Nothing here knows where on the loop a card is. */
  function slide06(mount, data, options) {
    var L = getLayout();
    var first = L.slide06(data, 0, options);

    var svg = el("svg", {
      class: "chart",
      viewBox: "0 0 " + first.viewBox.width + " " + first.viewBox.height,
      role: "img",
      "aria-label": "Vehicle type, road alignment and weather, each as crash share "
        + "against deaths per 100 crashes, rotating through a carousel. The "
        + "motorcycle bar carries a diagonal texture on both panels.",
    });

    var gText = el("g", { class: "c-text" });
    var gCards = el("g", { class: "c-cards" });
    svg.appendChild(gCards); svg.appendChild(gText);

    // The Motorcycle severity bar's diagonal texture. Its background is the
    // row's OWN computed colour, not a colour named again here — this file
    // does not decide what severity orange is, layout.js does. One 8px tile
    // rotated 45deg, tiled by the SVG engine across whatever width the bar
    // ends up at, so the pattern needs no upkeep as data changes the bar's
    // length. Severity fill is set once at mount and never touched again in
    // update() — a death rate does not change with scroll — so the pattern
    // needs no per-frame handling either.
    var texturedRow = null, texturedVolRow = null;
    first.cards.forEach(function (c) {
      c.rows.forEach(function (r) {
        if (r.sev.texture) texturedRow = r;
        if (r.vol.texture) texturedVolRow = r;
      });
    });
    var volTextureBg = null;
    if (texturedRow || texturedVolRow) {
      var defs = el("defs", {});
      function tile(id, bgFill) {
        var pat = el("pattern", {
          id: id, patternUnits: "userSpaceOnUse",
          width: 8, height: 8, patternTransform: "rotate(45)",
        });
        var bg = el("rect", { width: 8, height: 8, fill: bgFill });
        pat.appendChild(bg);
        pat.appendChild(el("line", { x1: 0, y1: 0, x2: 0, y2: 8, class: "c-texture-line" }));
        defs.appendChild(pat);
        return bg;
      }
      if (texturedRow) tile("s6-texture", texturedRow.sev.color);
      // A second tile rather than reusing the first: this one's background has
      // to be repainted every frame, and the severity tile must not be dragged
      // along with it — the two bars are the same colour only at the very end
      // of the flip.
      if (texturedVolRow) volTextureBg = tile("s6-texture-vol", texturedVolRow.vol.color);
      svg.appendChild(defs);
    }

    var headings = first.headings.map(function (h) {
      var t = el("text", { class: "c-heading", x: 40, y: 54 }, h.text);
      gText.appendChild(t);
      return t;
    });
    var subtitles = first.subtitles.map(function (s) {
      var t = el("text", { class: "c-subtitle", x: 40, y: 84 }, s.text);
      gText.appendChild(t);
      return t;
    });
    var insight = el("text", { class: "c-insight", x: first.insight.x, y: first.insight.y },
                     first.insight.text);
    gText.appendChild(insight);
    var limitation = first.limitation.lines.map(function (ln) {
      var t = el("text", { class: "c-limitation", x: ln.x, y: ln.y }, ln.text);
      gText.appendChild(t);
      return t;
    });
    gText.appendChild(el("text", {
      class: "c-source", x: first.sourceX, y: first.viewBox.height - 16, "text-anchor": "end",
    }, first.source));

    var cards = {};
    first.cards.forEach(function (card) {
      var g = el("g", {});
      gCards.appendChild(g);

      g.appendChild(el("text", { class: "c-cardtitle", x: 0, y: 26 }, card.title));

      var panelTitles = [];
      card.panels.forEach(function (panel) {
        panel.titles.forEach(function (pt) {
          var t = el("text", { class: "c-paneltitle", x: panel.x, y: card.panelTitleY },
                     pt.text);
          g.appendChild(t);
          panelTitles.push(t);
        });
        if (panel.baseline) {
          g.appendChild(el("line", {
            class: "c-baserule", x1: panel.baseline.x, x2: panel.baseline.x,
            y1: card.rowsTop - 2, y2: card.rowsTop + card.slotH * card.rows.length,
          }));
          g.appendChild(el("text", {
            class: "c-baselabel", x: panel.baseline.x, y: panel.baseline.labelY,
          }, panel.baseline.label));
        }
      });

      var rows = {};
      card.rows.forEach(function (r) {
        var rg = el("g", { class: r.thin ? "is-thin" : "" });
        var volBar = el("rect", { class: "c-bar", rx: 2, x: r.vol.x, height: r.height });
        var sevBar = el("rect", { class: "c-bar", rx: 2, x: r.sev.x, height: r.height,
                                  fill: r.sev.texture ? "url(#s6-texture)" : r.sev.color });
        var name = el("text", { class: "c-rowlabel", x: r.labelX }, r.label);
        rg.appendChild(volBar); rg.appendChild(sevBar); rg.appendChild(name);
        var volValues = r.vol.values.map(function (v) {
          var t = el("text", { class: "c-value" }, v.text);
          rg.appendChild(t);
          return t;
        });
        var sevValues = r.sev.values.map(function (v) {
          var t = el("text", { class: "c-value" }, v.text);
          rg.appendChild(t);
          return t;
        });
        g.appendChild(rg);
        rows[r.key] = { g: rg, volBar: volBar, sevBar: sevBar, name: name,
                        volValues: volValues, sevValues: sevValues };
      });

      cards[card.key] = { g: g, rows: rows, panelTitles: panelTitles };
    });

    mount.appendChild(svg);

    function update(progress) {
      var m = L.slide06(data, progress, options);

      m.cards.forEach(function (card) {
        var node = cards[card.key];
        var tr = card.transform;
        set(node.g, {
          transform: "translate(" + tr.x.toFixed(2) + "," + tr.y.toFixed(2)
                   + ") scale(" + tr.scale.toFixed(4) + ")",
          opacity: card.opacity.toFixed(3),
        });
        var ti = 0;
        card.panels.forEach(function (panel) {
          panel.titles.forEach(function (pt) {
            node.panelTitles[ti++].setAttribute("opacity", pt.opacity);
          });
        });
        card.rows.forEach(function (r) {
          var n = node.rows[r.key];
          // The textured row paints through its pattern, and the pattern's own
          // background follows the fill this bar would otherwise have — the
          // volume bar mixes blue to orange across the flip, so a background
          // resolved once at mount would leave the texture sitting on a colour
          // the bar stopped wearing.
          if (r.vol.texture && volTextureBg) {
            volTextureBg.setAttribute("fill", r.vol.color);
          }
          set(n.volBar, { y: r.y, width: Math.max(0, r.vol.width),
                          fill: r.vol.texture ? "url(#s6-texture-vol)" : r.vol.color });
          set(n.sevBar, { y: r.y, width: Math.max(0, r.sev.width) });
          set(n.name, { y: r.y + r.height / 2 });
          r.vol.values.forEach(function (v, i) {
            set(n.volValues[i], { x: r.vol.valueX, y: r.y + r.height / 2,
                                  opacity: v.opacity.toFixed(3) });
          });
          r.sev.values.forEach(function (v, i) {
            set(n.sevValues[i], { x: r.sev.valueX, y: r.y + r.height / 2,
                                  opacity: v.opacity.toFixed(3) });
          });
        });
      });

      m.headings.forEach(function (h, i) { headings[i].setAttribute("opacity", h.opacity); });
      m.subtitles.forEach(function (s, i) { subtitles[i].setAttribute("opacity", s.opacity); });
      insight.setAttribute("opacity", m.insight.opacity.toFixed(3));
      limitation.forEach(function (t) {
        t.setAttribute("opacity", m.limitation.opacity.toFixed(3));
      });
    }

    update(0);
    return { svg: svg, update: update };
  }

  /* ------------------------------- slide 10: excess over what volume explains */

  /* The scatter's geometry is fixed — points never move, they only change size,
   * colour and opacity — so the parity line, the decade grid and the axis titles
   * are written once. Only the ranked panel is built by the scalar. */
  function slide10(mount, data, options) {
    var L = getLayout();
    var first = L.slide10(data, 0, options);

    var svg = el("svg", {
      class: "chart",
      viewBox: "0 0 " + first.viewBox.width + " " + first.viewBox.height,
      role: "img",
      "aria-label": "Highway sections plotted against the crashes a traffic-volume "
        + "model expected, with the fourteen biggest overshoots ranked",
    });

    var gGrid = el("g", { class: "c-grid" });
    var gPoints = el("g", { class: "c-points" });
    var gRank = el("g", { class: "c-bars" });
    var gText = el("g", { class: "c-text" });
    [gGrid, gPoints, gRank, gText].forEach(function (g) { svg.appendChild(g); });

    var headings = first.headings.map(function (h) {
      var t = el("text", { class: "c-heading", x: 40, y: 58 }, h.text);
      gText.appendChild(t);
      return t;
    });
    gText.appendChild(el("text", { class: "c-subtitle", x: 40, y: 88 }, first.subtitle));
    gText.appendChild(el("text", {
      class: "c-limitation", x: first.scopeNote.x, y: first.scopeNote.y,
    }, first.scopeNote.text));
    gText.appendChild(el("text", {
      class: "c-source", x: first.sourceX, y: first.viewBox.height - 16, "text-anchor": "end",
    }, first.source));

    first.decades.forEach(function (d) {
      gGrid.appendChild(el("line", { class: "c-gridline", x1: d.x, x2: d.x,
        y1: first.scatter.y, y2: first.scatter.y + first.scatter.h }));
      gGrid.appendChild(el("line", { class: "c-gridline", x1: first.scatter.x,
        x2: first.scatter.x + first.scatter.w, y1: d.y, y2: d.y }));
      gGrid.appendChild(el("text", { class: "c-tick", x: d.x,
        y: first.scatter.y + first.scatter.h + 22 }, d.label));
      gGrid.appendChild(el("text", { class: "c-tick c-tick-y", x: first.scatter.x - 10,
        y: d.y + 5, "text-anchor": "end" }, d.label));
    });
    gGrid.appendChild(el("line", { class: "c-parity",
      x1: first.parity.x1, y1: first.parity.y1,
      x2: first.parity.x2, y2: first.parity.y2 }));
    gText.appendChild(el("text", { class: "c-paritylabel",
      x: first.scatter.x + 12, y: first.scatter.y + 18 }, first.parity.label));
    first.axisTitles.forEach(function (a) {
      gText.appendChild(el("text", { class: "c-axistitle", x: a.x, y: a.y,
        "text-anchor": a.anchor }, a.text));
    });

    var points = first.points.map(function (pt) {
      var c = el("circle", { class: "c-point", cx: pt.cx, cy: pt.cy });
      gPoints.appendChild(c);
      return c;
    });

    var rankTitle = el("text", { class: "c-paneltitle", x: first.rankTitle.x,
      y: first.rankTitle.y }, first.rankTitle.text);
    var rankAxis = el("text", { class: "c-axistitle", x: first.rankAxis.x,
      y: first.rankAxis.y }, first.rankAxis.text);
    gText.appendChild(rankTitle); gText.appendChild(rankAxis);

    var rows = first.rows.map(function (r) {
      var g = el("g", {});
      var bar = el("rect", { class: "c-bar", rx: 2, x: r.x, y: r.y,
        height: r.height, fill: getLayout().PALETTE.severity });
      var name = el("text", { class: "c-rowlabel", x: r.labelX,
        y: r.y + r.height / 2 }, r.label);
      var val = el("text", { class: "c-value", y: r.y + r.height / 2 }, r.value);
      g.appendChild(bar); g.appendChild(name); g.appendChild(val);
      gRank.appendChild(g);
      return { g: g, bar: bar, val: val };
    });

    mount.appendChild(svg);

    function update(progress) {
      var m = L.slide10(data, progress, options);
      m.points.forEach(function (pt, i) {
        set(points[i], { r: pt.r, fill: pt.color, opacity: pt.opacity.toFixed(3) });
      });
      m.rows.forEach(function (r, i) {
        var n = rows[i];
        n.g.setAttribute("opacity", r.opacity.toFixed(3));
        set(n.bar, { width: Math.max(0, r.width) });
        set(n.val, { x: r.valueX });
      });
      m.headings.forEach(function (h, i) { headings[i].setAttribute("opacity", h.opacity); });
      rankTitle.setAttribute("opacity", m.rankTitle.opacity.toFixed(3));
      rankAxis.setAttribute("opacity", m.rankAxis.opacity.toFixed(3));
    }

    update(0);
    return { svg: svg, update: update };
  }

  /* ---------------------------- shared chrome: heading pair, subtitle, source */

  function mountFrame(first, ariaLabel, headingY, subtitleY) {
    var svg = el("svg", {
      class: "chart",
      viewBox: "0 0 " + first.viewBox.width + " " + first.viewBox.height,
      role: "img", "aria-label": ariaLabel,
    });
    var gGrid = el("g", { class: "c-grid" });
    var gMain = el("g", { class: "c-main" });
    var gText = el("g", { class: "c-text" });
    [gGrid, gMain, gText].forEach(function (g) { svg.appendChild(g); });

    var headings = (first.headings || []).map(function (h) {
      var t = el("text", { class: "c-heading", x: 40, y: headingY || 56 }, h.text);
      gText.appendChild(t);
      return t;
    });
    if (first.heading) {
      gText.appendChild(el("text", { class: "c-heading", x: 40, y: headingY || 56 },
        first.heading));
    }
    if (first.subtitle) {
      gText.appendChild(el("text", { class: "c-subtitle", x: 40, y: subtitleY || 88 },
        first.subtitle));
    }
    gText.appendChild(el("text", {
      class: "c-source", x: first.sourceX, y: first.viewBox.height - 16,
      "text-anchor": "end",
    }, first.source));

    return { svg: svg, gGrid: gGrid, gMain: gMain, gText: gText, headings: headings };
  }

  function axisTitles(f, first) {
    (first.axisTitles || []).forEach(function (a) {
      f.gText.appendChild(el("text", { class: "c-axistitle", x: a.x, y: a.y,
        "text-anchor": a.anchor }, a.text));
    });
  }

  function swapHeadings(f, m) {
    (m.headings || []).forEach(function (h, i) {
      f.headings[i].setAttribute("opacity", h.opacity);
    });
  }

  /* ---------------------------------- slide 7: two counts rising together */

  function slide07(mount, data, options) {
    var L = getLayout();
    var first = L.slide07(data, 0, options);
    var f = mountFrame(first, "Crashes involving a motorcycle against crashes that do "
      + "not, one point per province, with a least-squares fit", 56, 88);

    first.xTicks.forEach(function (t) {
      f.gGrid.appendChild(el("line", { class: "c-gridline", x1: t.x, x2: t.x,
        y1: first.plot.y, y2: first.plot.y + first.plot.h }));
      f.gGrid.appendChild(el("text", { class: "c-tick", x: t.x,
        y: first.plot.y + first.plot.h + 24 }, t.label));
    });
    first.yTicks.forEach(function (t) {
      f.gGrid.appendChild(el("line", { class: "c-gridline", x1: first.plot.x,
        x2: first.plot.x + first.plot.w, y1: t.y, y2: t.y }));
      f.gGrid.appendChild(el("text", { class: "c-tick c-tick-y", x: first.plot.x - 10,
        y: t.y + 5, "text-anchor": "end" }, t.label));
    });
    axisTitles(f, first);

    var points = first.points.map(function (pt) {
      var c = el("circle", { class: "c-point", cx: pt.cx, cy: pt.cy, r: pt.r,
        fill: pt.color, opacity: pt.opacity });
      f.gMain.appendChild(c);
      return c;
    });
    var fit = el("line", { class: "c-fit", x1: first.fit.x1, y1: first.fit.y1 });
    f.gMain.appendChild(fit);
    var stat = el("text", { class: "c-stat", x: first.stat.x, y: first.stat.y },
      first.stat.text);
    f.gText.appendChild(stat);

    mount.appendChild(f.svg);

    function update(progress) {
      var m = L.slide07(data, progress, options);
      set(fit, { x2: m.fit.x2, y2: m.fit.y2, opacity: m.fit.opacity.toFixed(3) });
      set(stat, { opacity: m.stat.opacity.toFixed(3) });
      swapHeadings(f, m);
    }
    update(0);
    return { svg: f.svg, update: update };
  }

  /* ------------------------------- slide 10b: five kinds of road section */

  function slide10b(mount, data, options) {
    var L = getLayout();
    var first = L.slide10b(data, 0, options);
    var f = mountFrame(first, "Five road-section archetypes as small multiples over "
      + "crash rate against deaths per crash", 56, 88);

    first.yTicks.forEach(function (t) {
      f.gGrid.appendChild(el("line", { class: "c-gridline", x1: first.plot.x,
        x2: first.plot.x + first.plot.w, y1: t.y, y2: t.y }));
      f.gGrid.appendChild(el("text", { class: "c-tick c-tick-y", x: first.plot.x - 10,
        y: t.y + 5, "text-anchor": "end" }, t.label));
    });
    axisTitles(f, first);

    var panels = first.panels.map(function (panel) {
      var g = el("g", {});
      f.gMain.appendChild(g);
      var pts = panel.points.map(function (pt) {
        var c = el("circle", { class: "c-point", cx: pt.cx, cy: pt.cy });
        g.appendChild(c);
        return c;
      });
      var title = el("text", { class: "c-cardtitle", x: panel.x, y: panel.y - 58 },
        panel.label);
      var note = el("text", { class: "c-panelnote", x: panel.x, y: panel.y - 38 },
        panel.note);
      var cap = el("text", { class: "c-panelnote", x: panel.x, y: panel.y - 20 },
        panel.caption);
      [title, note, cap].forEach(function (n) { f.gText.appendChild(n); });
      panel.xTicks.forEach(function (t) {
        f.gGrid.appendChild(el("text", { class: "c-tick", x: t.x,
          y: panel.y + panel.h + 24 }, t.label));
      });
      return { g: g, pts: pts, title: title, note: note, cap: cap };
    });

    mount.appendChild(f.svg);

    function update(progress) {
      var m = L.slide10b(data, progress, options);
      m.panels.forEach(function (panel, i) {
        var n = panels[i];
        panel.points.forEach(function (pt, j) {
          set(n.pts[j], { r: pt.r, fill: pt.color, opacity: pt.opacity.toFixed(3) });
        });
        // The focused archetype's own labels come forward with its points.
        var o = (0.45 + 0.55 * panel.focus).toFixed(3);
        [n.title, n.note, n.cap].forEach(function (t) { t.setAttribute("opacity", o); });
      });
    }
    update(0);
    return { svg: f.svg, update: update };
  }

  /* -------------------- slide 11: what the overshooting sections share */

  function slide11(mount, data, options) {
    var L = getLayout();
    var first = L.slide11(data, 0, options);
    var f = mountFrame(first, "Six paired comparisons between the fourteen "
      + "overshooting sections and the other 146", 56, 88);
    axisTitles(f, first);

    var panels = first.panels.map(function (panel) {
      f.gText.appendChild(el("text", { class: "c-paneltitle", x: panel.x + panel.w / 2,
        y: panel.y - 16, "text-anchor": "middle" }, panel.title));
      f.gText.appendChild(el("text", { class: "c-panelnote", x: panel.x + panel.w / 2,
        y: panel.y + panel.h + 26, "text-anchor": "middle" }, panel.unit));
      f.gGrid.appendChild(el("line", { class: "c-baseline", x1: panel.x,
        x2: panel.x + panel.w, y1: panel.y + panel.h, y2: panel.y + panel.h }));
      return panel.bars.map(function (b) {
        var rect = el("rect", { class: "c-bar", rx: 2, x: b.x, width: b.width,
          fill: b.color });
        var val = el("text", { class: "c-value c-value-mid", x: b.valueX }, "");
        var nm = el("text", { class: "c-tick", x: b.x + b.width / 2,
          y: panel.y + panel.h + 44 }, b.label);
        f.gMain.appendChild(rect); f.gText.appendChild(val); f.gText.appendChild(nm);
        return { rect: rect, val: val };
      });
    });

    mount.appendChild(f.svg);

    function update(progress) {
      var m = L.slide11(data, progress, options);
      m.panels.forEach(function (panel, i) {
        panel.bars.forEach(function (b, j) {
          var n = panels[i][j];
          set(n.rect, { y: b.y, height: Math.max(0, b.height),
                        opacity: b.opacity.toFixed(3) });
          set(n.val, { y: b.valueY, opacity: b.valueOpacity.toFixed(3) });
          var txt = b.value.toLocaleString("en-US", { maximumFractionDigits: 1 });
          if (n.val.textContent !== txt) n.val.textContent = txt;
        });
      });
      swapHeadings(f, m);
    }
    update(0);
    return { svg: f.svg, update: update };
  }

  /* ------------------------------- slide 13: the forecast, and its backtest */

  function slide13(mount, data, options) {
    var L = getLayout();
    var first = L.slide13(data, 0, options);
    var f = mountFrame(first, "Monthly crashes and deaths, five years observed and "
      + "twelve months forecast with 80% and 95% intervals", 56, 88);

    var panels = first.panels.map(function (panel) {
      var g = el("g", {});
      f.gMain.appendChild(g);
      var b95 = el("path", { class: "c-band95", fill: panel.color, d: "" });
      var b80 = el("path", { class: "c-band80", fill: panel.color, d: "" });
      var hist = el("path", { class: "c-line", fill: "none", "stroke-width": 2.2,
        stroke: panel.color, d: panel.history });
      var fc = el("path", { class: "c-line c-forecast", fill: "none",
        "stroke-width": 2.2, stroke: panel.color, d: "" });
      [b95, b80, hist, fc].forEach(function (n) { g.appendChild(n); });

      f.gGrid.appendChild(el("line", { class: "c-divider", x1: panel.divider.x,
        x2: panel.divider.x, y1: panel.divider.y1, y2: panel.divider.y2 }));
      panel.ticks.forEach(function (t) {
        f.gGrid.appendChild(el("line", { class: "c-gridline", x1: first.plot.x,
          x2: first.plot.x + first.plot.w, y1: t.y, y2: t.y }));
        f.gGrid.appendChild(el("text", { class: "c-tick c-tick-y", x: first.plot.x - 10,
          y: t.y + 5, "text-anchor": "end" }, t.label));
      });
      f.gText.appendChild(el("text", { class: "c-paneltitle", x: first.plot.x,
        y: panel.y - 10 }, panel.title));
      var score = el("text", { class: "c-panelnote", x: panel.score.x, y: panel.score.y,
        "text-anchor": "end" }, panel.score.text);
      f.gText.appendChild(score);
      return { b95: b95, b80: b80, fc: fc, score: score };
    });

    first.xTicks.forEach(function (t) {
      f.gGrid.appendChild(el("text", { class: "c-tick", x: t.x,
        y: first.plot.y + first.plot.h + 26 }, t.label));
    });
    var callout = el("text", { class: "c-limitation", x: first.callout.x,
      y: first.callout.y }, first.callout.text);
    f.gText.appendChild(callout);

    mount.appendChild(f.svg);

    function update(progress) {
      var m = L.slide13(data, progress, options);
      m.panels.forEach(function (panel, i) {
        var n = panels[i];
        set(n.b95, { d: panel.band95 });
        set(n.b80, { d: panel.band80 });
        set(n.fc, { d: panel.forecast });
        set(n.score, { opacity: panel.score.opacity.toFixed(3) });
      });
      set(callout, { opacity: m.callout.opacity.toFixed(3) });
      swapHeadings(f, m);
    }
    update(0);
    return { svg: f.svg, update: update };
  }

  /* ---------------------------- slide 13b: testing the reporting-lag concern */

  function slide13b(mount, data, options) {
    var L = getLayout();
    var first = L.slide13b(data, 0, options);
    var f = mountFrame(first, "Monthly crash counts against the length of their "
      + "reporting window, and each December ordered by window", 56, 88);

    first.xTicks.forEach(function (t) {
      f.gGrid.appendChild(el("line", { class: "c-gridline", x1: t.x, x2: t.x,
        y1: first.left.y, y2: first.left.y + first.left.h }));
      f.gGrid.appendChild(el("text", { class: "c-tick", x: t.x,
        y: first.left.y + first.left.h + 24 }, t.label));
    });
    first.yTicks.forEach(function (t) {
      f.gGrid.appendChild(el("line", { class: "c-gridline", x1: first.left.x,
        x2: first.left.x + first.left.w, y1: t.y, y2: t.y }));
      f.gGrid.appendChild(el("text", { class: "c-tick c-tick-y", x: first.left.x - 10,
        y: t.y + 5, "text-anchor": "end" }, t.label));
    });
    axisTitles(f, first);
    f.gText.appendChild(el("text", { class: "c-legendlabel", x: first.legend.x,
      y: first.legend.y, fill: first.legend.color }, "■ " + first.legend.text));

    first.points.forEach(function (pt) {
      f.gMain.appendChild(el("circle", { class: "c-point", cx: pt.cx, cy: pt.cy,
        r: pt.r, fill: pt.color, opacity: pt.opacity }));
    });

    var rankTitle = el("text", { class: "c-paneltitle", x: first.rankTitle.x,
      y: first.rankTitle.y }, first.rankTitle.text);
    f.gText.appendChild(rankTitle);
    var rows = first.rows.map(function (r) {
      var g = el("g", {});
      var bar = el("rect", { class: "c-bar", rx: 2, x: r.x, y: r.y, height: r.height,
        fill: getLayout().PALETTE.severity });
      var name = el("text", { class: "c-rowlabel", x: r.labelX, y: r.y + r.height / 2 },
        r.label);
      var val = el("text", { class: "c-value", y: r.y + r.height / 2 }, r.value);
      [bar, name, val].forEach(function (n) { g.appendChild(n); });
      f.gMain.appendChild(g);
      return { g: g, bar: bar, val: val };
    });

    var verdict = el("text", { class: "c-limitation", x: first.verdict.x,
      y: first.verdict.y }, first.verdict.text);
    var caveat = el("text", { class: "c-panelnote", x: first.caveat.x,
      y: first.caveat.y }, first.caveat.text);
    f.gText.appendChild(verdict); f.gText.appendChild(caveat);

    mount.appendChild(f.svg);

    function update(progress) {
      var m = L.slide13b(data, progress, options);
      m.rows.forEach(function (r, i) {
        var n = rows[i];
        n.g.setAttribute("opacity", r.opacity.toFixed(3));
        set(n.bar, { width: Math.max(0, r.width) });
        set(n.val, { x: r.valueX });
      });
      set(rankTitle, { opacity: m.rankTitle.opacity.toFixed(3) });
      set(verdict, { opacity: m.verdict.opacity.toFixed(3) });
      set(caveat, { opacity: m.caveat.opacity.toFixed(3) });
      swapHeadings(f, m);
    }
    update(0);
    return { svg: f.svg, update: update };
  }

  /* -------------------------------------------- slide 13c: forecast vs. reality */

  function slide13c(mount, data, options) {
    var L = getLayout();
    var first = L.slide13c(data, 0, options);
    var f = mountFrame(first, "April 2025 against April 2026, provisional, with the "
      + "forecast's 80% interval shaded behind both", 56, 88);

    first.panels.forEach(function (panel) {
      var g = el("g", {});
      f.gMain.appendChild(g);

      var band95 = el("rect", { class: "c-band95", fill: panel.color,
        x: panel.band95.x, y: panel.band95.y, width: panel.band95.width,
        height: panel.band95.height });
      var band = el("rect", { class: "c-band80", fill: panel.color,
        x: panel.band.x, y: panel.band.y, width: panel.band.width,
        height: panel.band.height });
      var bandLabel = el("text", { class: "c-panelnote", x: panel.bandLabel.x,
        y: panel.bandLabel.y, "text-anchor": "middle" }, panel.bandLabel.text);
      var stick = el("line", { class: "c-stick", stroke: getLayout().PALETTE.axis,
        "stroke-width": 3, x1: panel.stick.x1, x2: panel.stick.x2,
        y1: panel.stick.y, y2: panel.stick.y });
      var dot25 = el("circle", { class: "c-point", cx: panel.p2025.cx,
        cy: panel.p2025.cy, r: panel.p2025.r, fill: getLayout().PALETTE.muted });
      var lab25 = el("text", { class: "c-panelnote", x: panel.p2025.cx,
        y: panel.p2025.labelY, "text-anchor": "middle" }, panel.p2025.label);
      var val25 = el("text", { class: "c-value", x: panel.p2025.cx,
        y: panel.p2025.valueY, "text-anchor": "middle" }, panel.p2025.value);
      var dot26 = el("circle", { class: "c-point", cx: panel.p2026.cx,
        cy: panel.p2026.cy, r: panel.p2026.r, fill: panel.color });
      var lab26 = el("text", { class: "c-panelnote", x: panel.p2026.cx,
        y: panel.p2026.labelY, "text-anchor": "middle" }, panel.p2026.label);
      var val26 = el("text", { class: "c-value", x: panel.p2026.cx,
        y: panel.p2026.valueY, "text-anchor": "middle" }, panel.p2026.value);
      [band95, band, bandLabel, stick, dot25, lab25, val25, dot26, lab26, val26]
        .forEach(function (n) { g.appendChild(n); });

      panel.ticks.forEach(function (t) {
        f.gGrid.appendChild(el("text", { class: "c-tick", x: t.x, y: panel.axisY,
          "text-anchor": "middle" }, t.label));
      });
      f.gText.appendChild(el("text", { class: "c-paneltitle", x: first.plot.x,
        y: panel.titleY }, panel.title));
    });

    var caveat = el("text", { class: "c-limitation", x: first.caveat.x,
      y: first.caveat.y }, first.caveat.text);
    f.gText.appendChild(caveat);

    mount.appendChild(f.svg);

    function update(progress) {
      L.slide13c(data, progress, options);   // progress accepted, drawn state is fixed
    }
    update(0);
    return { svg: f.svg, update: update };
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

    // Both acts' coefficients are painted and then hidden by opacity, the same
    // way the headings and axis titles above work — one act shows at a time.
    var statActs = first.stat.acts.map(function (act) {
      return act.lines.map(function (line, i) {
        var t = el("text", {
          class: i === 0 ? "c-stat" : "c-limitation",
          x: first.stat.x, y: first.stat.y + i * first.stat.lineGap,
        }, line);
        gText.appendChild(t);
        return t;
      });
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
          class: "c-tick c-tick-y", x: first.plot.x - 14, y: t.y, "text-anchor": "end",
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
      m.stat.acts.forEach(function (act, i) {
        statActs[i].forEach(function (n) { n.setAttribute("opacity", act.opacity.toFixed(3)); });
      });
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

    // The band key. Every coordinate and the blended swatch colour come from
    // layout.js; this only places what it is handed. Painted once — which
    // window is which colour does not change with scroll.
    first.legend.entries.forEach(function (e) {
      gText.appendChild(el("rect", {
        class: "c-legendswatch", x: e.swatchX, y: first.legend.y - first.legend.swatch,
        width: first.legend.swatch, height: first.legend.swatch, rx: 1.5, fill: e.color,
      }));
      gText.appendChild(el("text", {
        class: "c-legendlabel", x: e.labelX, y: first.legend.y,
      }, e.text));
    });

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
          class: "c-tick c-tick-y", x: first.plot.x - 12, y: t.y, "text-anchor": "end",
        }, t.label);
        tickGroup.appendChild(line); tickGroup.appendChild(label);
        return { line: line, label: label };
      });
      gGrid.appendChild(tickGroup);
      var path = el("path", { class: "c-line", fill: "none", "stroke-width": 2.4, stroke: panel.color, d: panel.line.path });
      gLines.appendChild(path);
      return { path: path, ticks: ticks };
    });

    // Fill comes from the band's own colour, not from charts.css: the two
    // campaign windows are different colours, and it is set once here because
    // a band never changes which window it belongs to.
    var bandNodes = first.bands.map(function (b) {
      var rect = el("rect", { class: "c-band", fill: b.color });
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
           slide06: slide06, slide07: slide07, slide08: slide08, slide09: slide09,
           slide10: slide10, slide10b: slide10b, slide11: slide11,
           slide12: slide12, slide13: slide13, slide13b: slide13b,
           slide13c: slide13c };
});
