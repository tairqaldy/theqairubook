import type { Context } from "hono";

/**
 * The origin users actually see. Behind Railway's proxy the Node server only
 * sees plain http on an internal port, so `c.req.url` would produce
 * `http://...` links. Prefer an explicit PUBLIC_URL, then forwarded headers,
 * then Railway's injected domain.
 */
export function publicOrigin(c: Context): string {
  const explicit = process.env.PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const reqUrl = new URL(c.req.url);
  const forwardedProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || c.req.header("host") || reqUrl.host;

  if (!forwardedProto && !forwardedHost && process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  const proto = forwardedProto || reqUrl.protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function isHttps(c: Context): boolean {
  return publicOrigin(c).startsWith("https://");
}

/** Only allow http(s) links in user-supplied URLs (blocks javascript: etc). */
export function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Same-site path to go back to after a POST, from the Referer header. */
export function backPath(c: Context, fallback: string): string {
  const referer = c.req.header("referer");
  if (!referer) return fallback;
  try {
    const url = new URL(referer);
    return url.pathname + url.search;
  } catch {
    return fallback;
  }
}
