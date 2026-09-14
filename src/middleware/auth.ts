import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, type User } from "../db/schema.js";
import { decodeSession } from "../auth/session.js";

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
