import type { Context } from "hono";
import { sign, verifySignature } from "../auth/session.js";

/**
 * Client IP for rate limiting, using only values a client can't forge:
 * Railway's edge overwrites X-Real-IP and appends the true client to
 * X-Forwarded-For (so only the right-most hop is trustworthy). CF-Connecting-IP
 * is only trusted when the hostname is proxied through Cloudflare.
 */
export function clientIp(c: Context): string {
  if (process.env.TRUST_CF_CONNECTING_IP === "1") {
    const cf = c.req.header("cf-connecting-ip")?.trim();
    if (cf) return cf;
  }
  const realIp = c.req.header("x-real-ip")?.trim();
  if (realIp) return realIp;
  const hops = c.req.header("x-forwarded-for")?.split(",").map((h) => h.trim()).filter(Boolean);
  return hops?.length ? hops[hops.length - 1] : "unknown";
}

// ---------------------------------------------------------------------------
// Rate limiting — fixed windows in memory. The app runs as a single instance,
// so this is enough to stop bursts of signups, login guessing and spam.

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60_000).unref();

/**
 * Counts one hit against `key`. Returns true when the caller is still within
 * `limit` hits per `windowMs`, false when they should be refused.
 */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count++;
  return bucket.count <= limit;
}

/** Forget a key, e.g. after a successful login. */
export function resetRateLimit(key: string) {
  buckets.delete(key);
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Shared limits so every route throttles the same way. */
export const LIMITS = {
  loginPerIp: [20, 15 * MIN],
  // Failed passwords for one account from one IP: an attacker only locks themselves out.
  loginPerEmailIp: [8, 15 * MIN],
  // Failed passwords for one account from anywhere: caps distributed guessing.
  loginPerEmail: [30, 15 * MIN],
  registerPerIp: [10, HOUR],
  postsPerUser: [10, HOUR],
  commentsPerUser: [60, HOUR],
  messagesPerUser: [120, HOUR],
  wallPerUser: [40, HOUR],
  friendRequestsPerUser: [60, HOUR],
  uploadsPerUser: [30, HOUR],
  codeRequestsPerIp: [10, HOUR],
  codeAttemptsPerIp: [30, HOUR],
} satisfies Record<string, [number, number]>;

export function withinLimit(name: keyof typeof LIMITS, id: string | number): boolean {
  const [limit, windowMs] = LIMITS[name];
  return rateLimit(`${name}:${id}`, limit, windowMs);
}

const inflight = new Map<string, number>();

/**
 * Reserves an attempt against one or more limits *synchronously*, before any
 * await, so a burst of parallel requests can't all pass the check. Returns
 * null when any limit (finished failures + attempts in flight) is reached;
 * otherwise a `finish(failed)` callback that releases the reservation and
 * counts a hit only for real failures.
 */
export function reserveAttempt(
  keys: [keyof typeof LIMITS, string | number][]
): ((failed: boolean) => void) | null {
  const now = Date.now();
  for (const [name, id] of keys) {
    const key = `${name}:${id}`;
    const bucket = buckets.get(key);
    const used = (bucket && bucket.resetAt > now ? bucket.count : 0) + (inflight.get(key) ?? 0);
    if (used >= LIMITS[name][0]) return null;
  }
  for (const [name, id] of keys) {
    const key = `${name}:${id}`;
    inflight.set(key, (inflight.get(key) ?? 0) + 1);
  }
  let done = false;
  return (failed: boolean) => {
    if (done) return;
    done = true;
    for (const [name, id] of keys) {
      const key = `${name}:${id}`;
      const n = (inflight.get(key) ?? 1) - 1;
      if (n > 0) inflight.set(key, n);
      else inflight.delete(key);
      if (failed) withinLimit(name, id);
    }
  };
}

/** True when `name:id` is already over its limit. Does not count a hit. */
export function isLimited(name: keyof typeof LIMITS, id: string | number): boolean {
  const bucket = buckets.get(`${name}:${id}`);
  return Boolean(bucket && bucket.resetAt > Date.now() && bucket.count >= LIMITS[name][0]);
}

/** Count one hit without deciding anything (e.g. only failed passwords count). */
export function recordHit(name: keyof typeof LIMITS, id: string | number): void {
  withinLimit(name, id);
}

// ---------------------------------------------------------------------------
// Cloudflare Turnstile. Enabled when both keys are set; otherwise verification
// is skipped and only the honeypot + timing guard below apply.

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function turnstileSiteKey(): string | null {
  return process.env.TURNSTILE_SITE_KEY?.trim() || null;
}

export function turnstileEnabled(): boolean {
  return Boolean(turnstileSiteKey() && process.env.TURNSTILE_SECRET_KEY?.trim());
}

export async function verifyTurnstile(c: Context, token: unknown): Promise<boolean> {
  if (!turnstileEnabled()) return true;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body: new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET_KEY!.trim(),
        response: token,
        remoteip: clientIp(c),
      }),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error("turnstile verification failed", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Form guard: a hidden honeypot field bots tend to fill, plus a signed render
// timestamp so instant submissions (and replayed stale forms) are rejected.

export const HONEYPOT_FIELD = "website_url";
export const FORM_TS_FIELD = "form_ts";
const MIN_FILL_MS = 1500;
const MAX_FORM_AGE_MS = 6 * HOUR;

export function issueFormTimestamp(): string {
  const ts = String(Date.now());
  return `${ts}.${sign(`form:${ts}`)}`;
}

export type GuardResult = { ok: true } | { ok: false; reason: "bot" | "too_fast" | "expired" };

export function checkFormGuard(body: Record<string, unknown>): GuardResult {
  const honeypot = body[HONEYPOT_FIELD];
  if (typeof honeypot === "string" && honeypot.trim() !== "") return { ok: false, reason: "bot" };
  const raw = String(body[FORM_TS_FIELD] ?? "");
  const [ts, sig] = raw.split(".");
  if (!ts || !sig || !verifySignature(`form:${ts}`, sig)) return { ok: false, reason: "expired" };
  const age = Date.now() - Number(ts);
  if (!Number.isFinite(age) || age > MAX_FORM_AGE_MS) return { ok: false, reason: "expired" };
  if (age < MIN_FILL_MS) return { ok: false, reason: "too_fast" };
  return { ok: true };
}

export function guardMessage(result: GuardResult): string {
  if (result.ok) return "";
  if (result.reason === "expired") return "This form expired. Please try again.";
  return "That was a bit too fast. Please try again.";
}
