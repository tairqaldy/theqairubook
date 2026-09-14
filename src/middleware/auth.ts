import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, type User } from "../db/schema.js";
import { decodeSession, encodeSession } from "../auth/session.js";
import { isHttps } from "../lib/url.js";

export type AppEnv = {
  Variables: {
    user: User | null;
  };
};

export const loadUser = createMiddleware<AppEnv>(async (c, next) => {
  const session = decodeSession(getCookie(c, "session"));
  if (!session) {
    c.set("user", null);
    await next();
    return;
  }
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  // Stale version (password changed / admin reset), not activated or suspended: log out.
  const valid =
    user &&
    user.claimedAt &&
    user.passwordHash &&
    !user.suspendedAt &&
    user.sessionVersion === session.version;
  if (!valid) deleteCookie(c, "session", { path: "/" });
  c.set("user", valid ? user : null);
  await next();
});

export function requireUser(user: User | null): user is User {
  return user !== null;
}

export function needLogin(c: {
  get: (k: "user") => User | null;
  redirect: (u: string) => Response;
}) {
  const user = c.get("user");
  if (!user) return { user: null as never, redirect: c.redirect("/login") };
  return { user, redirect: null as Response | null };
}

export function isAdmin(user: User | null | undefined): boolean {
  return user?.role === "admin";
}

export function startSession(c: Context, user: Pick<User, "id" | "sessionVersion">) {
  setCookie(c, "session", encodeSession(user.id, user.sessionVersion), {
    httpOnly: true,
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    sameSite: "Lax",
    secure: isHttps(c),
  });
}
