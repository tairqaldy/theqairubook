import { Hono } from "hono";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { AppEnv } from "../middleware/auth.js";
import { needLogin } from "../middleware/auth.js";
import {
  Layout,
  LeftNav,
  Box,
  FriendButton,
  InviteCopy,
  Linkified,
  NotJoined,
  DISPLAY_TZ,
  dayKey,
  formatDate,
  timeAgo,
} from "../views/layout.js";
import { db } from "../db/index.js";
import { messages, users, type User } from "../db/schema.js";
import { friendIds, friendshipStatus } from "../lib/social.js";
import { withinLimit } from "../lib/security.js";
import { inviteLink, inviteMessage } from "../lib/invite.js";

export const messageRoutes = new Hono<AppEnv>();

type Msg = typeof messages.$inferSelect;

function between(a: number, b: number) {
  return or(
    and(eq(messages.fromUserId, a), eq(messages.toUserId, b)),
    and(eq(messages.fromUserId, b), eq(messages.toUserId, a))
  );
}

function clockTime(d: Date): string {
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: DISPLAY_TZ,
  });
  return dayKey(new Date()) === dayKey(d)
    ? time
    : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: DISPLAY_TZ })}, ${time}`;
}

const Bubble = ({ msg, me }: { msg: Msg; me: number }) => (
  <div class={msg.fromUserId === me ? "bubble-row mine" : "bubble-row theirs"} data-id={msg.id}>
    <div class="bubble">
      {msg.subject && msg.subject !== "(no subject)" ? (
        <div class="bubble-subject">{msg.subject}</div>
      ) : null}
      <Linkified text={msg.body} />
      <div class="bubble-time">
        {clockTime(msg.createdAt)}
        {msg.fromUserId === me && msg.read ? " · seen" : ""}
      </div>
    </div>
  </div>
);

messageRoutes.get("/messages", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;

  // Latest message per conversation partner, plus unread counts.
  const convos = await db.execute<{
    other_id: number;
    body: string;
    from_user_id: number;
    created_at: Date;
    unread: number;
  }>(sql`
    select distinct on (other_id) other_id, body, from_user_id, created_at,
      (select count(*)::int from messages u
        where u.from_user_id = t.other_id and u.to_user_id = ${user.id} and u.read = false) as unread
    from (
      select m.*, case when m.from_user_id = ${user.id} then m.to_user_id else m.from_user_id end as other_id
      from messages m
      where m.from_user_id = ${user.id} or m.to_user_id = ${user.id}
    ) t
    order by other_id, id desc
  `);
  const list = [...convos].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  const people = list.length
    ? await db.select().from(users).where(inArray(users.id, list.map((r) => Number(r.other_id))))
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));

  return c.html(
    <Layout title="Messages" user={user} banner="My Messages">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <div class="listing-head">
              <span class="meta">Chat with anyone at QAIRU.</span>
              <a class="btn" href="/messages/compose">
                + New Message
              </a>
            </div>
            <Box title="[ Conversations ]" alt>
              {list.length ? (
                <div class="convo-list">
                  {list.map((r) => {
                    const other = byId.get(Number(r.other_id));
                    if (!other) return null;
                    const unread = Number(r.unread);
                    return (
                      <a href={`/messages/with/${other.id}`} class={unread ? "convo unread" : "convo"}>
                        <span class="convo-name">
                          {other.name}
                          {unread ? <span class="badge">{unread}</span> : null}
                        </span>
                        <span class="convo-time meta">{timeAgo(new Date(r.created_at))}</span>
                        <span class="convo-snippet">
                          {Number(r.from_user_id) === user.id ? "You: " : ""}
                          {r.body.length > 90 ? `${r.body.slice(0, 90)}…` : r.body}
                        </span>
                      </a>
                    );
                  })}
                </div>
              ) : (
                <p class="meta">
                  No conversations yet. Open someone's profile and hit{" "}
                  <b>Message</b>, or <a href="/messages/compose">start one here</a>.
                </p>
              )}
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
});

messageRoutes.get("/messages/compose", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const to = Number(c.req.query("to") ?? 0);
  if (to && to !== user.id) return c.redirect(`/messages/with/${to}`);

  const fids = await friendIds(user.id);
  const friends = fids.length
    ? await db
        .select()
        .from(users)
        .where(
          and(inArray(users.id, fids), isNotNull(users.claimedAt), isNull(users.suspendedAt))
        )
        .orderBy(users.name)
    : [];
  // Only activated, non-suspended accounts can receive messages.
  const others = await db
    .select()
    .from(users)
    .where(and(ne(users.id, user.id), isNotNull(users.claimedAt), isNull(users.suspendedAt)))
    .orderBy(users.name)
    .limit(500);

  return c.html(
    <Layout title="New Message" user={user} banner="New Message">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title="[ New Message ]" alt>
              <form method="post" action="/messages/compose">
                <table class="search-form wide-form">
                  <tr>
                    <td class="field-label">To:</td>
                    <td>
                      <select name="toUserId" required>
                        <option value="">Select…</option>
                        {friends.length ? (
                          <optgroup label="Friends">
                            {friends.map((u) => (
                              <option value={u.id}>{u.name}</option>
                            ))}
                          </optgroup>
                        ) : null}
                        <optgroup label="Everyone at QAIRU">
                          {others
                            .filter((u) => !fids.includes(u.id))
                            .map((u) => (
                              <option value={u.id}>{u.name}</option>
                            ))}
                        </optgroup>
                      </select>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Message:</td>
                    <td>
                      <textarea name="body" rows={5} required maxlength={5000} />
                    </td>
                  </tr>
                </table>
                <div class="btn-row">
                  <button class="btn" type="submit">
                    Send
                  </button>
                </div>
              </form>
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
});

type SendError = "invalid" | "not_found" | "not_joined" | "suspended" | "rate_limited";
type SendResult = { ok: true; msg: Msg } | { ok: false; error: SendError };

const SEND_STATUS: Record<SendError, 400 | 403 | 404 | 429> = {
  invalid: 400,
  not_found: 404,
  not_joined: 403,
  suspended: 403,
  rate_limited: 429,
};

const SEND_ERROR_TEXT: Partial<Record<string, string>> = {
  rate_limited: "You're sending messages too fast. Take a breather and try again in a bit.",
  invalid: "Your message was empty.",
};

const SUSPENDED_TEXT = "This account is currently unavailable, so it can't receive messages.";

async function sendMessage(from: User, toUserId: number, body: string): Promise<SendResult> {
  const text = body.trim();
  if (!text || !Number.isInteger(toUserId) || toUserId < 1 || toUserId > 2147483647 || toUserId === from.id) {
    return { ok: false, error: "invalid" };
  }
  const [to] = await db
    .select({ id: users.id, claimedAt: users.claimedAt, suspendedAt: users.suspendedAt })
    .from(users)
    .where(eq(users.id, toUserId))
    .limit(1);
  if (!to) return { ok: false, error: "not_found" };
  if (to.claimedAt === null) return { ok: false, error: "not_joined" };
  if (to.suspendedAt !== null) return { ok: false, error: "suspended" };
  if (!withinLimit("messagesPerUser", from.id)) return { ok: false, error: "rate_limited" };
  const [msg] = await db
    .insert(messages)
    .values({ fromUserId: from.id, toUserId, body: text.slice(0, 5000) })
    .returning();
  return { ok: true, msg };
}

messageRoutes.post("/messages/compose", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const body = await c.req.parseBody();
  const toUserId = Number(body.toUserId);
  const result = await sendMessage(gate.user, toUserId, String(body.body ?? ""));
  if (result.ok) return c.redirect(`/messages/with/${toUserId}#bottom`);
  if (result.error === "invalid" || result.error === "not_found") {
    return c.redirect("/messages/compose");
  }
  // not_joined shows the invite page; suspended and rate_limited show a notice on the thread.
  return c.redirect(
    `/messages/with/${toUserId}${result.error === "rate_limited" ? "?error=rate_limited" : ""}`
  );
});

messageRoutes.get("/messages/with/:id{[0-9]+}", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const otherId = Number(c.req.param("id"));
  if (otherId === user.id) return c.redirect("/messages");
  const [other] = await db.select().from(users).where(eq(users.id, otherId)).limit(1);
  if (!other) return c.notFound();

  const first = other.name.split(" ")[0];

  // Pre-created account from the student list: no chat until they activate.
  if (other.claimedAt === null) {
    const link = inviteLink(c, user, other);
    const status = await friendshipStatus(user.id, other.id);
    return c.html(
      <Layout title={`Chat with ${other.name}`} user={user} banner="My Messages">
        <table class="layout-table">
          <tr>
            <td class="sidebar">
              <LeftNav user={user} />
            </td>
            <td class="maincol">
              <Box title={`[ ${other.name} ]`} alt>
                <p>
                  <a href={`/profile/${other.id}`}>{other.name}</a> <NotJoined />
                </p>
                <p>
                  <b>{first}</b> hasn't joined theqairubook yet — messages open once they
                  activate their account.
                </p>
                <p class="meta">
                  Send {first} your invite link (Telegram, WhatsApp, email…). When they
                  activate with their @qairu.edu.kz email you'll be friends automatically.
                </p>
                <InviteCopy
                  id="invite-target"
                  link={link}
                  message={inviteMessage(user.name, link, other.name)}
                />
                <p>
                  <FriendButton userId={other.id} status={status} />{" "}
                  <a href="/messages">‹ back to messages</a>
                </p>
              </Box>
            </td>
          </tr>
        </table>
      </Layout>
    );
  }

  const errorText = SEND_ERROR_TEXT[c.req.query("error") ?? ""];

  const recent = await db
    .select()
    .from(messages)
    .where(between(user.id, otherId))
    .orderBy(desc(messages.id))
    .limit(200);
  const thread = recent.reverse();

  await db
    .update(messages)
    .set({ read: true })
    .where(
      and(eq(messages.fromUserId, otherId), eq(messages.toUserId, user.id), eq(messages.read, false))
    );

  const lastId = thread.at(-1)?.id ?? 0;

  return c.html(
    <Layout title={`Chat with ${other.name}`} user={user} banner="My Messages">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <div class="box chat-box">
              <div class="box-title-alt chat-head">
                <a href="/messages">‹ all</a>
                <span>
                  <a href={`/profile/${other.id}`}>{other.name}</a>
                  <span class="rep-chip">{other.rep}</span>
                </span>
                <span class="meta">{other.status}</span>
              </div>
              <div
                class="chat-scroll"
                id="chat"
                data-poll={`/messages/with/${other.id}/since`}
                data-last-id={lastId}
              >
                {thread.length ? (
                  thread.map((m, i) => {
                    const prev = thread[i - 1];
                    const newDay = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt);
                    return (
                      <>
                        {newDay ? <div class="day-sep">{formatDate(m.createdAt)}</div> : null}
                        <Bubble msg={m} me={user.id} />
                      </>
                    );
                  })
                ) : (
                  <p class="meta chat-empty">
                    Say hi to {first}! Messages are private between you two.
                  </p>
                )}
                <div id="bottom"></div>
              </div>
              {other.suspendedAt !== null ? (
                <p class="meta chat-error">{SUSPENDED_TEXT}</p>
              ) : (
                <>
              {errorText ? <p class="error chat-error">{errorText}</p> : null}
              <form
                method="post"
                action={`/messages/with/${other.id}`}
                class="chat-form"
                id="chat-form"
              >
                <textarea
                  name="body"
                  rows={2}
                  required
                  maxlength={5000}
                  placeholder={`Message ${first}… (Enter to send, Shift+Enter for new line)`}
                  autofocus
                />
                <button class="btn" type="submit">
                  Send
                </button>
              </form>
                </>
              )}
            </div>
          </td>
        </tr>
      </table>
    </Layout>
  );
});

messageRoutes.post("/messages/with/:id{[0-9]+}", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const otherId = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const result = await sendMessage(gate.user, otherId, String(body.body ?? ""));
  if (c.req.header("accept")?.includes("application/json")) {
    return result.ok
      ? c.json({ ok: true })
      : c.json({ ok: false, error: result.error }, SEND_STATUS[result.error]);
  }
  if (!result.ok && result.error === "rate_limited") {
    return c.redirect(`/messages/with/${otherId}?error=rate_limited`);
  }
  return c.redirect(`/messages/with/${otherId}#bottom`);
});

// Polled by app.js: returns bubbles newer than ?after= as an HTML fragment.
messageRoutes.get("/messages/with/:id{[0-9]+}/since", async (c) => {
  const user = c.get("user");
  if (!user) return c.text("", 401);
  const otherId = Number(c.req.param("id"));
  const after = Number(c.req.query("after") ?? 0) || 0;

  const fresh = await db
    .select()
    .from(messages)
    .where(and(between(user.id, otherId), gt(messages.id, after)))
    .orderBy(asc(messages.id))
    .limit(100);
  if (fresh.some((m) => m.toUserId === user.id && !m.read)) {
    await db
      .update(messages)
      .set({ read: true })
      .where(
        and(eq(messages.fromUserId, otherId), eq(messages.toUserId, user.id), eq(messages.read, false))
      );
  }
  c.header("x-last-id", String(fresh.at(-1)?.id ?? after));
  return c.html(
    <>
      {fresh.map((m) => (
        <Bubble msg={m} me={user.id} />
      ))}
    </>
  );
});

// Old email-style links (/messages/123) open the conversation instead.
messageRoutes.get("/messages/:id{[0-9]+}", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const [msg] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, Number(c.req.param("id"))))
    .limit(1);
  if (!msg || (msg.toUserId !== user.id && msg.fromUserId !== user.id)) return c.notFound();
  const other = msg.fromUserId === user.id ? msg.toUserId : msg.fromUserId;
  return c.redirect(`/messages/with/${other}#bottom`);
});
