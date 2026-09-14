import { Hono } from "hono";
import { and, desc, eq, or, inArray, sql } from "drizzle-orm";
import type { AppEnv } from "../middleware/auth.js";
import { Layout, LeftNav, Box, formatDate } from "../views/layout.js";
import { db } from "../db/index.js";
import {
  messages,
  boardEvents,
  users,
  type User,
} from "../db/schema.js";
import { friendIds } from "../lib/social.js";

export const boardRoutes = new Hono<AppEnv>();

function needLogin(c: {
  get: (k: "user") => User | null;
  redirect: (u: string) => Response;
}) {
  const user = c.get("user");
  if (!user) return { user: null as never, redirect: c.redirect("/login") };
  return { user, redirect: null as Response | null };
}

boardRoutes.get("/home", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;

  const fids = await friendIds(user.id);
  const relevant = [user.id, ...fids];

  const events = await db
    .select({
      event: boardEvents,
      actor: users,
    })
    .from(boardEvents)
    .innerJoin(users, eq(boardEvents.actorUserId, users.id))
    .where(
      or(
        inArray(boardEvents.actorUserId, relevant),
        inArray(boardEvents.targetUserId, relevant)
      )
    )
    .orderBy(desc(boardEvents.createdAt))
    .limit(40);

  const unread = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.toUserId, user.id), eq(messages.read, false)));

  const unreadCount = unread[0]?.count ?? 0;

  // resolve target names
  const targetIds = [
    ...new Set(
      events
        .map((e) => e.event.targetUserId)
        .filter((id): id is number => id != null)
    ),
  ];
  const targets = targetIds.length
    ? await db.select().from(users).where(inArray(users.id, targetIds))
    : [];
  const targetMap = new Map(targets.map((t) => [t.id, t]));

  return c.html(
    <Layout
      title="Home"
      user={user}
      banner={`Welcome ${user.name.split(" ")[0]}!`}
    >
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title="[ The Board ]" alt>
              <p class="meta">
                Activity from you and your friends
                {unreadCount
                  ? ` · you have ${unreadCount} unread message${unreadCount === 1 ? "" : "s"}`
                  : ""}
              </p>
              {events.length ? (
                events.map(({ event, actor }) => {
                  const target = event.targetUserId
                    ? targetMap.get(event.targetUserId)
                    : null;
                  let line: string | Child = null;
                  if (event.kind === "joined") {
                    line = (
                      <>
                        <a href={`/profile/${actor.id}`}>{actor.name}</a> joined
                        theqairubook
                      </>
                    );
                  } else if (event.kind === "poke" && target) {
                    line = (
                      <>
                        <a href={`/profile/${actor.id}`}>{actor.name}</a> poked{" "}
                        <a href={`/profile/${target.id}`}>{target.name}</a>
                      </>
                    );
                  } else if (event.kind === "friend" && target) {
                    line = (
                      <>
                        <a href={`/profile/${actor.id}`}>{actor.name}</a> and{" "}
                        <a href={`/profile/${target.id}`}>{target.name}</a> are
                        now friends
                      </>
                    );
                  } else if (event.kind === "wall" && target) {
                    line = (
                      <>
                        <a href={`/profile/${actor.id}`}>{actor.name}</a> wrote
                        on{" "}
                        <a href={`/profile/${target.id}`}>
                          {target.name.split(" ")[0]}'s wall
                        </a>
                        : "{event.detail}"
                      </>
                    );
                  } else {
                    line = (
                      <>
                        <a href={`/profile/${actor.id}`}>{actor.name}</a>{" "}
                        {event.detail || event.kind}
                      </>
                    );
                  }
                  return (
                    <div class="board-item">
                      {line}
                      <span class="meta"> · {formatDate(event.createdAt)}</span>
                    </div>
                  );
                })
              ) : (
                <p class="meta">
                  Nothing on the board yet. Add friends, poke someone, or write
                  on a wall!
                </p>
              )}
            </Box>

            <Box title="[ Quick Links ]">
              <p>
                <a href="/search">Search for people</a> ·{" "}
                <a href="/social-net">Browse the social net</a> ·{" "}
                <a href="/invite">Invite a classmate</a> ·{" "}
                <a href="/edit-profile">Edit your profile</a>
              </p>
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
});

// Child type for JSX
type Child = unknown;

boardRoutes.get("/messages", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;

  const inbox = await db
    .select({ msg: messages, from: users })
    .from(messages)
    .innerJoin(users, eq(messages.fromUserId, users.id))
    .where(eq(messages.toUserId, user.id))
    .orderBy(desc(messages.createdAt))
    .limit(50);

  const sent = await db
    .select({ msg: messages, to: users })
    .from(messages)
    .innerJoin(users, eq(messages.toUserId, users.id))
    .where(eq(messages.fromUserId, user.id))
    .orderBy(desc(messages.createdAt))
    .limit(20);

  return c.html(
    <Layout title="Messages" user={user} banner="My Messages">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <p>
              <a href="/messages/compose">
                <button class="btn" type="button">
                  Compose Message
                </button>
              </a>
            </p>
            <Box title="[ Inbox ]" alt>
              {inbox.length ? (
                <table class="bordertable">
                  <tr>
                    <td>
                      <b>From</b>
                    </td>
                    <td>
                      <b>Subject</b>
                    </td>
                    <td>
                      <b>Date</b>
                    </td>
                  </tr>
                  {inbox.map(({ msg, from }) => (
                    <tr>
                      <td>
                        {!msg.read ? <b>*</b> : null}
                        <a href={`/profile/${from.id}`}>{from.name}</a>
                      </td>
                      <td>
                        <a href={`/messages/${msg.id}`}>{msg.subject}</a>
                      </td>
                      <td>{formatDate(msg.createdAt)}</td>
                    </tr>
                  ))}
                </table>
              ) : (
                <p class="meta">No messages.</p>
              )}
            </Box>
            <Box title="[ Sent ]">
              {sent.length ? (
                <ul class="bullets">
                  {sent.map(({ msg, to }) => (
                    <li>
                      to <a href={`/profile/${to.id}`}>{to.name}</a>:{" "}
                      <a href={`/messages/${msg.id}`}>{msg.subject}</a>
                      <span class="meta"> · {formatDate(msg.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="meta">Nothing sent yet.</p>
              )}
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
});

boardRoutes.get("/messages/compose", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const toId = Number(c.req.query("to") ?? 0);
  let toUser: User | null = null;
  if (toId) {
    const [u] = await db.select().from(users).where(eq(users.id, toId)).limit(1);
    toUser = u ?? null;
  }
  const everyone = await db
    .select()
    .from(users)
    .where(sql`${users.id} <> ${user.id}`)
    .limit(200);

  return c.html(
    <Layout title="Compose" user={user} banner="Compose Message">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title="[ New Message ]" alt>
              <form method="post" action="/messages/compose">
                <table class="search-form">
                  <tr>
                    <td class="field-label">To:</td>
                    <td>
                      <select name="toUserId" required>
                        <option value="">Select…</option>
                        {everyone.map((u) => (
                          <option
                            value={u.id}
                            selected={toUser?.id === u.id}
                          >
                            {u.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Subject:</td>
                    <td>
                      <input type="text" name="subject" size={40} />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Message:</td>
                    <td>
                      <textarea name="body" rows={8} required />
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

boardRoutes.post("/messages/compose", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const body = await c.req.parseBody();
  const toUserId = Number(body.toUserId);
  const subject = String(body.subject ?? "").trim() || "(no subject)";
  const text = String(body.body ?? "").trim();
  if (!toUserId || !text) return c.redirect("/messages/compose");

  await db.insert(messages).values({
    fromUserId: user.id,
    toUserId,
    subject: subject.slice(0, 200),
    body: text.slice(0, 5000),
  });
  return c.redirect("/messages");
});

boardRoutes.get("/messages/:id", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const id = Number(c.req.param("id"));
  const [row] = await db
    .select({ msg: messages, from: users })
    .from(messages)
    .innerJoin(users, eq(messages.fromUserId, users.id))
    .where(eq(messages.id, id))
    .limit(1);

  if (!row) return c.notFound();
  if (row.msg.toUserId !== user.id && row.msg.fromUserId !== user.id) {
    return c.text("Forbidden", 403);
  }

  if (row.msg.toUserId === user.id && !row.msg.read) {
    await db.update(messages).set({ read: true }).where(eq(messages.id, id));
  }

  const [toUser] = await db
    .select()
    .from(users)
    .where(eq(users.id, row.msg.toUserId))
    .limit(1);

  return c.html(
    <Layout title={row.msg.subject} user={user} banner="Message">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title={`[ ${row.msg.subject} ]`} alt>
              <p>
                <b>From:</b>{" "}
                <a href={`/profile/${row.from.id}`}>{row.from.name}</a>
                <br />
                <b>To:</b>{" "}
                {toUser ? (
                  <a href={`/profile/${toUser.id}`}>{toUser.name}</a>
                ) : (
                  "—"
                )}
                <br />
                <b>Date:</b> {formatDate(row.msg.createdAt)}
              </p>
              <hr class="thin" />
              <p style="white-space:pre-wrap">{row.msg.body}</p>
              <p>
                <a href={`/messages/compose?to=${row.from.id}`}>Reply</a> ·{" "}
                <a href="/messages">Back to inbox</a>
              </p>
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
});
