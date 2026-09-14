import { Hono } from "hono";
import { and, eq, desc, inArray, ilike, or, ne, sql } from "drizzle-orm";
import type { AppEnv } from "../middleware/auth.js";
import { needLogin } from "../middleware/auth.js";
import {
  Layout,
  LeftNav,
  Box,
  FriendButton,
  formatDate,
} from "../views/layout.js";
import { db } from "../db/index.js";
import { friendships, pokes, users, invites, repEvents } from "../db/schema.js";
import {
  friendIds,
  friendshipStatus,
  friendshipStatuses,
  addBoardEvent,
  friendsOfFriends,
  makeReferralCode,
} from "../lib/social.js";
import { REP } from "../lib/rep.js";
import { publicOrigin, backPath } from "../lib/url.js";

export const socialRoutes = new Hono<AppEnv>();

socialRoutes.get("/friends", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const find = (c.req.query("find") ?? "").trim();

  const ids = await friendIds(user.id);
  const friends = ids.length
    ? await db.select().from(users).where(inArray(users.id, ids)).orderBy(users.name)
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

  const found = find
    ? await db
        .select()
        .from(users)
        .where(
          and(
            ne(users.id, user.id),
            or(ilike(users.name, `%${find}%`), ilike(users.email, `%${find}%`))
          )
        )
        .orderBy(desc(users.rep))
        .limit(20)
    : [];
  const foundStatus = await friendshipStatuses(
    user.id,
    found.map((u) => u.id)
  );

  const fofIds = await friendsOfFriends(user.id);
  const fof = fofIds.length
    ? await db
        .select()
        .from(users)
        .where(inArray(users.id, fofIds.slice(0, 20)))
    : [];
  const fofStatus = await friendshipStatuses(
    user.id,
    fof.map((u) => u.id)
  );

  return c.html(
    <Layout title="Friends" user={user} banner="My Friends">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            {pendingIn.length ? (
              <Box title={`[ Friend Requests (${pendingIn.length}) ]`}>
                {pendingIn.map(({ u }) => (
                  <p>
                    <a href={`/profile/${u.id}`}>{u.name}</a> wants to be your
                    friend.{" "}
                    <form
                      method="post"
                      action={`/friends/accept/${u.id}`}
                      class="inline-form"
                    >
                      <button class="btn btn-small" type="submit">
                        Confirm
                      </button>
                    </form>{" "}
                    <form
                      method="post"
                      action={`/friends/ignore/${u.id}`}
                      class="inline-form"
                    >
                      <button class="btn btn-small btn-gray" type="submit">
                        Ignore
                      </button>
                    </form>
                  </p>
                ))}
              </Box>
            ) : null}

            <Box title="[ Add a Friend ]" alt>
              <form method="get" action="/friends">
                Find people by name or email:{" "}
                <input
                  type="text"
                  name="find"
                  size={28}
                  value={find}
                  placeholder="e.g. Dias or dias.b@qairu.edu.kz"
                />{" "}
                <button class="btn btn-small" type="submit">
                  Find
                </button>
              </form>
              {find ? (
                found.length ? (
                  <table class="bordertable people-table" style="margin-top:8px">
                    {found.map((u) => (
                      <tr>
                        <td>
                          <a href={`/profile/${u.id}`}>{u.name}</a>
                          <span class="rep-chip">{u.rep}</span>
                          <br />
                          <span class="meta">
                            {u.status}
                            {u.classYear ? ` · ${u.classYear}` : ""}
                          </span>
                        </td>
                        <td class="actions">
                          <FriendButton
                            userId={u.id}
                            status={foundStatus.get(u.id) ?? "none"}
                          />{" "}
                          <a href={`/messages/with/${u.id}`}>message</a>
                        </td>
                      </tr>
                    ))}
                  </table>
                ) : (
                  <p class="meta">
                    Nobody matched "{find}". Not on theqairubook yet?{" "}
                    <a href="/invite">Send them your invite link</a>.
                  </p>
                )
              ) : null}
            </Box>

            <Box title={`[ Friends (${friends.length}) ]`}>
              {friends.length ? (
                <table class="bordertable people-table">
                  {friends.map((f) => (
                    <tr>
                      <td>
                        <a href={`/profile/${f.id}`}>{f.name}</a>
                        <span class="rep-chip">{f.rep}</span>
                        <br />
                        <span class="meta">
                          {f.status}
                          {f.residence ? ` · ${f.residence}` : ""}
                        </span>
                      </td>
                      <td class="actions">
                        <a href={`/messages/with/${f.id}`}>message</a>
                        {" · "}
                        <form
                          method="post"
                          action={`/friends/remove/${f.id}`}
                          class="inline-form"
                          data-confirm={`Remove ${f.name} from your friends?`}
                        >
                          <button class="btn-link" type="submit">
                            unfriend
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </table>
              ) : (
                <p class="meta">
                  No friends yet. Use the box above to find classmates!
                </p>
              )}
            </Box>

            {pendingOut.length ? (
              <Box title="[ Requests You Sent ]">
                {pendingOut.map(({ u }) => (
                  <p>
                    Waiting for <a href={`/profile/${u.id}`}>{u.name}</a>{" "}
                    <FriendButton userId={u.id} status="pending_out" />
                  </p>
                ))}
              </Box>
            ) : null}

            {fof.length ? (
              <Box title="[ People You May Know ]">
                <table class="bordertable people-table">
                  {fof.map((f) => (
                    <tr>
                      <td>
                        <a href={`/profile/${f.id}`}>{f.name}</a>
                        <span class="rep-chip">{f.rep}</span>
                      </td>
                      <td class="actions">
                        <FriendButton
                          userId={f.id}
                          status={fofStatus.get(f.id) ?? "none"}
                        />
                      </td>
                    </tr>
                  ))}
                </table>
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
  const back = backPath(c, `/profile/${toId}`);
  if (!Number.isInteger(toId) || toId === user.id) return c.redirect(back);

  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, toId)).limit(1);
  if (!target) return c.redirect(back);

  const status = await friendshipStatus(user.id, toId);
  if (status === "none") {
    await db
      .insert(friendships)
      .values({ fromUserId: user.id, toUserId: toId, status: "pending" })
      .onConflictDoNothing();
  } else if (status === "pending_in") {
    await acceptRequest(user.id, toId);
  }
  return c.redirect(back);
});

async function acceptRequest(me: number, fromId: number) {
  const updated = await db
    .update(friendships)
    .set({ status: "accepted" })
    .where(
      and(
        eq(friendships.fromUserId, fromId),
        eq(friendships.toUserId, me),
        eq(friendships.status, "pending")
      )
    )
    .returning({ id: friendships.id });
  if (updated.length) await addBoardEvent(me, "friend", "became friends", fromId);
}

socialRoutes.post("/friends/accept/:id", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const fromId = Number(c.req.param("id"));
  await acceptRequest(user.id, fromId);
  return c.redirect(backPath(c, `/profile/${fromId}`));
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
  return c.redirect(backPath(c, "/friends"));
});

// Unfriend, or cancel a request you sent.
socialRoutes.post("/friends/remove/:id", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const otherId = Number(c.req.param("id"));
  await db
    .delete(friendships)
    .where(
      or(
        and(eq(friendships.fromUserId, user.id), eq(friendships.toUserId, otherId)),
        and(
          eq(friendships.fromUserId, otherId),
          eq(friendships.toUserId, user.id),
          eq(friendships.status, "accepted")
        )
      )
    );
  return c.redirect(backPath(c, "/friends"));
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
                      class="inline-form"
                    >
                      <button class="btn btn-small" type="submit">
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
  if (Number.isInteger(toId) && toId !== user.id) {
    const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, toId)).limit(1);
    if (target) {
      await db.insert(pokes).values({
        fromUserId: user.id,
        toUserId: toId,
      });
      await addBoardEvent(user.id, "poke", "poked", toId);
    }
  }
  return c.redirect(backPath(c, `/profile/${toId}`));
});

socialRoutes.get("/invite", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  let user = gate.user;

  if (!user.referralCode) {
    [user] = await db
      .update(users)
      .set({ referralCode: makeReferralCode(user.name) })
      .where(eq(users.id, user.id))
      .returning();
  }

  const origin = publicOrigin(c);
  const link = `${origin}/r/${user.referralCode}`;

  const referred = await db
    .select()
    .from(users)
    .where(eq(users.referredByUserId, user.id))
    .orderBy(desc(users.memberSince))
    .limit(100);

  const [earned] = await db
    .select({ total: sql<number>`coalesce(sum(${repEvents.amount}), 0)::int` })
    .from(repEvents)
    .where(and(eq(repEvents.userId, user.id), eq(repEvents.reason, "referral")));

  const legacy = await db
    .select()
    .from(invites)
    .where(eq(invites.fromUserId, user.id))
    .orderBy(desc(invites.createdAt))
    .limit(20);
  const unusedLegacy = legacy.filter((i) => !i.usedByUserId);

  const shareText = `Join me on theqairubook — the QAIRU college directory: ${link}`;

  return c.html(
    <Layout title="Invite" user={user} banner="Invite Friends, Earn Rep">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title="[ Your Personal Invite Link ]" alt>
              <p>
                Send this link to QAIRU classmates. It never expires and works
                for as many people as you like. Everyone who joins through it
                becomes your friend automatically, and you get{" "}
                <b>+{REP.referral} rep</b> per person.
              </p>
              <div class="invite-link-row">
                <input
                  type="text"
                  readonly
                  id="invite-link"
                  class="invite-link"
                  value={link}
                  data-select-on-click
                />
                <button class="btn" type="button" data-copy="#invite-link">
                  Copy
                </button>
              </div>
              <p class="share-row">
                Share:{" "}
                <a
                  href={`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Join me on theqairubook — the QAIRU college directory")}`}
                  target="_blank"
                  rel="noopener"
                >
                  Telegram
                </a>
                {" · "}
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
                  target="_blank"
                  rel="noopener"
                >
                  WhatsApp
                </a>
                {" · "}
                <a
                  href={`mailto:?subject=${encodeURIComponent("Join me on theqairubook")}&body=${encodeURIComponent(shareText)}`}
                >
                  Email
                </a>
              </p>
            </Box>

            <Box title="[ Your Referrals ]">
              <table class="stat-row">
                <tr>
                  <td>
                    <div class="stat-num">{referred.length}</div>
                    <div class="meta">people joined</div>
                  </td>
                  <td>
                    <div class="stat-num">+{earned?.total ?? 0}</div>
                    <div class="meta">rep earned</div>
                  </td>
                  <td>
                    <div class="stat-num">{user.rep}</div>
                    <div class="meta">
                      total rep · <a href="/rep">leaderboard</a>
                    </div>
                  </td>
                </tr>
              </table>
              {referred.length ? (
                <ul class="bullets">
                  {referred.map((u) => (
                    <li>
                      <a href={`/profile/${u.id}`}>{u.name}</a>
                      <span class="meta"> · joined {formatDate(u.memberSince)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="meta">
                  Nobody has joined through your link yet. Drop it in your
                  group chat!
                </p>
              )}
              <p class="meta">
                Referral rep is capped at {REP.referralDailyCap} people per 24
                hours to keep things fair.
              </p>
            </Box>

            {unusedLegacy.length ? (
              <Box title="[ Older One-Time Links ]">
                <p class="meta">
                  These single-use links you made earlier still work (once
                  each). Your personal link above is better.
                </p>
                {unusedLegacy.map((i) => (
                  <p>
                    <input
                      type="text"
                      readonly
                      size={52}
                      value={`${origin}/join/${i.token}`}
                      data-select-on-click
                    />
                    {i.email ? <span class="meta"> · {i.email}</span> : null}
                  </p>
                ))}
              </Box>
            ) : null}
          </td>
        </tr>
      </table>
    </Layout>
  );
});
