// Exact local destinations only: do not accept protocol-relative/backslash/encoded redirects.
export function safeReturnTo(value, fallback = '/staff') {
  if (typeof value !== 'string' || /[\\\x00-\x20%]/.test(value)) return fallback;
  const allowed = new Set(['/staff', '/staff.html', '/checkout', '/checkout.html', '/signup', '/signup.html']);
  const path = value.split('?')[0];
  if (!allowed.has(path)) return fallback;
  try {
    const url = new URL(value, 'https://registry.invalid');
    if (url.origin !== 'https://registry.invalid' || url.hash) return fallback;
    // Never carry arbitrary nested URLs or authentication material to a destination.
    const out = new URLSearchParams();
    if (path.startsWith('/signup') && url.searchParams.get('trial') === '1') out.set('trial', '1');
    return path + (out.size ? '?' + out.toString() : '');
  } catch { return fallback; }
}
