/**
 * Client-side rate limiter.
 *
 * Provides a simple per-action throttle to prevent accidental or
 * malicious rapid-fire requests from the browser. This is a UX
 * guard — real rate limiting is enforced server-side by the auth
 * service and database permissions.
 *
 * Usage:
 *   import { throttle } from "/lib/rate-limit.js?v=registry-20261031-cn-v10";
 *   const rl = throttle("login", { maxAttempts: 5, windowMs: 15 * 60_000 });
 *   if (!rl.allow()) { toast(rl.message); return; }
 *
 * rl.message always states how long to wait, computed from the window.
 */

const _stores = {};

/** Human wait text in Chinese: " 45 秒" / "约 3 分钟" (leading space keeps "等待 45 秒"). */
export function formatWait(seconds) {
  const s = Math.max(1, Math.ceil(Number(seconds) || 0));
  if (s < 60) return ` ${s} 秒`;
  return `约 ${Math.ceil(s / 60)} 分钟`;
}

export function throttle(action, { maxAttempts = 5, windowMs = 15 * 60_000, message = "操作过于频繁" } = {}) {
  if (!_stores[action]) {
    _stores[action] = { attempts: [], windowMs, maxAttempts, message };
  }
  const s = _stores[action];

  function prune(now) {
    s.attempts = s.attempts.filter(t => now - t < s.windowMs);
  }

  /** Seconds until one more attempt is allowed (0 when allowed now). */
  function waitSeconds() {
    const now = Date.now();
    prune(now);
    if (s.attempts.length < s.maxAttempts) return 0;
    return Math.max(1, Math.ceil((s.attempts[0] + s.windowMs - now) / 1000));
  }

  return {
    allow() {
      const now = Date.now();
      prune(now);
      if (s.attempts.length >= s.maxAttempts) return false;
      s.attempts.push(now);
      return true;
    },
    waitSeconds,
    get message() {
      const wait = waitSeconds() || Math.ceil(s.windowMs / 1000);
      const windowText = s.windowMs >= 60_000 ? `${Math.round(s.windowMs / 60_000)} 分钟` : `${Math.round(s.windowMs / 1000)} 秒`;
      const base = String(s.message || "操作过于频繁").replace(/[，。,.\s]*请稍后再试[。.]?$/, "");
      return `${base}，请等待${formatWait(wait)}后再试（${windowText}内最多 ${s.maxAttempts} 次）。`;
    },
    reset() {
      s.attempts = [];
    },
  };
}
