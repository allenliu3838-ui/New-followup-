(function(){
  var path = window.location.pathname || '/';

  function resolveBasePath(p){
    var known = ['/index.html', '/staff', '/staff.html', '/patient.html', '/guide', '/guide.html'];
    for (var i = 0; i < known.length; i++) {
      var entry = known[i];
      if (p === entry || p.endsWith(entry)) {
        var base = p.slice(0, -entry.length);
        return base || '';
      }
    }
    var idx = p.lastIndexOf('/');
    return idx > 0 ? p.slice(0, idx) : '';
  }

  // Match token path with optional mount prefix: /p/<token> or /app/p/<token>
  var pm = path.match(/^(.*)\/p\/([^\/?#]+)\/?$/);
  if (pm && pm[2]){
    var prefix = pm[1] || '';
    var tok = '';
    try { tok = decodeURIComponent(pm[2]); } catch (_) { tok = pm[2]; }
    if (tok) {
      window.location.replace(prefix + '/patient.html?token=' + encodeURIComponent(tok));
      return;
    }
  }

  var base = resolveBasePath(path);

  // Supabase auth callbacks (password reset, magic link, errors) land on root/sub-path.
  // Forward them straight to /staff while preserving hash payload.
  var h = window.location.hash || '';
  if (h && (h.indexOf('access_token=') >= 0 || h.indexOf('type=recovery') >= 0 || h.indexOf('error=') >= 0)) {
    window.location.replace(base + '/staff' + h);
  }
})();
