import { Hono } from "hono";
import { and, eq, desc, inArray, ilike, or, ne, sql, isNull, isNotNull } from "drizzle-orm";
import type { AppEnv } from "../middleware/auth.js";
import { needLogin } from "../middleware/auth.js";
import {
  Layout,
  LeftNav,
  Box,
  FriendButton,
  InviteCopy,
  NotJoined,
  UserLink,
  formatDate,
} from "../views/layout.js";
import { db } from "../db/index.js";
import { friendships, pokes, users, repEvents, type User } from "../db/schema.js";
import {
  friendIds,
  friendshipStatus,
  friendshipStatuses,
  addBoardEvent,
  friendsOfFriends,
  ensureReferralCode,
} from "../lib/social.js";
import { REP } from "../lib/rep.js";
import { backPath } from "../lib/url.js";
import { withinLimit } from "../lib/security.js";
import { inviteLink, inviteMessage } from "../lib/invite.js";

export const socialRoutes = new Hono<AppEnv>();

const SOCIAL_ERRORS: Record<string, string> = {
  friend_limit: "You've sent a lot of friend requests recently. Try again in a little while.",
  suspended: "That account is suspended, so you can't add it as a friend right now.",
};

/** Escape LIKE wildcards so a search for "_" or "%" is literal. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

/** Same-site path with ?error=<code> set, for friendly refusals after a POST. */
function withError(pathAndQuery: string, code: string): string {
  const url = new URL(pathAndQuery, "http://local");
  url.searchParams.set("error", code);
  return url.pathname + url.search;
}

const hasNative = (u: Pick<User, "name" | "nativeName">) =>
  Boolean(u.nativeName) && u.nativeName !== u.name;

socialRoutes.get("/friends", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const find = (c.req.query("find") ?? "").trim().slice(0, 80);
  const error = SOCIAL_ERRORS[c.req.query("error") ?? ""];

  const ids = await friendIds(user.id);
  const friends = ids.length
    ? await db
        .select()
        .from(users)
        .where(and(inArray(users.id, ids), isNotNull(users.claimedAt)))
        .orderBy(users.name)
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
    )
    .orderBy(desc(friendships.createdAt));

  const pattern = likePattern(find);
  const found = find
    ? await db
        .select()
        .from(users)
        .where(
          and(
            ne(users.id, user.id),
            or(
              ilike(users.name, pattern),
              ilike(users.nativeName, pattern),
              ilike(users.email, pattern)
            )
          )
        )
        // Members first, then classmates who haven't joined yet.
        .orderBy(sql`${users.claimedAt} is null`, desc(users.rep), users.name)
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
        .where(and(inArray(users.id, fofIds), isNotNull(users.claimedAt)))
        .limit(20)
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
            {error ? <p class="error">{error}</p> : null}
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

            <Box title="[ Find People ]" alt>
              <form method="get" action="/friends">
                Find classmates by name or email:{" "}
                <input
                  type="text"
                  name="find"
                  size={28}
                  maxlength={80}
                  value={find}
                  placeholder="e.g. Dias, Диас or dias.b@qairu.edu.kz"
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
                          <UserLink user={u} />
                          <br />
                          <span class="meta">
                            {hasNative(u) ? `${u.nativeName} · ` : ""}
                            {u.claimedAt === null
                              ? "on the QAIRU student list"
                              : `${u.status}${u.classYear ? ` · ${u.classYear}` : ""}`}
                          </span>
                        </td>
                        <td class="actions">
                          <FriendButton
                            userId={u.id}
                            status={foundStatus.get(u.id) ?? "none"}
                          />{" "}
                          {u.claimedAt === null ? (
                            <a href={`/profile/${u.id}#invite`}>invite</a>
                          ) : (
                            <a href={`/messages/with/${u.id}`}>message</a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </table>
                ) : (
                  <p class="meta">
                    Nobody matched "{find}". Everyone on the QAIRU student list
                    already has a spot here — check the spelling, or try their
                    name as written in Cyrillic.
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
                        <UserLink user={f} />
                        <br />
                        <span class="meta">
                          {f.headline || f.status}
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
                {pendingOut.map(({ u }) =>
                  u.claimedAt === null ? (
                    <p>
                      <a href={`/profile/${u.id}`}>{u.name}</a> <NotJoined />{" "}
                      <span class="meta">waiting for them to join ·</span>{" "}
                      <a href={`/profile/${u.id}#invite`}>send an invite</a>{" "}
                      <FriendButton userId={u.id} status="pending_out" />
                    </p>
                  ) : (
                    <p>
                      Waiting for <a href={`/profile/${u.id}`}>{u.name}</a>{" "}
                      <FriendButton userId={u.id} status="pending_out" />
                    </p>
                  )
                )}
              </Box>
            ) : null}

            {fof.length ? (
              <Box title="[ People You May Know ]">
                <table class="bordertable people-table">
                  {fof.map((f) => (
                    <tr>
                      <td>
                        <UserLink user={f} />
                        {f.headline ? (
                          <>
                            <br />
                            <span class="meta">{f.headline}</span>
                          </>
                        ) : null}
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

// Allowed for classmates who haven't joined: the request waits for them.
socialRoutes.post("/friends/request/:id", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const toId = Number(c.req.param("id"));
  const back = backPath(c, `/profile/${toId}`);
  if (!Number.isInteger(toId) || toId === user.id) return c.redirect(back);

  const [target] = await db
    .select({ id: users.id, suspendedAt: users.suspendedAt })
    .from(users)
    .where(eq(users.id, toId))
    .limit(1);
  if (!target) return c.redirect(back);
  if (target.suspendedAt !== null) return c.redirect(withError(back, "suspended"));

  const status = await friendshipStatus(user.id, toId);
  if (status === "none") {
    if (!withinLimit("friendRequestsPerUser", user.id)) {
      return c.redirect(withError(back, "friend_limit"));
    }
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
  if (!Number.isInteger(fromId)) return c.redirect("/friends");
  const [from] = await db
    .select({ suspendedAt: users.suspendedAt })
    .from(users)
    .where(eq(users.id, fromId))
    .limit(1);
  if (from?.suspendedAt) {
    return c.redirect(withError(backPath(c, "/friends"), "suspended"));
  }
  await acceptRequest(user.id, fromId);
  return c.redirect(backPath(c, `/profile/${fromId}`));
});

socialRoutes.post("/friends/ignore/:id", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const fromId = Number(c.req.param("id"));
  if (!Number.isInteger(fromId)) return c.redirect("/friends");
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
  if (!Number.isInteger(otherId)) return c.redirect("/friends");
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
    const [target] = await db
      .select({ id: users.id, claimedAt: users.claimedAt, suspendedAt: users.suspendedAt })
      .from(users)
      .where(eq(users.id, toId))
      .limit(1);
    // Nobody to notice the poke until they've joined.
    if (target && target.claimedAt === null) {
      return c.redirect(`/profile/${toId}#invite`);
    }
    // Suspended accounts can't be poked.
    if (target && target.suspendedAt !== null) {
      return c.redirect(`/profile/${toId}`);
    }
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
  const user = await ensureReferralCode(gate.user);
  const q = (c.req.query("q") ?? "").trim().slice(0, 80);
  const error = SOCIAL_ERRORS[c.req.query("error") ?? ""];

  const link = inviteLink(c, user);
  const message = inviteMessage(user.name, link);

  const referred = await db
    .select()
    .from(users)
    .where(and(eq(users.referredByUserId, user.id), isNotNull(users.claimedAt)))
    .orderBy(desc(users.claimedAt))
    .limit(100);

  const [earned] = await db
    .select({ total: sql<number>`coalesce(sum(${repEvents.amount}), 0)::int` })
    .from(repEvents)
    .where(and(eq(repEvents.userId, user.id), eq(repEvents.reason, "referral")));

  const [network] = await db
    .select({
      joined: sql<number>`count(*) filter (where ${users.claimedAt} is not null)::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(users);

  // Classmates on the student list who haven't activated yet.
  const pattern = likePattern(q);
  const classmates = await db
    .select()
    .from(users)
    .where(
      q
        ? and(
            isNull(users.claimedAt),
            or(ilike(users.name, pattern), ilike(users.nativeName, pattern))
          )
        : isNull(users.claimedAt)
    )
    .orderBy(q ? users.name : sql`random()`)
    .limit(q ? 20 : 10);
  const classmateStatus = await friendshipStatuses(
    user.id,
    classmates.map((u) => u.id)
  );

  const shareBlurb =
    "Join me on theqairubook, the QAIRU student network. Sign up with your @qairu.edu.kz email.";

  return c.html(
    <Layout title="Invite" user={user} banner="Invite Classmates, Earn Rep">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            {error ? <p class="error">{error}</p> : null}
            <Box title="[ Your Personal Invite Link ]" alt>
              <p>
                Send this link to QAIRU classmates. It never expires and works
                for as many people as you like. Everyone who activates their
                account through it becomes your friend automatically, and you
                get <b>+{REP.referral} rep</b> per person.
              </p>
              <InviteCopy id="invite-link" link={link} message={message} />
              <p class="share-row">
                Share:{" "}
                <a
                  href={`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareBlurb)}`}
                  target="_blank"
                  rel="noopener"
                >
                  Telegram
                </a>
                {" · "}
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(message)}`}
                  target="_blank"
                  rel="noopener"
                >
                  WhatsApp
                </a>
                {" · "}
                <a
                  href={`mailto:?subject=${encodeURIComponent("Join me on theqairubook")}&body=${encodeURIComponent(message)}`}
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
                    <div class="meta">activated via your link</div>
                  </td>
                  <td>
                    <div class="stat-num">+{earned?.total ?? 0}</div>
                    <div class="meta">rep earned</div>
                  </td>
                  <td>
                    <div class="stat-num">
                      {network?.joined ?? 0}
                      <span class="stat-of"> / {network?.total ?? 0}</span>
                    </div>
                    <div class="meta">QAIRU students have joined</div>
                  </td>
                </tr>
              </table>
              {referred.length ? (
                <ul class="bullets">
                  {referred.map((u) => (
                    <li>
                      <a href={`/profile/${u.id}`}>{u.name}</a>
                      <span class="meta">
                        {" "}
                        · joined {formatDate(u.claimedAt ?? u.memberSince)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="meta">
                  Nobody has activated through your link yet. Drop it in your
                  group chat!
                </p>
              )}
              <div class="section-label">How it works:</div>
              <ul class="bullets">
                <li>
                  You get <b>+{REP.referral} rep</b> when a classmate{" "}
                  <b>activates</b> their account through your link, and you
                  become friends automatically.
                </li>
                <li>
                  theqairubook is closed: they still need their own
                  @qairu.edu.kz email from the official student list.
                </li>
                <li>
                  Referral rep is capped at {REP.referralDailyCap} people per 24
                  hours to keep things fair.
                </li>
              </ul>
            </Box>

            <div id="classmates">
              <Box title="[ Classmates Who Haven't Joined Yet ]">
                <form method="get" action="/invite#classmates">
                  Find a classmate:{" "}
                  <input
                    type="text"
                    name="q"
                    size={28}
                    maxlength={80}
                    value={q}
                    placeholder="name, in Latin or Cyrillic"
                  />{" "}
                  <button class="btn btn-small" type="submit">
                    Search
                  </button>
                  {q ? (
                    <>
                      {" "}
                      <a href="/invite#classmates">clear</a>
                    </>
                  ) : null}
                </form>
                {!q && classmates.length ? (
                  <p class="meta">A few random classmates who aren't here yet:</p>
                ) : null}
                {classmates.length ? (
                  <table class="bordertable people-table invite-rows">
                    {classmates.map((u) => {
                      const targeted = inviteLink(c, user, u);
                      return (
                        <tr>
                          <td>
                            <a href={`/profile/${u.id}`}>
                              <b>{u.name}</b>
                            </a>{" "}
                            <NotJoined />
                            {hasNative(u) ? (
                              <div class="meta">{u.nativeName}</div>
                            ) : null}
                            <details class="invite-details">
                              <summary>copy invite</summary>
                              <InviteCopy
                                id={`invite-for-${u.id}`}
                                link={targeted}
                                message={inviteMessage(user.name, targeted, u.name)}
                              />
                            </details>
                          </td>
                          <td class="actions">
                            <FriendButton
                              userId={u.id}
                              status={classmateStatus.get(u.id) ?? "none"}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </table>
                ) : (
                  <p class="meta">
                    {q
                      ? `No classmate who hasn't joined matches "${q}".`
                      : "Everyone on the QAIRU student list has joined. Wow!"}
                  </p>
                )}
              </Box>
            </div>

          </td>
        </tr>
      </table>
    </Layout>
  );
});
