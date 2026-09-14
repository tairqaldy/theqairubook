import { Hono } from "hono";
import { desc, eq, or, inArray, sql, and, gte } from "drizzle-orm";
import type { AppEnv } from "../middleware/auth.js";
import { needLogin } from "../middleware/auth.js";
import { Layout, LeftNav, Box, formatDate } from "../views/layout.js";
import { db } from "../db/index.js";
import { boardEvents, boards, discussionPosts, users } from "../db/schema.js";
import { friendIds } from "../lib/social.js";

export const boardRoutes = new Hono<AppEnv>();

function parseDiscussion(detail: string) {
  try {
    const d = JSON.parse(detail) as { postId: number; slug: string; title: string };
    return d.postId && d.slug ? d : null;
  } catch {
    return null;
  }
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

  const topRep = await db
    .select()
    .from(users)
    .orderBy(desc(users.rep), users.id)
    .limit(5);

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
          </td>
          <td class="maincol">
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
