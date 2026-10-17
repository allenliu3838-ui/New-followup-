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

/** Where e-mailed links land. Only the reviewed return paths are ever embedded. */
export function authCallbackUrl(origin, returnTo, { recovery = false } = {}) {
  const target = safeReturnTo(returnTo).split('?')[0];
  return `${origin}/auth-callback?${recovery ? 'recovery=1&' : ''}returnTo=${target}`;
}

const SUPPORT = 'china@kidneysphere.com';

/** Seconds the auth service asked us to wait ("... after 37 seconds"), or null. */
export function retryAfterSeconds(error) {
  const text = String(error?.message || error?.msg || error?.error_description || '');
  const match = text.match(/after\s+(\d{1,5})\s+second/i);
  return match ? Number(match[1]) : null;
}

/**
 * Classify an auth-service error (sign-up, sign-in, e-mail links, password
 * reset, callback parameters) without depending on its English wording alone.
 */
export function authErrorKind(error) {
  if (!error) return 'unknown';
  const code = String(error.code || error.error_code || '').toLowerCase();
  const name = String(error.name || '');
  const status = Number(error.status) || 0;
  const msg = String(error.message || error.msg || error.error_description || '').toLowerCase();
  const has = (...parts) => parts.some(part => msg.includes(part));

  if (name === 'AuthRetryableFetchError' || code === 'request_timeout' || msg === 'init_timeout'
      || (name === 'TypeError' && has('fetch', 'network', 'load failed'))
      || has('failed to fetch', 'networkerror', 'network request failed', 'load failed')) return 'network';
  if (status === 429 || ['over_request_rate_limit', 'over_email_send_rate_limit', 'over_sms_send_rate_limit'].includes(code)
      || has('rate limit', 'for security purposes', 'too many requests')) return 'rate_limited';
  if (code === 'invalid_credentials' || has('invalid login credentials')) return 'invalid_credentials';
  if (code === 'email_not_confirmed' || has('email not confirmed')) return 'email_not_confirmed';
  if (['user_already_exists', 'email_exists', 'identity_already_exists'].includes(code)
      || has('already registered', 'already been registered', 'already exists')) return 'already_registered';
  if (['otp_disabled', 'user_not_found'].includes(code) || has('signups not allowed for otp', 'user not found')) return 'not_registered';
  if (['flow_state_not_found', 'bad_code_verifier'].includes(code) || has('code verifier', 'flow state')) return 'link_other_browser';
  if (['otp_expired', 'flow_state_expired', 'bad_jwt'].includes(code)
      || has('expired', 'invalid or has expired', 'link is invalid', 'token has expired')) return 'link_expired';
  if (code === 'weak_password' || name === 'AuthWeakPasswordError' || has('password should', 'weak password')) return 'weak_password';
  if (code === 'same_password' || has('should be different')) return 'same_password';
  if (['session_not_found', 'session_expired', 'refresh_token_not_found'].includes(code)
      || name === 'AuthSessionMissingError' || has('auth session missing', 'session missing')) return 'session_missing';
  if (['signup_disabled', 'email_provider_disabled'].includes(code) || has('signups not allowed')) return 'signup_disabled';
  if (['email_address_invalid', 'validation_failed'].includes(code) || has('invalid format', 'unable to validate email')) return 'email_invalid';
  if (code === 'email_address_not_authorized' || has('not authorized')) return 'email_not_authorized';
  if (has('error sending')) return 'email_send_failed';
  if (code === 'access_denied') return 'link_expired';
  if (status >= 500) return 'server';
  return 'unknown';
}

/**
 * Chinese, user-facing explanation for an auth error. Never returns the
 * service's English text, table names or function names.
 */
export function authErrorMessage(error) {
  const kind = authErrorKind(error);
  const code = String(error?.code || error?.error_code || '').toLowerCase();
  switch (kind) {
    case 'network':
      return '网络连接失败，请求可能没有到达服务器。请检查网络后重试。';
    case 'rate_limited': {
      const wait = retryAfterSeconds(error);
      if (wait) return `出于安全考虑，同一邮箱的请求需要间隔一段时间，请等待 ${wait} 秒后再试。`;
      if (code === 'over_email_send_rate_limit' || /email/i.test(String(error?.message || ''))) {
        return `邮件发送次数已达到服务器的每小时上限，请约 1 小时后再试；急需登录请联系 ${SUPPORT}。`;
      }
      return '请求过于频繁，服务器已暂时限制，请等待约 5 分钟后再试。';
    }
    case 'invalid_credentials':
      return '邮箱或密码不正确。如果忘记密码，请点“忘记密码”，通过邮件重新设置；也可以改用邮箱登录链接登录。';
    case 'email_not_confirmed':
      return '该邮箱还没有完成验证。请打开注册后收到的确认邮件中的链接；找不到邮件时可以重新发送确认邮件。';
    case 'already_registered':
      return '该邮箱已注册，请直接登录；忘记密码可在登录页点“忘记密码”找回。';
    case 'not_registered':
      return '该邮箱还没有注册账号，请先注册。';
    case 'link_other_browser':
      return '登录链接需要在发出请求的同一浏览器中打开。请重新发送登录链接，并用同一浏览器打开邮件中的链接。';
    case 'link_expired':
      return '登录链接已过期或已经使用过。邮件中的链接只能使用一次，并有有效期，请重新发送一封。';
    case 'weak_password':
      return '密码不符合安全要求：至少 8 位，并同时包含大写字母、小写字母、数字和特殊字符。';
    case 'same_password':
      return '新密码不能与当前密码相同。';
    case 'session_missing':
      return '重设密码的链接已失效或登录状态已过期，请重新发送重设密码邮件。';
    case 'signup_disabled':
      return `本站暂未开放注册，请联系 ${SUPPORT}。`;
    case 'email_invalid':
      return '邮箱格式不正确，请检查后重试。';
    case 'email_not_authorized':
      return `邮件服务暂时无法向该邮箱发送邮件，请联系 ${SUPPORT} 处理。`;
    case 'email_send_failed':
      return `邮件发送失败，请稍后再试；如持续出现，请联系 ${SUPPORT}。`;
    case 'server': {
      const status = Number(error?.status) || 0;
      return `服务暂时异常${status ? `（状态码 ${status}）` : ''}，请稍后再试；如持续出现，请联系 ${SUPPORT} 并告知发生时间。`;
    }
    default:
      return `操作未完成，请稍后再试；如持续出现，请联系 ${SUPPORT} 并告知发生时间。`;
  }
}
