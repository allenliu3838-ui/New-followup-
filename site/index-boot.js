(function(){
  var path = window.location.pathname || '/';

  // If /p/<token> lands on index fallback, forward to patient page with token.
  // Keep this in an external script so it still works under strict CSP (no inline JS).
  var pm = path.match(/^\/p\/([^\/?#]+)\/?$/);
  if (pm && pm[1]){
    var tok = '';
    try { tok = decodeURIComponent(pm[1]); } catch (_) { tok = pm[1]; }
    if (tok) {
      window.location.replace('/patient.html?token=' + encodeURIComponent(tok));
      return;
    }
  }

  // Supabase auth callbacks (password reset, magic link, errors) land on root.
  // Forward them straight to /staff while preserving hash payload.
  var h = window.location.hash || '';
  if (h && (h.indexOf('access_token=') >= 0 || h.indexOf('type=recovery') >= 0 || h.indexOf('error=') >= 0)) {
    window.location.replace('/staff' + h);
  }
})();
