import { Hono } from "hono";
import { and, asc, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import type { AppEnv } from "../middleware/auth.js";
import { needLogin } from "../middleware/auth.js";
import {
  Layout,
  LeftNav,
  Box,
  Linkified,
  DISPLAY_TZ,
  dayKey,
  formatDate,
  timeAgo,
} from "../views/layout.js";
import { db } from "../db/index.js";
import { messages, users, type User } from "../db/schema.js";
import { friendIds } from "../lib/social.js";

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
    ? await db.select().from(users).where(inArray(users.id, fids)).orderBy(users.name)
    : [];
  const others = await db
    .select()
    .from(users)
    .where(ne(users.id, user.id))
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

async function sendMessage(from: User, toUserId: number, body: string) {
  const text = body.trim();
  if (!text || !Number.isInteger(toUserId) || toUserId === from.id) return null;
  const [to] = await db.select({ id: users.id }).from(users).where(eq(users.id, toUserId)).limit(1);
  if (!to) return null;
  const [msg] = await db
    .insert(messages)
    .values({ fromUserId: from.id, toUserId, body: text.slice(0, 5000) })
    .returning();
  return msg;
}

messageRoutes.post("/messages/compose", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const body = await c.req.parseBody();
  const toUserId = Number(body.toUserId);
  const msg = await sendMessage(gate.user, toUserId, String(body.body ?? ""));
  return c.redirect(msg ? `/messages/with/${toUserId}#bottom` : "/messages/compose");
});

messageRoutes.get("/messages/with/:id{[0-9]+}", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const otherId = Number(c.req.param("id"));
  if (otherId === user.id) return c.redirect("/messages");
  const [other] = await db.select().from(users).where(eq(users.id, otherId)).limit(1);
  if (!other) return c.notFound();

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
  const first = other.name.split(" ")[0];

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
  const msg = await sendMessage(gate.user, otherId, String(body.body ?? ""));
  if (c.req.header("accept")?.includes("application/json")) {
    return c.json({ ok: Boolean(msg) }, msg ? 200 : 400);
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
