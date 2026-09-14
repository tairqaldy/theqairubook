import { Hono } from "hono";
import { and, eq, desc, inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { AppEnv } from "../middleware/auth.js";
import { Layout, LeftNav, Box, formatDate } from "../views/layout.js";
import { db } from "../db/index.js";
import { friendships, pokes, users, invites, type User } from "../db/schema.js";
import {
  friendIds,
  friendshipStatus,
  addBoardEvent,
  friendsOfFriends,
} from "../lib/social.js";

export const socialRoutes = new Hono<AppEnv>();

function needLogin(c: {
  get: (k: "user") => User | null;
  redirect: (u: string) => Response;
}) {
  const user = c.get("user");
  if (!user) return { user: null as never, redirect: c.redirect("/login") };
  return { user, redirect: null as Response | null };
}

socialRoutes.get("/friends", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;

  const ids = await friendIds(user.id);
  const friends = ids.length
    ? await db.select().from(users).where(inArray(users.id, ids))
    : [];

  const pendingIn = await db
    .select({ f: friendships, u: users })
    .from(friendships)
    .innerJoin(users, eq(friendships.fromUserId, users.id))
    .where(
      and(eq(friendships.toUserId, user.id), eq(friendships.status, "pending"))
    );

  const pendingOut = await db
    .select({ f: friendships, u: users })
    .from(friendships)
    .innerJoin(users, eq(friendships.toUserId, users.id))
    .where(
      and(eq(friendships.fromUserId, user.id), eq(friendships.status, "pending"))
    );

  const fofIds = await friendsOfFriends(user.id);
  const fof = fofIds.length
    ? await db
        .select()
        .from(users)
        .where(inArray(users.id, fofIds.slice(0, 20)))
    : [];

  return c.html(
    <Layout title="Friends" user={user} banner="My Friends">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            {pendingIn.length ? (
              <Box title="[ Friend Requests ]">
                {pendingIn.map(({ u }) => (
                  <p>
                    <a href={`/profile/${u.id}`}>{u.name}</a> wants to be your
                    friend.{" "}
                    <form
                      method="post"
                      action={`/friends/accept/${u.id}`}
                      style="display:inline"
                    >
                      <button class="btn" type="submit">
                        Confirm
                      </button>
                    </form>{" "}
                    <form
                      method="post"
                      action={`/friends/ignore/${u.id}`}
                      style="display:inline"
                    >
                      <button class="btn" type="submit">
                        Ignore
                      </button>
                    </form>
                  </p>
                ))}
              </Box>
            ) : null}

            <Box title={`[ Friends (${friends.length}) ]`} alt>
              {friends.length ? (
                <ul class="bullets">
                  {friends.map((f) => (
                    <li>
                      <a href={`/profile/${f.id}`}>{f.name}</a>
                      {f.status ? ` · ${f.status}` : ""}
                      {f.residence ? ` · ${f.residence}` : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="meta">No friends yet. Try searching for classmates!</p>
              )}
            </Box>

            {pendingOut.length ? (
              <Box title="[ Requests You Sent ]">
                {pendingOut.map(({ u }) => (
                  <p>
                    Waiting for <a href={`/profile/${u.id}`}>{u.name}</a>
                  </p>
                ))}
              </Box>
            ) : null}

            {fof.length ? (
              <Box title="[ Friends of Friends ]">
                <ul class="bullets">
                  {fof.map((f) => (
                    <li>
                      <a href={`/profile/${f.id}`}>{f.name}</a>
                    </li>
                  ))}
                </ul>
              </Box>
            ) : null}
          </td>
        </tr>
      </table>
    </Layout>
  );
});

socialRoutes.post("/friends/request/:id", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const toId = Number(c.req.param("id"));
  if (toId === user.id) return c.redirect(`/profile/${toId}`);

  const status = await friendshipStatus(user.id, toId);
  if (status === "none") {
    await db.insert(friendships).values({
      fromUserId: user.id,
      toUserId: toId,
      status: "pending",
    });
  } else if (status === "pending_in") {
    await db
      .update(friendships)
      .set({ status: "accepted" })
      .where(
        and(
          eq(friendships.fromUserId, toId),
          eq(friendships.toUserId, user.id),
          eq(friendships.status, "pending")
        )
      );
    await addBoardEvent(user.id, "friend", "became friends", toId);
  }
  return c.redirect(`/profile/${toId}`);
});

socialRoutes.post("/friends/accept/:id", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const fromId = Number(c.req.param("id"));
  await db
    .update(friendships)
    .set({ status: "accepted" })
    .where(
      and(
        eq(friendships.fromUserId, fromId),
        eq(friendships.toUserId, user.id),
        eq(friendships.status, "pending")
      )
    );
  await addBoardEvent(user.id, "friend", "became friends", fromId);
  const back = c.req.header("referer")?.includes("/friends")
    ? "/friends"
    : `/profile/${fromId}`;
  return c.redirect(back);
});

socialRoutes.post("/friends/ignore/:id", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const fromId = Number(c.req.param("id"));
  await db
    .delete(friendships)
    .where(
      and(
        eq(friendships.fromUserId, fromId),
        eq(friendships.toUserId, user.id),
        eq(friendships.status, "pending")
      )
    );
  return c.redirect("/friends");
});

socialRoutes.get("/pokes", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;

  const rows = await db
    .select({ poke: pokes, from: users })
    .from(pokes)
    .innerJoin(users, eq(pokes.fromUserId, users.id))
    .where(eq(pokes.toUserId, user.id))
    .orderBy(desc(pokes.createdAt))
    .limit(50);

  await db
    .update(pokes)
    .set({ seen: true })
    .where(and(eq(pokes.toUserId, user.id), eq(pokes.seen, false)));

  return c.html(
    <Layout title="Pokes" user={user} banner="Pokes">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title="[ Pokes ]" alt>
              {rows.length ? (
                rows.map(({ poke, from }) => (
                  <p>
                    <a href={`/profile/${from.id}`}>{from.name}</a> poked you
                    <span class="meta"> · {formatDate(poke.createdAt)}</span>
                    {" · "}
                    <form
                      method="post"
                      action={`/poke/${from.id}`}
                      style="display:inline"
                    >
                      <button class="btn" type="submit">
                        Poke Back
                      </button>
                    </form>
                  </p>
                ))
              ) : (
                <p class="meta">No pokes yet.</p>
              )}
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
});

socialRoutes.post("/poke/:id", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const toId = Number(c.req.param("id"));
  if (toId !== user.id) {
    await db.insert(pokes).values({
      fromUserId: user.id,
      toUserId: toId,
    });
    await addBoardEvent(user.id, "poke", "poked", toId);
  }
  const referer = c.req.header("referer") ?? `/profile/${toId}`;
  try {
    const url = new URL(referer);
    return c.redirect(url.pathname + url.search);
  } catch {
    return c.redirect(`/profile/${toId}`);
  }
});

function inviteUrl(c: { req: { url: string } }, token: string): string {
  const origin = new URL(c.req.url).origin;
  return `${origin}/join/${token}`;
}

socialRoutes.get("/invite", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const notice = c.req.query("ok");

  const mine = await db
    .select()
    .from(invites)
    .where(eq(invites.fromUserId, user.id))
    .orderBy(desc(invites.createdAt))
    .limit(20);

  const usedIds = mine.filter((i) => i.usedByUserId).map((i) => i.usedByUserId as number);
  const joinedUsers = usedIds.length
    ? await db.select().from(users).where(inArray(users.id, usedIds))
    : [];
  const nameById = new Map(joinedUsers.map((u) => [u.id, u.name]));

  return c.html(
    <Layout title="Invite" user={user} banner="Invite Friends">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title="[ Invite a Friend ]" alt>
              {notice ? (
                <p class="notice">
                  New invite link created — copy it and send it to your friend
                  below.
                </p>
              ) : null}
              <p>
                Generate a personal invite link. Anyone who opens it can join
                theqairubook and register directly — no{" "}
                <code>@qairu.edu.kz</code> email required for invited friends.
              </p>
              <form method="post" action="/invite">
                <table class="search-form">
                  <tr>
                    <td class="field-label">Label (optional):</td>
                    <td>
                      <input
                        type="text"
                        name="email"
                        size={35}
                        placeholder="e.g. friend's email or name"
                      />
                    </td>
                  </tr>
                </table>
                <div class="btn-row">
                  <button class="btn" type="submit">
                    Get Invite Link
                  </button>
                </div>
              </form>
            </Box>

            <Box title={`[ Your Invite Links (${mine.length}) ]`}>
              {mine.length ? (
                <table class="search-form">
                  {mine.map((i) => (
                    <tr>
                      <td style="padding:4px 0">
                        {i.usedByUserId ? (
                          <span class="meta">
                            Joined as{" "}
                            <a href={`/profile/${i.usedByUserId}`}>
                              {nameById.get(i.usedByUserId) ?? "a member"}
                            </a>
                          </span>
                        ) : (
                          <input
                            type="text"
                            readonly
                            size={45}
                            value={inviteUrl(c, i.token)}
                            onclick="this.select()"
                          />
                        )}
                        {i.email ? (
                          <span class="meta"> · {i.email}</span>
                        ) : null}
                        <span class="meta"> · {formatDate(i.createdAt)}</span>
                      </td>
                    </tr>
                  ))}
                </table>
              ) : (
                <p class="meta">No invite links yet.</p>
              )}
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
});

socialRoutes.post("/invite", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const body = await c.req.parseBody();
  const email = String(body.email ?? "").trim().toLowerCase();
  const token = randomBytes(16).toString("hex");
  await db.insert(invites).values({ fromUserId: user.id, email, token });
  return c.redirect("/invite?ok=1");
});
