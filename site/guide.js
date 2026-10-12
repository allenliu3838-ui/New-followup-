/* Guide and manual helpers (no network, no storage).
   A link such as /guide#advanced-run may point inside a collapsed <details>;
   open every enclosing <details> so the target is actually visible. */
(function () {
  "use strict";

  function targetFromHash() {
    var id = "";
    try { id = decodeURIComponent((location.hash || "").slice(1)); } catch (e) { return null; }
    return id ? document.getElementById(id) : null;
  }

  function reveal(target, scroll) {
    if (!target) return;
    var node = target;
    while (node && node !== document.body) {
      if (node.tagName === "DETAILS") node.open = true;
      node = node.parentElement;
    }
    if (scroll && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
  }

  function onHash(scroll) { reveal(targetFromHash(), scroll); }

  // In-page links to a target hidden inside a closed fold.
  document.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[href^="#"]') : null;
    if (!link) return;
    var id = link.getAttribute("href").slice(1);
    var target = id ? document.getElementById(id) : null;
    if (target) reveal(target, false);
  });

  window.addEventListener("hashchange", function () { onHash(true); });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { onHash(true); });
  } else {
    onHash(true);
  }
})();
