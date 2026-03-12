/**
 * KidneySphere Research — Unified Event Tracking
 *
 * Usage: KSTrack.track('event_name', { key: 'value' })
 *
 * To connect to a provider, replace the stubs below:
 *   GA4:      uncomment gtag() call and add GA4 script tag
 *   Plausible: uncomment plausible() call and add Plausible script tag
 */
(function () {
  var ENABLED = true; // set false to silence all tracking

  function track(eventName, props) {
    if (!ENABLED) return;
    var data = Object.assign({ path: location.pathname, ts: Date.now() }, props || {});

    // --- Provider stubs (uncomment to activate) ---
    // GA4
    // if (typeof gtag === 'function') { gtag('event', eventName, data); }

    // Plausible
    // if (typeof plausible === 'function') { plausible(eventName, { props: data }); }

    // Console fallback (always on in development)
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      console.log('[KSTrack]', eventName, data);
    }
  }

  /**
   * Auto-attach click listeners to elements with data-track attribute.
   * Usage in HTML: <a data-track="click_book_demo" data-track-source="hero">
   */
  function attachAutoTracking() {
    document.querySelectorAll('[data-track]').forEach(function (el) {
      el.addEventListener('click', function () {
        var props = {};
        // collect all data-track-* attributes as properties
        Array.prototype.forEach.call(el.attributes, function (attr) {
          if (attr.name.startsWith('data-track-')) {
            var key = attr.name.replace('data-track-', '').replace(/-/g, '_');
            props[key] = attr.value;
          }
        });
        props.label = el.textContent.trim().slice(0, 60);
        props.href = el.getAttribute('href') || '';
        track(el.getAttribute('data-track'), props);
      });
    });
  }

  // Events fired on page load
  function trackPageView() {
    track('page_view', {
      title: document.title,
      referrer: document.referrer
    });
  }

  // Expose public API
  window.KSTrack = {
    track: track
  };

  // Initialize after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      attachAutoTracking();
      trackPageView();
    });
  } else {
    attachAutoTracking();
    trackPageView();
  }
})();
