import { Hono } from "hono";
import type { Context } from "hono";
import type { Child, FC } from "hono/jsx";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { AppEnv } from "../middleware/auth.js";
import { needLogin, startSession } from "../middleware/auth.js";
import { Layout, LeftNav, Box, FormGuard, TurnstileWidget } from "../views/layout.js";
import { db } from "../db/index.js";
import { emailCodes, users, friendships, type User } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { allowedEmail } from "../auth/session.js";
import { addBoardEvent, makeReferralCode } from "../lib/social.js";
import { awardReferral } from "../lib/rep.js";
import { inviteTarget } from "../lib/invite.js";
import { isHttps } from "../lib/url.js";
import { emailEnabled } from "../lib/email.js";
import {
  codeError,
  codeIdFromTicket,
  parseClaimLinkToken,
  sendCode,
  ticketStatus,
  verifyCode,
  type CodePurpose,
} from "../lib/codes.js";
import {
  checkFormGuard,
  clientIp,
  guardMessage,
  reserveAttempt,
  resetRateLimit,
  verifyTurnstile,
  withinLimit,
} from "../lib/security.js";

export const authRoutes = new Hono<AppEnv>();

const REF_COOKIE = "ref";
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

type Body = Record<string, unknown>;
type Status = 200 | 404 | 429;

const CODES_RATE_LIMITED =
  "We already sent a few codes — check your inbox (and spam) or try again in an hour.";
const CODES_SEND_FAILED = "We couldn't send the email right now. Try again in a few minutes.";
const TOO_MANY_CODE_REQUESTS =
  "Too many code requests from your network. Please wait an hour and try again.";
const TOO_MANY_CODE_TRIES = "Too many tries from your network. Please wait a while and try again.";

function readEmail(body: Body): string {
  return String(body.email ?? "").trim().toLowerCase().slice(0, 254);
}

function readRef(value: unknown): string {
  return String(value ?? "").trim().slice(0, 64);
}

function firstName(user: Pick<User, "name">): string {
  return user.name.split(" ")[0];
}

/** "maksat.aliev@qairu.edu.kz" -> "m••••t.a••••v@qairu.edu.kz" */
function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "••••";
  const local = email
    .slice(0, at)
    .split(".")
    .map((part) =>
      part.length <= 2 ? `${part.slice(0, 1)}•` : `${part[0]}••••${part[part.length - 1]}`
    )
    .join(".");
  return `${local}${email.slice(at)}`;
}

async function findUserById(id: number): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
}

/** An activated member owning this referral code, or null. */
async function findReferrer(code: string): Promise<User | null> {
  if (!code || code.length > 64) return null;
  const [referrer] = await db
    .select()
    .from(users)
    .where(eq(users.referralCode, code))
    .limit(1);
  return referrer && referrer.claimedAt ? referrer : null;
}

/** The not-yet-activated classmate a personal invite link was addressed to. */
async function findInvitee(forParam: string | undefined): Promise<User | null> {
  const id = inviteTarget(forParam);
  if (!id) return null;
  const target = await findUserById(id);
  return target && target.claimedAt === null ? target : null;
}

/** Returns a message when the password breaks the rules, otherwise null. */
function passwordProblem(password: string, confirm: string, email: string): string | null {
  if (password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters.`;
  }
  if (password.length > MAX_PASSWORD) return "That password is too long.";
  const local = email.split("@")[0];
  if (local.length >= 3 && password.toLowerCase().includes(local)) {
    return "Password must not contain your email name.";
  }
  if (password !== confirm) return "The two passwords don't match.";
  return null;
}

// ---------------------------------------------------------------------------
// Claiming a pre-created account from the student list.

/** Why this listed account can't be claimed through the public flow, or null. */
function claimBlocker(account: User): Child | null {
  if (account.claimedAt) return <AlreadyActivated />;
  if (account.suspendedAt) return <SuspendedNote />;
  if (account.claimLocked) return <LockedNote />;
  return null;
}

/**
 * Sets the password on a pre-created account. The WHERE guards make it atomic:
 * if two tabs race (or an admin locks/suspends meanwhile), only one wins.
 * Bumps session_version so no session issued before the claim stays valid.
 */
async function claimAccount(
  account: User,
  password: string,
  referrer: User | null
): Promise<User | null> {
  const now = new Date();
  const [user] = await db
    .update(users)
    .set({
      passwordHash: hashPassword(password),
      claimedAt: now,
      memberSince: now,
      lastUpdate: now,
      claimLocked: false,
      sessionVersion: sql`${users.sessionVersion} + 1`,
      referralCode: sql`coalesce(${users.referralCode}, ${makeReferralCode(account.name)})`,
      ...(referrer ? { referredByUserId: referrer.id } : {}),
    })
    .where(
      and(
        eq(users.id, account.id),
        isNull(users.claimedAt),
        eq(users.claimLocked, false),
        isNull(users.suspendedAt)
      )
    )
    .returning();
  return user ?? null;
}

/** Referrer and new member become friends, reusing any existing request row. */
async function befriend(a: number, b: number) {
  const updated = await db
    .update(friendships)
    .set({ status: "accepted" })
    .where(
      or(
        and(eq(friendships.fromUserId, a), eq(friendships.toUserId, b)),
        and(eq(friendships.fromUserId, b), eq(friendships.toUserId, a))
      )
    )
    .returning({ id: friendships.id });
  if (updated.length > 0) return;
  await db
    .insert(friendships)
    .values({ fromUserId: a, toUserId: b, status: "accepted" })
    .onConflictDoNothing();
}

/** Claims, announces, links the referral and logs the new member in. */
async function claimAndWelcome(
  c: Context<AppEnv>,
  account: User,
  password: string,
  referrer: User | null
): Promise<{ user: User } | { error: Child }> {
  const user = await claimAccount(account, password, referrer);
  if (!user) {
    const fresh = await findUserById(account.id);
    const blocked = fresh ? claimBlocker(fresh) : null;
    return { error: blocked ?? <AlreadyActivated /> };
  }
  await addBoardEvent(user.id, "joined", `${user.name} joined theqairubook`);
  if (referrer && referrer.id !== user.id) {
    await befriend(referrer.id, user.id);
    const earned = await awardReferral(referrer.id, user.id);
    await addBoardEvent(user.id, "referral", earned ? `+${earned} rep` : "", referrer.id);
  }
  if (getCookie(c, REF_COOKIE)) deleteCookie(c, REF_COOKIE, { path: "/" });
  startSession(c, user);
  return { user };
}

type Gate = { account: User } | { error: Child; status?: Status };

/** Rate limits, anti-bot checks and the student-list lookup for step 1. */
async function checkClaimRequest(c: Context<AppEnv>, body: Body): Promise<Gate> {
  const ip = clientIp(c);
  if (!withinLimit("registerPerIp", ip)) {
    return {
      error: "Too many sign-up attempts from your network. Please wait an hour and try again.",
      status: 429,
    };
  }
  const guard = checkFormGuard(body);
  if (!guard.ok) return { error: guardMessage(guard) };
  if (!(await verifyTurnstile(c, body["cf-turnstile-response"]))) {
    return { error: "Please complete the anti-bot check." };
  }
  if (emailEnabled() && !withinLimit("codeRequestsPerIp", ip)) {
    return { error: TOO_MANY_CODE_REQUESTS, status: 429 };
  }

  const email = readEmail(body);
  if (!allowedEmail(email)) {
    return { error: "Please use your @qairu.edu.kz student email address." };
  }
  const [account] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!account) return { error: <NotOnList /> };
  const blocked = claimBlocker(account);
  if (blocked) return { error: blocked };
  return { account };
}

type StepResult = { redirect: string } | { error: Child; status?: Status };

/**
 * POST /register and POST /r/:code. With email configured this sends a code
 * and points to the verify step; otherwise it claims right away (single step).
 */
async function handleRegister(
  c: Context<AppEnv>,
  body: Body,
  invite: { code: string; referrer: User } | null
): Promise<StepResult> {
  const gate = await checkClaimRequest(c, body);
  if ("error" in gate) return gate;
  const { account } = gate;

  if (emailEnabled()) {
    const sent = await sendCode(account, "claim");
    if (sent === "rate_limited") return { error: CODES_RATE_LIMITED };
    if (sent === "send_failed") return { error: CODES_SEND_FAILED };
    return { redirect: verifyUrl(CLAIM_FLOW, sent.ticket, invite?.code ?? "") };
  }

  const password = String(body.password ?? "");
  const problem = passwordProblem(password, String(body.confirm ?? ""), account.email);
  if (problem) return { error: problem };
  const outcome = await claimAndWelcome(c, account, password, invite?.referrer ?? null);
  if ("error" in outcome) return { error: outcome.error };
  return { redirect: "/edit-profile?welcome=1" };
}

// ---------------------------------------------------------------------------
// Emailed codes: shared step 2 for activation and password reset.

type CodeFlow = {
  purpose: CodePurpose;
  verifyPath: string;
  resendPath: string;
  startPath: string;
  title: string;
  boxTitle: string;
  submitLabel: string;
  passwordLabel: string;
};

const CLAIM_FLOW: CodeFlow = {
  purpose: "claim",
  verifyPath: "/register/verify",
  resendPath: "/register/resend",
  startPath: "/register",
  title: "Register",
  boxTitle: "[ Check Your Email ]",
  submitLabel: "Activate My Account",
  passwordLabel: "Password:",
};

const RESET_FLOW: CodeFlow = {
  purpose: "reset",
  verifyPath: "/forgot/verify",
  resendPath: "/forgot/resend",
  startPath: "/forgot",
  title: "Reset Password",
  boxTitle: "[ Check Your Email ]",
  submitLabel: "Set New Password",
  passwordLabel: "New password:",
};

function verifyUrl(flow: CodeFlow, ticket: string, ref = "", sent = false): string {
  const params = new URLSearchParams({ t: ticket });
  if (ref) params.set("ref", ref);
  if (sent) params.set("sent", "1");
  return `${flow.verifyPath}?${params.toString()}`;
}

/** Why this account can't continue the flow, or null. */
function flowBlocker(flow: CodeFlow, user: User): Child | null {
  if (flow.purpose === "claim") return claimBlocker(user);
  if (user.suspendedAt) return <SuspendedNote />;
  if (!user.claimedAt) {
    return (
      <>
        This account isn't activated yet — <a href="/register">register first</a>.
      </>
    );
  }
  return null;
}

/** The live code row a ticket points to, plus its account. */
async function loadTicket(flow: CodeFlow, ticket: string | undefined) {
  const row = await ticketStatus(ticket, flow.purpose);
  if (!row) return null;
  const user = await findUserById(row.userId);
  return user ? { row, user } : null;
}

/** Renders step 2 for a ticket, or a "start again" page if the ticket is dead. */
async function renderCodeStep(
  c: Context<AppEnv>,
  flow: CodeFlow,
  ticket: string,
  ref: string,
  error?: Child,
  status?: Status,
  notice?: string
): Promise<Response> {
  const ctx = await loadTicket(flow, ticket);
  if (!ctx) return c.html(startOverPage(flow, error), status ?? 200);
  const blocked = flowBlocker(flow, ctx.user);
  if (blocked) return c.html(startOverPage(flow, blocked), status ?? 200);
  const safeRef = flow.purpose === "claim" && ref && (await findReferrer(ref)) ? ref : "";
  return c.html(
    codeStepPage(flow, {
      ticket,
      ref: safeRef,
      maskedEmail: maskEmail(ctx.user.email),
      error,
      notice,
    }),
    status ?? 200
  );
}

/** "Resend code": a fresh code for the same account, the old one stops working. */
async function resendCode(c: Context<AppEnv>, flow: CodeFlow): Promise<Response> {
  const body = await c.req.parseBody();
  const ticket = String(body.t ?? "");
  const ref = readRef(body.ref);
  const retry = (error: Child, status?: Status) =>
    renderCodeStep(c, flow, ticket, ref, error, status);

  if (!withinLimit("codeRequestsPerIp", clientIp(c))) return retry(TOO_MANY_CODE_REQUESTS, 429);
  const guard = checkFormGuard(body);
  if (!guard.ok) return retry(guardMessage(guard));

  // The old code may already be dead (expired, too many tries); the signed
  // ticket still proves we issued it, so allow a resend within a day.
  const codeId = codeIdFromTicket(ticket);
  if (!codeId) return c.html(startOverPage(flow));
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select()
    .from(emailCodes)
    .where(
      and(
        eq(emailCodes.id, codeId),
        eq(emailCodes.purpose, flow.purpose),
        gt(emailCodes.createdAt, dayAgo)
      )
    )
    .limit(1);
  if (!row) return c.html(startOverPage(flow));
  const user = await findUserById(row.userId);
  if (!user) return c.html(startOverPage(flow));
  const blocked = flowBlocker(flow, user);
  if (blocked) return c.html(startOverPage(flow, blocked));

  const sent = await sendCode(user, flow.purpose);
  if (sent === "rate_limited") return retry(CODES_RATE_LIMITED);
  if (sent === "send_failed") return retry(CODES_SEND_FAILED);
  await db
    .update(emailCodes)
    .set({ consumedAt: new Date() })
    .where(and(eq(emailCodes.id, row.id), isNull(emailCodes.consumedAt)));
  return c.redirect(verifyUrl(flow, sent.ticket, ref, true));
}

function sentNotice(c: Context<AppEnv>): string | undefined {
  return c.req.query("sent") ? "We sent you a new code." : undefined;
}

// ---------------------------------------------------------------------------
// Register

authRoutes.get("/register", async (c) => {
  if (c.get("user")) return c.redirect("/home");
  // Someone who opened a referral link and then clicked "register" keeps it.
  const refCode = getCookie(c, REF_COOKIE);
  if (refCode) {
    const referrer = await findReferrer(refCode);
    if (referrer) return c.redirect(`/r/${encodeURIComponent(refCode)}`);
    deleteCookie(c, REF_COOKIE, { path: "/" });
  }
  return c.html(registerPage(""));
});

authRoutes.post("/register", async (c) => {
  if (c.get("user")) return c.redirect("/home");
  const body = await c.req.parseBody();
  const result = await handleRegister(c, body, null);
  if ("error" in result) {
    return c.html(registerPage(readEmail(body), result.error), result.status ?? 200);
  }
  return c.redirect(result.redirect);
});

authRoutes.get("/register/verify", async (c) => {
  if (c.get("user")) return c.redirect("/home");
  if (!emailEnabled()) return c.redirect("/register");
  return renderCodeStep(
    c,
    CLAIM_FLOW,
    c.req.query("t") ?? "",
    readRef(c.req.query("ref")),
    undefined,
    undefined,
    sentNotice(c)
  );
});

authRoutes.post("/register/verify", async (c) => {
  if (c.get("user")) return c.redirect("/home");
  if (!emailEnabled()) return c.redirect("/register");
  const body = await c.req.parseBody();
  const ticket = String(body.t ?? "");
  const ref = readRef(body.ref);
  const retry = (error: Child, status?: Status) =>
    renderCodeStep(c, CLAIM_FLOW, ticket, ref, error, status);

  if (!withinLimit("codeAttemptsPerIp", clientIp(c))) return retry(TOO_MANY_CODE_TRIES, 429);
  const guard = checkFormGuard(body);
  if (!guard.ok) return retry(guardMessage(guard));

  const ctx = await loadTicket(CLAIM_FLOW, ticket);
  if (!ctx) return c.html(startOverPage(CLAIM_FLOW));
  const blocked = claimBlocker(ctx.user);
  if (blocked) return c.html(startOverPage(CLAIM_FLOW, blocked));

  const password = String(body.password ?? "");
  const problem = passwordProblem(password, String(body.confirm ?? ""), ctx.user.email);
  if (problem) return retry(problem);

  const check = await verifyCode(ticket, "claim", String(body.code ?? ""));
  if (!check.ok) {
    return check.reason === "wrong_code"
      ? retry(codeError(check.reason))
      : c.html(startOverPage(CLAIM_FLOW, codeError(check.reason)));
  }
  const account = await findUserById(check.userId);
  if (!account) return c.html(startOverPage(CLAIM_FLOW));
  const stillBlocked = claimBlocker(account);
  if (stillBlocked) return c.html(startOverPage(CLAIM_FLOW, stillBlocked));

  // The referral survives the detour through the inbox: hidden field first,
  // then the cookie set by /r/:code. Both are re-validated here.
  const cookieRef = getCookie(c, REF_COOKIE) ?? "";
  const referrer =
    (ref ? await findReferrer(ref) : null) ?? (cookieRef ? await findReferrer(cookieRef) : null);

  const outcome = await claimAndWelcome(c, account, password, referrer);
  if ("error" in outcome) return c.html(startOverPage(CLAIM_FLOW, outcome.error));
  return c.redirect("/edit-profile?welcome=1");
});

authRoutes.post("/register/resend", (c) => {
  if (c.get("user")) return c.redirect("/home");
  if (!emailEnabled()) return c.redirect("/register");
  return resendCode(c, CLAIM_FLOW);
});

// ---------------------------------------------------------------------------
// Referral links: /r/<code>[?for=<id>.<sig>]

type Invite = { code: string; referrer: User; invitee: User | null; forParam: string };

async function loadInvite(c: Context<AppEnv>): Promise<Invite | null> {
  const code = c.req.param("code") ?? "";
  const referrer = await findReferrer(code);
  if (!referrer) return null;
  const invitee = await findInvitee(c.req.query("for"));
  return { code, referrer, invitee, forParam: invitee ? c.req.query("for") ?? "" : "" };
}

authRoutes.get("/r/:code", async (c) => {
  const viewer = c.get("user");
  const invite = await loadInvite(c);
  if (!invite) return c.html(invalidInvite(viewer), 404);
  if (viewer) return c.html(alreadyMember(viewer, invite.referrer));

  setCookie(c, REF_COOKIE, invite.code, {
    httpOnly: true,
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    sameSite: "Lax",
    secure: isHttps(c),
  });
  return c.html(joinPage(invite, invite.invitee?.email ?? ""));
});

authRoutes.post("/r/:code", async (c) => {
  if (c.get("user")) return c.redirect("/home");
  const invite = await loadInvite(c);
  if (!invite) return c.html(invalidInvite(null), 404);

  const body = await c.req.parseBody();
  const result = await handleRegister(c, body, invite);
  if ("error" in result) {
    return c.html(joinPage(invite, readEmail(body), result.error), result.status ?? 200);
  }
  return c.redirect(result.redirect);
});

// Old one-time invite tokens are gone; everyone registers from the list now.
authRoutes.get("/join/:token", (c) => c.redirect("/register"));
authRoutes.post("/join/:token", (c) => c.redirect("/register"));

// ---------------------------------------------------------------------------
// Admin activation / reset links: /claim/<token>

async function loadClaimLink(token: string | undefined) {
  const parsed = parseClaimLinkToken(token);
  if (!parsed) return null;
  const user = await findUserById(parsed.userId);
  if (!user || user.sessionVersion !== parsed.sessionVersion || user.suspendedAt) return null;
  return { user, version: parsed.sessionVersion };
}

authRoutes.get("/claim/:token", async (c) => {
  const token = c.req.param("token");
  const link = await loadClaimLink(token);
  if (!link) return c.html(invalidClaimLinkPage(c.get("user")), 404);
  return c.html(claimLinkPage(token, link.user));
});

authRoutes.post("/claim/:token", async (c) => {
  const token = c.req.param("token");
  const body = await c.req.parseBody();
  const link = await loadClaimLink(token);
  if (!link) return c.html(invalidClaimLinkPage(c.get("user")), 404);
  const { user, version } = link;

  const guard = checkFormGuard(body);
  if (!guard.ok) return c.html(claimLinkPage(token, user, guardMessage(guard)));
  const password = String(body.password ?? "");
  const problem = passwordProblem(password, String(body.confirm ?? ""), user.email);
  if (problem) return c.html(claimLinkPage(token, user, problem));

  const nowSql = sql`${new Date().toISOString()}::timestamp`;
  const [updated] = await db
    .update(users)
    .set({
      passwordHash: hashPassword(password),
      claimedAt: sql`coalesce(${users.claimedAt}, ${nowSql})`,
      memberSince: sql`case when ${users.claimedAt} is null then ${nowSql} else ${users.memberSince} end`,
      referralCode: sql`coalesce(${users.referralCode}, ${makeReferralCode(user.name)})`,
      claimLocked: false,
      sessionVersion: sql`${users.sessionVersion} + 1`,
    })
    .where(
      and(eq(users.id, user.id), eq(users.sessionVersion, version), isNull(users.suspendedAt))
    )
    .returning();
  if (!updated) return c.html(invalidClaimLinkPage(c.get("user")), 404);

  const firstActivation = user.claimedAt === null;
  if (firstActivation) {
    await addBoardEvent(updated.id, "joined", `${updated.name} joined theqairubook`);
  }
  resetRateLimit(`loginPerEmail:${updated.email}`);
  startSession(c, updated);
  return c.redirect(firstActivation ? "/edit-profile?welcome=1" : "/home");
});

// ---------------------------------------------------------------------------
// Login / logout

authRoutes.get("/login", (c) => {
  if (c.get("user")) return c.redirect("/home");
  return c.html(loginPage(""));
});

authRoutes.post("/login", async (c) => {
  if (c.get("user")) return c.redirect("/home");
  const body = await c.req.parseBody();
  const email = readEmail(body);
  const password = String(body.password ?? "");

  if (!withinLimit("loginPerIp", clientIp(c))) {
    return c.html(
      loginPage(email, "Too many attempts. Please wait 15 minutes and try again."),
      429
    );
  }
  const guard = checkFormGuard(body);
  if (!guard.ok) return c.html(loginPage(email, guardMessage(guard)));
  // Reserve before any await so parallel guesses can't slip past the limit.
  // Only real failed passwords count (bare POSTs can't lock anyone out), and a
  // per-(email, IP) limit means one attacker mostly locks out only themselves.
  const ip = clientIp(c);
  const finish = reserveAttempt([
    ["loginPerEmailIp", `${email}|${ip}`],
    ["loginPerEmail", email],
  ]);
  if (!finish) {
    return c.html(
      loginPage(
        email,
        <>
          Too many failed attempts for this account. Wait 15 minutes or{" "}
          <a href="/forgot">reset your password</a>.
        </>
      ),
      429
    );
  }
  let failed = false;
  try {
    if (!(await verifyTurnstile(c, body["cf-turnstile-response"]))) {
      return c.html(loginPage(email, "Please complete the anti-bot check."));
    }

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (user && !user.claimedAt) {
      return c.html(
        loginPage(
          email,
          <>
            This account isn't activated yet — <a href="/register">register first</a> with
            this email.
          </>
        )
      );
    }
    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      failed = Boolean(email);
      return c.html(loginPage(email, "Incorrect email or password."));
    }
    if (user.suspendedAt) {
      return c.html(loginPage(email, <SuspendedNote />));
    }

    resetRateLimit(`loginPerEmailIp:${email}|${ip}`);
    startSession(c, user);
    return c.redirect("/home");
  } finally {
    finish(failed);
  }
});

authRoutes.get("/logout", (c) => {
  deleteCookie(c, "session", { path: "/" });
  return c.redirect("/");
});

// ---------------------------------------------------------------------------
// Forgot password

authRoutes.get("/forgot", (c) => {
  if (c.get("user")) return c.redirect("/account/password");
  if (!emailEnabled()) return c.html(forgotByAdminPage());
  return c.html(forgotPage(""));
});

authRoutes.post("/forgot", async (c) => {
  if (c.get("user")) return c.redirect("/account/password");
  if (!emailEnabled()) return c.redirect("/forgot");
  const body = await c.req.parseBody();
  const email = readEmail(body);

  const guard = checkFormGuard(body);
  if (!guard.ok) return c.html(forgotPage(email, guardMessage(guard)));
  if (!(await verifyTurnstile(c, body["cf-turnstile-response"]))) {
    return c.html(forgotPage(email, "Please complete the anti-bot check."));
  }
  if (!withinLimit("codeRequestsPerIp", clientIp(c))) {
    return c.html(forgotPage(email, TOO_MANY_CODE_REQUESTS), 429);
  }
  if (!allowedEmail(email)) {
    return c.html(forgotPage(email, "Please use your @qairu.edu.kz student email address."));
  }

  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNotNull(users.claimedAt), isNull(users.suspendedAt)))
    .limit(1);
  // Same neutral answer whether or not there is such an account.
  if (!user) return c.html(forgotSentPage());

  const sent = await sendCode(user, "reset");
  if (sent === "rate_limited") return c.html(forgotPage(email, CODES_RATE_LIMITED));
  if (sent === "send_failed") return c.html(forgotPage(email, CODES_SEND_FAILED));
  return c.redirect(verifyUrl(RESET_FLOW, sent.ticket));
});

authRoutes.get("/forgot/verify", async (c) => {
  if (c.get("user")) return c.redirect("/account/password");
  if (!emailEnabled()) return c.redirect("/forgot");
  return renderCodeStep(
    c,
    RESET_FLOW,
    c.req.query("t") ?? "",
    "",
    undefined,
    undefined,
    sentNotice(c)
  );
});

authRoutes.post("/forgot/verify", async (c) => {
  if (c.get("user")) return c.redirect("/account/password");
  if (!emailEnabled()) return c.redirect("/forgot");
  const body = await c.req.parseBody();
  const ticket = String(body.t ?? "");
  const retry = (error: Child, status?: Status) =>
    renderCodeStep(c, RESET_FLOW, ticket, "", error, status);

  if (!withinLimit("codeAttemptsPerIp", clientIp(c))) return retry(TOO_MANY_CODE_TRIES, 429);
  const guard = checkFormGuard(body);
  if (!guard.ok) return retry(guardMessage(guard));

  const ctx = await loadTicket(RESET_FLOW, ticket);
  if (!ctx) return c.html(startOverPage(RESET_FLOW));
  const blocked = flowBlocker(RESET_FLOW, ctx.user);
  if (blocked) return c.html(startOverPage(RESET_FLOW, blocked));

  const password = String(body.password ?? "");
  const problem = passwordProblem(password, String(body.confirm ?? ""), ctx.user.email);
  if (problem) return retry(problem);

  const check = await verifyCode(ticket, "reset", String(body.code ?? ""));
  if (!check.ok) {
    return check.reason === "wrong_code"
      ? retry(codeError(check.reason))
      : c.html(startOverPage(RESET_FLOW, codeError(check.reason)));
  }

  const [updated] = await db
    .update(users)
    .set({
      passwordHash: hashPassword(password),
      sessionVersion: sql`${users.sessionVersion} + 1`,
    })
    .where(
      and(eq(users.id, check.userId), isNotNull(users.claimedAt), isNull(users.suspendedAt))
    )
    .returning();
  if (!updated) return c.html(startOverPage(RESET_FLOW));

  resetRateLimit(`loginPerEmail:${updated.email}`);
  startSession(c, updated);
  return c.redirect("/home?reset=1");
});

authRoutes.post("/forgot/resend", (c) => {
  if (c.get("user")) return c.redirect("/account/password");
  if (!emailEnabled()) return c.redirect("/forgot");
  return resendCode(c, RESET_FLOW);
});

// ---------------------------------------------------------------------------
// Change password (logs out every other session)

authRoutes.get("/account/password", (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const notice = c.req.query("changed") ? "Your password was changed. Other sessions were logged out." : "";
  return c.html(passwordPage(gate.user, undefined, notice));
});

authRoutes.post("/account/password", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const body = await c.req.parseBody();
  const current = String(body.current ?? "");
  const next = String(body.password ?? "");

  const finish = reserveAttempt([
    ["loginPerEmailIp", `${user.email}|${clientIp(c)}`],
    ["loginPerEmail", user.email],
  ]);
  if (!finish) {
    return c.html(
      passwordPage(user, "Too many attempts. Please wait 15 minutes and try again."),
      429
    );
  }
  const currentOk = verifyPassword(current, user.passwordHash);
  finish(!currentOk);
  if (!currentOk) {
    return c.html(passwordPage(user, "Your current password is incorrect."));
  }
  const problem = passwordProblem(next, String(body.confirm ?? ""), user.email);
  if (problem) return c.html(passwordPage(user, problem));
  if (verifyPassword(next, user.passwordHash)) {
    return c.html(passwordPage(user, "Pick a new password that differs from your current one."));
  }

  const [updated] = await db
    .update(users)
    .set({
      passwordHash: hashPassword(next),
      sessionVersion: sql`${users.sessionVersion} + 1`,
    })
    .where(eq(users.id, user.id))
    .returning();
  resetRateLimit(`loginPerEmail:${user.email}`);
  // Re-issue this browser's cookie with the new version; all others go stale.
  startSession(c, updated);
  return c.redirect("/account/password?changed=1");
});

// ---------------------------------------------------------------------------
// Views

const ErrorLine: FC<{ error?: Child }> = ({ error }) =>
  error ? <p class="error">{error}</p> : null;

const NotOnList: FC = () => (
  <>
    This email isn't on the QAIRU student list.
    <span class="form-hint error-hint">
      Double-check the spelling — student emails look like{" "}
      <code>first.last@qairu.edu.kz</code>. If you are a QAIRU student and it still
      doesn't work, contact the admin via the <a href="/faq">FAQ</a>.
    </span>
  </>
);

const AlreadyActivated: FC = () => (
  <>
    This account is already activated — <a href="/login">log in</a> instead.
  </>
);

const SuspendedNote: FC = () => (
  <>
    This account is suspended. Contact the admin (see <a href="/faq">FAQ</a>).
  </>
);

const LockedNote: FC = () => (
  <>
    This account was locked after a report. Ask the admin for a personal activation link
    (see <a href="/faq">FAQ</a>).
  </>
);

const QairuOnlyNote: FC = () => (
  <div class="qairu-only">
    <b>Only QAIRU students.</b> Only students on the official QAIRU student list can
    join. Use your <b>@qairu.edu.kz</b> email — your account is already waiting for
    you.
  </div>
);

/** New password + confirm rows. Never re-filled. */
const PasswordRows: FC<{ label?: string }> = ({ label = "Password:" }) => (
  <>
    <tr>
      <td class="field-label">{label}</td>
      <td>
        <input
          type="password"
          name="password"
          size={30}
          required
          minlength={MIN_PASSWORD}
          maxlength={MAX_PASSWORD}
          autocomplete="new-password"
        />
        <span class="form-hint">
          At least {MIN_PASSWORD} characters, and not your email name.
        </span>
      </td>
    </tr>
    <tr>
      <td class="field-label">Confirm:</td>
      <td>
        <input
          type="password"
          name="confirm"
          size={30}
          required
          minlength={MIN_PASSWORD}
          maxlength={MAX_PASSWORD}
          autocomplete="new-password"
        />
      </td>
    </tr>
  </>
);

/**
 * Student email (+ password + confirm when email codes are off), with the
 * anti-bot guard.
 */
const RegisterForm: FC<{ action: string; email: string; label: string }> = ({
  action,
  email,
  label,
}) => {
  const withCode = emailEnabled();
  return (
    <form method="post" action={action} class="auth-form">
      <FormGuard />
      <table class="search-form">
        <tr>
          <td class="field-label">Student email:</td>
          <td>
            <input
              type="email"
              name="email"
              size={30}
              required
              autocomplete="email"
              placeholder="first.last@qairu.edu.kz"
              value={email}
            />
            {withCode ? (
              <span class="form-hint">
                We'll email you a 6-digit code to make sure it's really you.
              </span>
            ) : null}
          </td>
        </tr>
        {withCode ? null : <PasswordRows />}
      </table>
      <TurnstileWidget />
      <div class="btn-row">
        <button class="btn" type="submit">
          {withCode ? "Email Me a Code" : label}
        </button>
      </div>
    </form>
  );
};

function registerPage(email: string, error?: Child) {
  return (
    <Layout title="Register" user={null} banner="Register">
      <Box title="[ Registration ]" alt>
        <QairuOnlyNote />
        <ErrorLine error={error} />
        <RegisterForm action="/register" email={email} label="Activate My Account" />
        <p class="meta">
          Status, class year and the rest of your profile can be filled in right after.
          Already activated? <a href="/login">Login</a>.
        </p>
      </Box>
    </Layout>
  );
}

function joinPage(invite: Invite, email: string, error?: Child) {
  const { code, referrer, invitee, forParam } = invite;
  const inviter = firstName(referrer);
  const action = `/r/${encodeURIComponent(code)}${
    forParam ? `?for=${encodeURIComponent(forParam)}` : ""
  }`;
  return (
    <Layout title={`${inviter} invited you`} user={null} banner="You're Invited!">
      <table class="layout-table">
        <tr>
          <td class="join-main">
            <Box title="[ Join theqairubook ]" alt>
              <p class="invite-greeting">
                {invitee ? `Hi ${firstName(invitee)}! ` : ""}
                {inviter} invited you to theqairubook.
              </p>
              <QairuOnlyNote />
              <p>
                Activate your account below and you'll be friends with {inviter} right
                away.
              </p>
              <ErrorLine error={error} />
              <RegisterForm action={action} email={email} label="Join Now!" />
              <p class="meta">
                Already a member? <a href="/login">Login</a>.
              </p>
            </Box>
          </td>
          <td>
            <Box title="[ Your Friend ]">
              <p>
                <b>{referrer.name}</b>
                <br />
                {referrer.status}
                {referrer.classYear ? ` · Class of ${referrer.classYear}` : ""}
                <br />
                <span class="rep-chip">{referrer.rep}</span> rep
              </p>
              <p class="meta">
                theqairubook is a calm place just for QAIRU students: discussions,
                homework help, study materials, profiles and private chat. No feed, no
                ads.
              </p>
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
}

function codeStepPage(
  flow: CodeFlow,
  props: { ticket: string; ref: string; maskedEmail: string; error?: Child; notice?: string }
) {
  const { ticket, ref, maskedEmail, error, notice } = props;
  return (
    <Layout title={flow.title} user={null} banner={flow.title}>
      <Box title={flow.boxTitle} alt>
        {notice ? <p class="notice">{notice}</p> : null}
        <p class="sent-to">
          We sent a 6-digit code to <b>{maskedEmail}</b>. It works for 15 minutes.
        </p>
        <ErrorLine error={error} />
        <form method="post" action={flow.verifyPath} class="auth-form">
          <FormGuard />
          <input type="hidden" name="t" value={ticket} />
          {ref ? <input type="hidden" name="ref" value={ref} /> : null}
          <table class="search-form">
            <tr>
              <td class="field-label">Code:</td>
              <td>
                <input
                  type="text"
                  name="code"
                  class="code-input"
                  required
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  maxlength={12}
                  placeholder="123456"
                />
              </td>
            </tr>
            <PasswordRows label={flow.passwordLabel} />
          </table>
          <div class="btn-row">
            <button class="btn" type="submit">
              {flow.submitLabel}
            </button>
          </div>
        </form>
        <form method="post" action={flow.resendPath} class="resend-form">
          <FormGuard />
          <input type="hidden" name="t" value={ticket} />
          {ref ? <input type="hidden" name="ref" value={ref} /> : null}
          Didn't get it? Check spam, or{" "}
          <button type="submit" class="btn-link">
            resend code
          </button>
          {" · "}
          <a href={flow.startPath}>use a different email</a>
        </form>
      </Box>
    </Layout>
  );
}

function startOverPage(flow: CodeFlow, error?: Child) {
  return (
    <Layout title={flow.title} user={null} banner={flow.title}>
      <Box title="[ Start Again ]" alt>
        <p class="error">{error ?? "This link expired or was already used."}</p>
        <p>
          <a href={flow.startPath}>
            {flow.purpose === "claim" ? "Start registration again" : "Request a new code"}
          </a>{" "}
          · <a href="/login">Login</a>
        </p>
      </Box>
    </Layout>
  );
}

function claimLinkPage(token: string, user: User, error?: Child) {
  return (
    <Layout title="Set Password" user={null} banner="Set Your Password">
      <Box title={`[ Set your password, ${firstName(user)} ]`} alt>
        <p>
          This personal link is for <b>{maskEmail(user.email)}</b>. Pick a password and
          you're in.
        </p>
        <ErrorLine error={error} />
        <form method="post" action={`/claim/${encodeURIComponent(token)}`} class="auth-form">
          <FormGuard />
          <table class="search-form">
            <PasswordRows />
          </table>
          <div class="btn-row">
            <button class="btn" type="submit">
              Set Password
            </button>
          </div>
        </form>
      </Box>
    </Layout>
  );
}

function invalidClaimLinkPage(viewer: User | null) {
  return (
    <Layout title="Activation Link" user={viewer} banner="Activation Link">
      <Box title="[ Activation Link ]" alt>
        <p class="error">
          This activation link is no longer valid — ask the admin for a new one.
        </p>
        <p>
          See the <a href="/faq">FAQ</a> for how to reach the admin
          {viewer ? (
            <>
              , or go back <a href="/home">home</a>.
            </>
          ) : (
            <>
              , or <a href="/login">log in</a>.
            </>
          )}
        </p>
      </Box>
    </Layout>
  );
}

function alreadyMember(viewer: User, referrer: User) {
  const own = viewer.id === referrer.id;
  return (
    <Layout title="Invite" user={viewer} banner="Invite Link">
      <Box title="[ Invite Link ]" alt>
        {own ? (
          <p>
            This is <b>your</b> invite link — it works! Send it to classmates on the
            QAIRU student list; when they join through it you become friends and you
            earn rep.
          </p>
        ) : (
          <p>
            This is <b>{referrer.name}</b>'s invite link. You're already a member, logged
            in as <b>{viewer.name}</b>, so there's nothing to join.
          </p>
        )}
        <p>
          <a href="/invite">Get your own invite link</a> ·{" "}
          {own ? null : (
            <>
              <a href={`/profile/${referrer.id}`}>View {firstName(referrer)}'s profile</a> ·{" "}
            </>
          )}
          <a href="/home">Home</a>
        </p>
      </Box>
    </Layout>
  );
}

function invalidInvite(viewer: User | null) {
  return (
    <Layout title="Invite" user={viewer} banner="Invite Link">
      <Box title="[ Invite Link ]" alt>
        <p class="error">This invite link isn't valid.</p>
        <p>
          Double-check the link with the friend who sent it
          {viewer ? (
            <>
              , or go back <a href="/home">home</a>.
            </>
          ) : (
            <>
              , or simply <a href="/register">register</a> with your{" "}
              <code>@qairu.edu.kz</code> email — your account is already waiting.
            </>
          )}
        </p>
      </Box>
    </Layout>
  );
}

function loginPage(email: string, error?: Child) {
  return (
    <Layout title="Login" user={null} banner="Login">
      <Box title="[ Login ]" alt>
        <ErrorLine error={error} />
        <form method="post" action="/login" class="auth-form">
          <FormGuard />
          <table class="search-form">
            <tr>
              <td class="field-label">Email:</td>
              <td>
                <input
                  type="email"
                  name="email"
                  size={30}
                  required
                  autocomplete="email"
                  value={email}
                />
              </td>
            </tr>
            <tr>
              <td class="field-label">Password:</td>
              <td>
                <input
                  type="password"
                  name="password"
                  size={30}
                  required
                  autocomplete="current-password"
                />
              </td>
            </tr>
          </table>
          <TurnstileWidget />
          <div class="btn-row">
            <button class="btn" type="submit">
              Login
            </button>
          </div>
        </form>
        <p class="forgot-link">
          <a href="/forgot">Forgot your password?</a>
        </p>
        <p>
          First time here? Your account is already waiting —{" "}
          <a href="/register">activate it</a> with your @qairu.edu.kz email.
        </p>
      </Box>
    </Layout>
  );
}

function forgotPage(email: string, error?: Child) {
  return (
    <Layout title="Reset Password" user={null} banner="Reset Password">
      <Box title="[ Forgot Your Password? ]" alt>
        <p>Enter your student email and we'll send you a 6-digit code to set a new password.</p>
        <ErrorLine error={error} />
        <form method="post" action="/forgot" class="auth-form">
          <FormGuard />
          <table class="search-form">
            <tr>
              <td class="field-label">Student email:</td>
              <td>
                <input
                  type="email"
                  name="email"
                  size={30}
                  required
                  autocomplete="email"
                  placeholder="first.last@qairu.edu.kz"
                  value={email}
                />
              </td>
            </tr>
          </table>
          <TurnstileWidget />
          <div class="btn-row">
            <button class="btn" type="submit">
              Email Me a Code
            </button>
            <a href="/login">Back to Login</a>
          </div>
        </form>
      </Box>
    </Layout>
  );
}

function forgotSentPage() {
  return (
    <Layout title="Reset Password" user={null} banner="Reset Password">
      <Box title="[ Check Your Email ]" alt>
        <p>If that email belongs to an activated account, we've sent a code.</p>
        <p class="meta">
          Nothing arrived after a few minutes? Check spam and the spelling, then{" "}
          <a href="/forgot">try again</a>. Never activated your account?{" "}
          <a href="/register">Register</a> instead.
        </p>
      </Box>
    </Layout>
  );
}

function forgotByAdminPage() {
  return (
    <Layout title="Reset Password" user={null} banner="Reset Password">
      <Box title="[ Forgot Your Password? ]" alt>
        <p>
          For now, password resets are done by the admin. Contact{" "}
          <b>Tair Kaldybayev</b> at{" "}
          <a href="mailto:tair.kaldybaev@qairu.edu.kz">tair.kaldybaev@qairu.edu.kz</a> or
          on theqairubook, and he'll send you a personal link to set a new password.
        </p>
        <p>
          <a href="/login">Back to Login</a> · <a href="/faq">FAQ</a>
        </p>
      </Box>
    </Layout>
  );
}

function passwordPage(user: User, error?: Child, notice?: string) {
  return (
    <Layout title="Change Password" user={user} banner="My Account">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title="[ Change Password ]">
              {notice ? <p class="notice">{notice}</p> : null}
              <ErrorLine error={error} />
              <p>
                Changing your password logs you out everywhere else. This browser stays
                logged in.
              </p>
              <form method="post" action="/account/password" class="auth-form">
                <table class="search-form">
                  <tr>
                    <td class="field-label">Current password:</td>
                    <td>
                      <input
                        type="password"
                        name="current"
                        size={30}
                        required
                        autocomplete="current-password"
                      />
                    </td>
                  </tr>
                  <PasswordRows label="New password:" />
                </table>
                <div class="btn-row">
                  <button class="btn" type="submit">
                    Change Password
                  </button>
                  <a href="/account">Back to My Account</a>
                </div>
              </form>
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
}
