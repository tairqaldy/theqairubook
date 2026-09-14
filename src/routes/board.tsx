import { Hono } from "hono";
import { desc, eq, or, inArray, sql, and, gte, isNotNull, isNull } from "drizzle-orm";
import type { AppEnv } from "../middleware/auth.js";
import { needLogin } from "../middleware/auth.js";
import { Layout, LeftNav, Box, formatDate, timeAgo } from "../views/layout.js";
import { db } from "../db/index.js";
import { boardEvents, boards, discussionPosts, users, type User } from "../db/schema.js";
import { friendIds } from "../lib/social.js";
import { joinedStats } from "../lib/social.js";

export const boardRoutes = new Hono<AppEnv>();

function parseDiscussion(detail: string) {
  try {
    const d = JSON.parse(detail) as { postId: number; slug: string; title: string };
    return d.postId && d.slug ? d : null;
  } catch {
    return null;
  }
}

type ChecklistItem = { done: boolean; label: string; href: string; hint: string };

/** First steps for a new member, computed fresh from the DB on every visit. */
async function gettingStarted(user: User, friendCount: number): Promise<ChecklistItem[]> {
  const [row] = await db.execute<{ discussed: boolean; invited: boolean }>(sql`select
      (exists (select 1 from discussion_posts where author_user_id = ${user.id})
        or exists (select 1 from discussion_comments where author_user_id = ${user.id})) as discussed,
      exists (select 1 from users where referred_by_user_id = ${user.id} and claimed_at is not null) as invited`);
  return [
    {
      done: Boolean(user.photoPath),
      label: "Add a profile photo",
      href: "/edit-profile",
      hint: "so classmates recognise you",
    },
    {
      done: Boolean(user.headline.trim() || user.aboutMe.trim()),
      label: "Write a headline or About Me",
      href: "/edit-profile",
      hint: "what you study, what you're into",
    },
    {
      done: friendCount > 0,
      label: "Add your first friend",
      href: "/search",
      hint: "search for people you know",
    },
    {
      done: Boolean(row?.discussed),
      label: "Post or comment in Discussions",
      href: "/d",
      hint: "ask a question or help someone out",
    },
    {
      done: Boolean(row?.invited),
      label: "Invite a classmate",
      href: "/invite",
      hint: "they still need their @qairu.edu.kz email",
    },
  ];
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

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const trending = await db
    .select({ post: discussionPosts, board: boards })
    .from(discussionPosts)
    .innerJoin(boards, eq(discussionPosts.boardId, boards.id))
    .where(and(eq(discussionPosts.deleted, false), gte(discussionPosts.createdAt, weekAgo)))
    .orderBy(desc(sql`${discussionPosts.score} + ${discussionPosts.commentCount}`), desc(discussionPosts.createdAt))
    .limit(5);

  const announcements = await db
    .select({ post: discussionPosts, board: boards })
    .from(discussionPosts)
    .innerJoin(boards, eq(discussionPosts.boardId, boards.id))
    .where(and(eq(discussionPosts.pinned, true), eq(discussionPosts.deleted, false)))
    .orderBy(desc(discussionPosts.createdAt))
    .limit(10);

  const checklist = await gettingStarted(user, fids.length);
  const doneCount = checklist.filter((i) => i.done).length;

  const topRep = await db
    .select()
    .from(users)
    .where(and(isNotNull(users.claimedAt), isNull(users.suspendedAt)))
    .orderBy(desc(users.rep), users.id)
    .limit(5);

  const newest = await db
    .select()
    .from(users)
    .where(and(isNotNull(users.claimedAt), isNull(users.suspendedAt)))
    .orderBy(desc(users.claimedAt), desc(users.id))
    .limit(5);

  const stats = await joinedStats();

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
            <Box title="Top Rep">
              <ol class="mini-rank">
                {topRep.map((u) => (
                  <li>
                    <a href={`/profile/${u.id}`}>{u.name}</a>{" "}
                    <span class="meta">{u.rep}</span>
                  </li>
                ))}
              </ol>
              <a href="/rep">full leaderboard ›</a>
            </Box>
            <Box title="Newest Members">
              <ul class="newest-members">
                {newest.map((u) => (
                  <li>
                    <a href={`/profile/${u.id}`}>{u.name}</a>
                    {u.claimedAt ? <span class="meta"> {timeAgo(u.claimedAt)}</span> : null}
                  </li>
                ))}
              </ul>
              <p class="stats-line small">
                <b>{stats.joined}</b> of <b>{stats.total}</b> students have joined
              </p>
              <a href="/social-net">browse the social net ›</a>
            </Box>
          </td>
          <td class="maincol">
            {c.req.query("reset") === "1" ? (
              <p class="notice">
                Your password was changed. Any other devices you were logged in on have been
                logged out.
              </p>
            ) : null}
            {announcements.length ? (
              <div class="box announce-box">
                <div class="box-title">[ 📌 Announcements ]</div>
                <div class="box-body">
                  <ul class="announce-list">
                    {announcements.map(({ post, board }) => (
                      <li>
                        <a href={`/d/${board.slug}/${post.id}`}>{post.title}</a>
                        <span class="meta"> · {timeAgo(post.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            {doneCount < checklist.length ? (
              <Box title={`[ Getting Started · ${doneCount}/${checklist.length} done ]`} alt>
                <ul class="checklist">
                  {checklist.map((item) => (
                    <li class={item.done ? "done" : ""}>
                      <span class="check-mark">{item.done ? "✓" : "○"}</span>{" "}
                      {item.done ? (
                        <span class="check-label">{item.label}</span>
                      ) : (
                        <>
                          <a href={item.href}>{item.label}</a>
                          <span class="meta"> — {item.hint}</span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </Box>
            ) : null}

            <Box title="[ Hot in Discussions ]">
              {trending.length ? (
                <ul class="bullets trending">
                  {trending.map(({ post, board }) => (
                    <li>
                      <span class="score-pill">{post.score}</span>{" "}
                      <a href={`/d/${board.slug}/${post.id}`}>{post.title}</a>
                      <span class="meta">
                        {" "}
                        · q/{board.slug} · {post.commentCount} comment
                        {post.commentCount === 1 ? "" : "s"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="meta">
                  Quiet week. <a href="/d/submit">Start a discussion</a>.
                </p>
              )}
              <p class="meta">
                <a href="/d">Browse all boards ›</a>
              </p>
            </Box>

            <Box title="[ The Board ]" alt>
              <p class="meta">Activity from you and your friends</p>
              {events.length ? (
                events.map(({ event, actor }) => {
                  const target = event.targetUserId
                    ? targetMap.get(event.targetUserId)
                    : null;
                  const who = <a href={`/profile/${actor.id}`}>{actor.name}</a>;
                  let line;
                  if (event.kind === "joined") {
                    line = <>{who} joined theqairubook</>;
                  } else if (event.kind === "referral" && target) {
                    line = (
                      <>
                        {who} joined through{" "}
                        <a href={`/profile/${target.id}`}>{target.name.split(" ")[0]}'s</a>{" "}
                        invite link
                        {event.detail ? <span class="rep-gain"> {event.detail}</span> : null}
                      </>
                    );
                  } else if (event.kind === "poke" && target) {
                    line = (
                      <>
                        {who} poked <a href={`/profile/${target.id}`}>{target.name}</a>
                      </>
                    );
                  } else if (event.kind === "friend" && target) {
                    line = (
                      <>
                        {who} and <a href={`/profile/${target.id}`}>{target.name}</a> are
                        now friends
                      </>
                    );
                  } else if (event.kind === "wall" && target) {
                    line = (
                      <>
                        {who} wrote on{" "}
                        <a href={`/profile/${target.id}`}>
                          {target.id === actor.id ? "their own" : `${target.name.split(" ")[0]}'s`} wall
                        </a>
                        : "{event.detail}"
                      </>
                    );
                  } else if (event.kind === "discussion" && parseDiscussion(event.detail)) {
                    const d = parseDiscussion(event.detail)!;
                    line = (
                      <>
                        {who} posted in <a href={`/d/${d.slug}`}>q/{d.slug}</a>:{" "}
                        <a href={`/d/${d.slug}/${d.postId}`}>{d.title}</a>
                      </>
                    );
                  } else {
                    line = (
                      <>
                        {who} {event.detail || event.kind}
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
                <a href="/friends">Find friends</a> ·{" "}
                <a href="/d/submit">Start a discussion</a> ·{" "}
                <a href="/invite">Invite a classmate (+rep)</a> ·{" "}
                <a href="/social-net">Browse the social net</a> ·{" "}
                <a href="/edit-profile">Edit your profile</a>
              </p>
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
});
