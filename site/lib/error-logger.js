/**
 * error-logger.js — Minimal structured error logging for critical paths.
 * Captures errors and sends them to console + optional remote endpoint.
 * Does NOT log PII or credentials: e-mail addresses, follow-up link codes,
 * session tokens and URL query/hash parts are masked before anything is written.
 */
(function(){
  "use strict";

  var LOG_ENDPOINT = null; // Set to a same-origin URL to enable remote logging

  /** Mask personal data and credentials in free text. */
  function redact(value){
    var text = value === null || value === undefined ? "" : String(value);
    return text
      // URL query strings and fragments may carry access tokens or link codes.
      .replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/gi, "$1?[已隐藏]")
      // Patient follow-up links: /p/<code>
      .replace(/\/p\/[^\s/?#"']+/g, "/p/[已隐藏]")
      // e-mail addresses
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱已隐藏]")
      // JWT-like and long random strings (session tokens, link codes)
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[凭据已隐藏]")
      .replace(/[A-Za-z0-9_-]{32,}/g, "[凭据已隐藏]")
      .slice(0, 500);
  }

  function safeMeta(meta){
    if (!meta || typeof meta !== "object") return meta === undefined ? undefined : redact(meta);
    var out = {};
    Object.keys(meta).slice(0, 20).forEach(function(key){
      var v = meta[key];
      out[key] = (typeof v === "number" || typeof v === "boolean" || v === null) ? v : redact(v);
    });
    return out;
  }

  function messageOf(error){
    if (error instanceof Error) return error.message;
    if (error && typeof error === "object") return error.message || error.code || "[对象]";
    return String(error);
  }

  var ErrorLogger = {
    redact: redact,

    /**
     * Log an error for a critical path.
     * @param {string} path - e.g. "checkout.submit", "staff.login", "demo.submit"
     * @param {Error|string} error - the error object or message
     * @param {Object} [meta] - additional context (no PII!)
     */
    log: function(path, error, meta){
      var entry = {
        ts: new Date().toISOString(),
        path: path,
        message: redact(messageOf(error)),
        url: redact(location.pathname),
        ua: navigator.userAgent.slice(0, 120)
      };
      var cleanMeta = safeMeta(meta);
      if (cleanMeta !== undefined) entry.meta = cleanMeta;

      // Always log to console
      console.error("[ErrorLogger]", path, entry.message, cleanMeta || "");

      // Remote logging if configured
      if (LOG_ENDPOINT){
        try {
          navigator.sendBeacon(LOG_ENDPOINT, JSON.stringify(entry));
        } catch(e){
          // Silently fail — don't break the page for logging
        }
      }
    },

    /**
     * Wrap an async function with error logging.
     * @param {string} path
     * @param {Function} fn
     * @returns {Function}
     */
    wrap: function(path, fn){
      return async function(){
        try {
          return await fn.apply(this, arguments);
        } catch(e){
          ErrorLogger.log(path, e);
          throw e;
        }
      };
    }
  };

  window.ErrorLogger = ErrorLogger;

  // Global unhandled error handler
  window.addEventListener("error", function(event){
    ErrorLogger.log("global.error", event.error || event.message, {
      filename: event.filename,
      lineno: event.lineno
    });
  });

  window.addEventListener("unhandledrejection", function(event){
    ErrorLogger.log("global.unhandledrejection", event.reason || "unknown");
  });
})();
