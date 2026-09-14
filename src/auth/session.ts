import { createHmac, timingSafeEqual } from "node:crypto";

// Never run a deployed instance on the public dev default: sessions would be forgeable.
if (!process.env.SESSION_SECRET && (process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === "production")) {
  throw new Error("SESSION_SECRET must be set in production");
}

const SECRET =
  process.env.SESSION_SECRET ?? "theqairubook-local-dev-secret-change-in-prod";

export function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

export function verifySignature(payload: string, sig: string): boolean {
  const expected = sign(payload);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Token: <userId>.<sessionVersion>.<issuedAtMs>.<signature>
export function encodeSession(userId: number, version: number): string {
  const payload = `${userId}.${version}.${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(
  token: string | undefined
): { userId: number; version: number } | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [userIdStr, versionStr, ts, sig] = parts;
  if (!verifySignature(`${userIdStr}.${versionStr}.${ts}`, sig)) return null;
  const userId = Number(userIdStr);
  const version = Number(versionStr);
  if (!Number.isInteger(userId) || userId < 1) return null;
  if (!Number.isInteger(version) || version < 0) return null;
  const age = Date.now() - Number(ts);
  if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) return null;
  return { userId, version };
}

export function allowedEmail(email: string): boolean {
  const domains = (process.env.ALLOWED_EMAIL_DOMAINS ?? "qairu.edu.kz")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const lower = email.trim().toLowerCase();
  return domains.some((d) => lower.endsWith(`@${d}`));
}
