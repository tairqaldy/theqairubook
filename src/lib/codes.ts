import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { randomInt, timingSafeEqual } from "node:crypto";
import { db } from "../db/index.js";
import { emailCodes, type User } from "../db/schema.js";
import { sign } from "../auth/session.js";
import { sendEmail } from "./email.js";

export type CodePurpose = "claim" | "reset";

const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 3;
// With 6-digit codes this keeps guessing odds per account below 1 in 50,000 a day.
const MAX_WRONG_PER_DAY = 15;
// First key of the advisory lock (the second is the user id).
const EMAIL_CODE_LOCK = 72113;

function hashCode(codeId: number, code: string): string {
  return sign(`email-code:${codeId}:${code}`);
}

/** Opaque, signed reference to a code row, safe to put in a URL (no email inside). */
export function codeTicket(codeId: number): string {
  return `${codeId}.${sign(`code-ticket:${codeId}`).slice(0, 24)}`;
}

export function codeIdFromTicket(ticket: string | undefined): number | null {
  if (!ticket) return null;
  const [idStr, sig] = ticket.split(".");
  const id = Number(idStr);
  if (!Number.isInteger(id) || id < 1 || id > 2147483647 || !sig) return null;
  const expected = Buffer.from(sign(`code-ticket:${id}`).slice(0, 24));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}

const SUBJECTS: Record<CodePurpose, string> = {
  claim: "Your theqairubook activation code",
  reset: "Your theqairubook password reset code",
};

/**
 * Creates a 6-digit code for the user and emails it to their student address.
 * Returns a ticket for the verify page, "rate_limited", or "send_failed".
 */
export async function sendCode(
  user: Pick<User, "id" | "email" | "name">,
  purpose: CodePurpose
): Promise<{ ticket: string } | "rate_limited" | "send_failed"> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const issued = await db.transaction(async (tx) => {
    // Serialise issuance per account so parallel requests can't beat the caps.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${EMAIL_CODE_LOCK}, ${user.id})`);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [stats] = await tx
      .select({
        lastHour: sql<number>`count(*) filter (where ${emailCodes.createdAt} > ${hourAgo.toISOString()}::timestamp)::int`,
        wrongToday: sql<number>`coalesce(sum(${emailCodes.attempts}), 0)::int`,
      })
      .from(emailCodes)
      .where(
        and(eq(emailCodes.userId, user.id), eq(emailCodes.purpose, purpose), gt(emailCodes.createdAt, dayAgo))
      );
    if (Number(stats?.lastHour ?? 0) >= MAX_CODES_PER_HOUR) return null;
    // Across all codes: past this many wrong guesses in 24h, stop issuing codes.
    if (Number(stats?.wrongToday ?? 0) >= MAX_WRONG_PER_DAY) return null;

    // Only one live code per account and purpose.
    await tx
      .update(emailCodes)
      .set({ consumedAt: new Date() })
      .where(and(eq(emailCodes.userId, user.id), eq(emailCodes.purpose, purpose), isNull(emailCodes.consumedAt)));
    const [row] = await tx
      .insert(emailCodes)
      .values({
        userId: user.id,
        purpose,
        codeHash: "pending",
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      })
      .returning({ id: emailCodes.id });
    await tx.update(emailCodes).set({ codeHash: hashCode(row.id, code) }).where(eq(emailCodes.id, row.id));
    return row;
  });
  if (!issued) return "rate_limited";
  const row = issued;

  const first = user.name.split(" ")[0];
  const action = purpose === "claim" ? "activate your theqairubook account" : "reset your theqairubook password";
  const sent = await sendEmail({
    to: user.email,
    subject: SUBJECTS[purpose],
    text:
      `Hi ${first},\n\n` +
      `Your code to ${action} is:\n\n    ${code}\n\n` +
      `It expires in 15 minutes. If you didn't ask for this, you can ignore this email — ` +
      `nobody can use your account without this code.\n\n` +
      `— theqairubook · https://the.qairuhub.com`,
  });
  if (!sent) {
    await db.update(emailCodes).set({ consumedAt: new Date() }).where(eq(emailCodes.id, row.id));
    return "send_failed";
  }
  return { ticket: codeTicket(row.id) };
}

export type CodeCheck =
  | { ok: true; userId: number; codeId: number }
  | { ok: false; reason: "invalid_ticket" | "expired" | "too_many_attempts" | "wrong_code" };

/** Looks up the (unconsumed, unexpired) code row a ticket points to, without checking a code. */
export async function ticketStatus(ticket: string | undefined, purpose: CodePurpose) {
  const codeId = codeIdFromTicket(ticket);
  if (!codeId) return null;
  const [row] = await db
    .select()
    .from(emailCodes)
    .where(and(eq(emailCodes.id, codeId), eq(emailCodes.purpose, purpose)))
    .limit(1);
  if (!row || row.consumedAt || row.expiresAt.getTime() < Date.now() || row.attempts >= MAX_ATTEMPTS) {
    return null;
  }
  return row;
}

/**
 * Checks a typed code. Every wrong try counts; the code dies after 5 tries or
 * 15 minutes. On success the code is consumed (single use).
 */
export async function verifyCode(
  ticket: string | undefined,
  purpose: CodePurpose,
  typed: string
): Promise<CodeCheck> {
  const codeId = codeIdFromTicket(ticket);
  if (!codeId) return { ok: false, reason: "invalid_ticket" };
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(emailCodes)
      .where(and(eq(emailCodes.id, codeId), eq(emailCodes.purpose, purpose), isNull(emailCodes.consumedAt)))
      .limit(1)
      .for("update");
    if (!row) return { ok: false as const, reason: "invalid_ticket" as const };
    if (row.expiresAt.getTime() < Date.now()) return { ok: false as const, reason: "expired" as const };
    if (row.attempts >= MAX_ATTEMPTS) return { ok: false as const, reason: "too_many_attempts" as const };

    const code = typed.replace(/\D/g, "").slice(0, 6);
    const expected = Buffer.from(row.codeHash);
    const given = Buffer.from(hashCode(row.id, code));
    const match = code.length === 6 && expected.length === given.length && timingSafeEqual(expected, given);
    if (!match) {
      await tx.update(emailCodes).set({ attempts: row.attempts + 1 }).where(eq(emailCodes.id, row.id));
      return { ok: false as const, reason: row.attempts + 1 >= MAX_ATTEMPTS ? ("too_many_attempts" as const) : ("wrong_code" as const) };
    }
    await tx.update(emailCodes).set({ consumedAt: new Date() }).where(eq(emailCodes.id, row.id));
    return { ok: true as const, userId: row.userId, codeId: row.id };
  });
}

export function codeError(reason: Exclude<CodeCheck, { ok: true }>["reason"]): string {
  switch (reason) {
    case "wrong_code":
      return "That code isn't right. Check the email and try again.";
    case "too_many_attempts":
      return "Too many wrong tries. Request a new code.";
    case "expired":
      return "That code expired. Request a new one.";
    default:
      return "That link is no longer valid. Start again.";
  }
}

// ---------------------------------------------------------------------------
// Admin claim links: a manual alternative to email verification. Valid for 7
// days and only while the account's session_version is unchanged, so a link
// dies as soon as it's used (claiming bumps the version) or the admin resets again.

const CLAIM_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function claimLinkToken(user: Pick<User, "id" | "sessionVersion">): string {
  const expires = Date.now() + CLAIM_LINK_TTL_MS;
  const payload = `${user.id}.${user.sessionVersion}.${expires}`;
  return `${payload}.${sign(`claim-link:${payload}`)}`;
}

export function parseClaimLinkToken(
  token: string | undefined
): { userId: number; sessionVersion: number } | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [id, version, expires, sig] = parts;
  const payload = `${id}.${version}.${expires}`;
  const expected = Buffer.from(sign(`claim-link:${payload}`));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (!(Number(expires) > Date.now())) return null;
  const userId = Number(id);
  const sessionVersion = Number(version);
  if (!Number.isInteger(userId) || !Number.isInteger(sessionVersion)) return null;
  return { userId, sessionVersion };
}
