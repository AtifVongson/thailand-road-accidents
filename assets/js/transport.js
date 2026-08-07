/* Scroll transport, shared by tab1/2/3.html. Free scroll is the default and
 * needs no code. This adds two things ticket 08 settled: the keyboard moves
 * the *scroll*, never an animation timer, so chart progress
 * (ChartLayout.progressFor) stays a pure function of scroll position; and a
 * section index performs an instant jump for Q&A, landing anywhere without
 * animating through what precedes it. ~40 lines.
 */
(function () {
  "use strict";

  function sections() { return Array.prototype.slice.call(document.querySelectorAll(".section")); }

  function currentIndex() {
    var s = sections(), y = window.scrollY + 2, idx = 0;
    for (var i = 0; i < s.length; i++) if (s[i].offsetTop <= y) idx = i;
    return idx;
  }

  function goTo(i, smooth) {
    var s = sections();
    i = Math.max(0, Math.min(s.length - 1, i));
    s[i].scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  }

  // Arrow/PageDown smooth-scrolls to the next section anchor; a presentation
  // remote sends exactly these keys, so it works with no extra code.
  addEventListener("keydown", function (e) {
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    if (["ArrowDown", "PageDown"].indexOf(e.key) !== -1) { e.preventDefault(); goTo(currentIndex() + 1, true); }
    if (["ArrowUp", "PageUp"].indexOf(e.key) !== -1) { e.preventDefault(); goTo(currentIndex() - 1, true); }
  });

  var btn = document.getElementById("idxbtn"), panel = document.getElementById("secindex");
  if (!btn || !panel) return;

  panel.innerHTML = sections().map(function (s, i) {
    return '<button data-i="' + i + '"><span class="kicker">' + (s.dataset.kicker || "")
      + '</span>' + (s.dataset.title || "") + "</button>";
  }).join("");

  panel.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-i]");
    if (!b) return;
    goTo(+b.dataset.i, false); // instant — no animating through what precedes it
    panel.classList.remove("open");
  });

  btn.addEventListener("click", function () { panel.classList.toggle("open"); });
  document.addEventListener("click", function (e) {
    if (!panel.contains(e.target) && e.target !== btn) panel.classList.remove("open");
  });
})();
