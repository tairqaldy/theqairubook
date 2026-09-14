import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET =
  process.env.SESSION_SECRET ?? "theqairubook-local-dev-secret-change-in-prod";

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

export function encodeSession(userId: number): string {
  const payload = `${userId}.${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(token: string | undefined): number | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userIdStr, ts, sig] = parts;
  const payload = `${userIdStr}.${ts}`;
  const expected = sign(payload);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  const userId = Number(userIdStr);
  if (!Number.isFinite(userId) || userId < 1) return null;
  // 30 days
  const age = Date.now() - Number(ts);
  if (!Number.isFinite(age) || age > 30 * 24 * 60 * 60 * 1000) return null;
  return userId;
}

export function allowedEmail(email: string): boolean {
  const domains = (process.env.ALLOWED_EMAIL_DOMAINS ?? "qairu.edu.kz")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const lower = email.trim().toLowerCase();
  return domains.some((d) => lower.endsWith(`@${d}`));
}
