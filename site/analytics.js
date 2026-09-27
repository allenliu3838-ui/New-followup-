/**
 * KidneySphere Research — Unified Event Tracking
 *
 * Usage: KSTrack.track('event_name', { key: 'value' })
 *
 * Provider: Plausible Analytics (kidneysphereregistry.cn)
 * To switch to GA4: uncomment gtag() block and add GA4 Measurement ID.
 */
(function () {
  var ENABLED = true; // set false to silence all tracking

  if (window.KSTrack) return;

  // Queue stub: events fired before the Plausible script loads are replayed instead of dropped
  window.plausible = window.plausible || function () {
    (window.plausible.q = window.plausible.q || []).push(arguments);
  };

  // Load Plausible script dynamically (production only)
  if (ENABLED && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    var s = document.createElement('script');
    s.defer = true;
    s.setAttribute('data-domain', 'kidneysphereregistry.cn');
    s.src = 'https://plausible.io/js/script.tagged-events.js';
    document.head.appendChild(s);
  }

  function track(eventName, props) {
    if (!ENABLED) return;
    var data = Object.assign({ path: location.pathname, ts: Date.now() }, props || {});

    window.plausible(eventName, { props: data });

    // GA4 (optional — add GA4 Measurement ID and uncomment)
    // if (typeof gtag === 'function') { gtag('event', eventName, data); }

    // Console fallback (development only)
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      console.log('[KSTrack]', eventName, data);
    }
  }

  /**
   * Delegated click tracking for any element with data-track (including ones rendered later).
   * Usage in HTML: <a data-track="click_book_demo" data-track-source="hero">
   */
  function attachAutoTracking() {
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-track]') : null;
      if (!el) return;
      var props = {};
      Array.prototype.forEach.call(el.attributes, function (attr) {
        if (attr.name.indexOf('data-track-') === 0) {
          var key = attr.name.replace('data-track-', '').replace(/-/g, '_');
          props[key] = attr.value;
        }
      });
      props.label = el.textContent.trim().slice(0, 60);
      props.href = el.getAttribute('href') || '';
      track(el.getAttribute('data-track'), props);
    }, true);
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
