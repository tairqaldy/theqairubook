import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
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
  const token = getCookie(c, "session");
  const userId = decodeSession(token);
  if (!userId) {
    c.set("user", null);
    await next();
    return;
  }
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  c.set("user", user ?? null);
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

export function startSession(c: Context, userId: number) {
  setCookie(c, "session", encodeSession(userId), {
    httpOnly: true,
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    sameSite: "Lax",
    secure: isHttps(c),
  });
}
