import { Hono } from "hono";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { AppEnv } from "../middleware/auth.js";
import { needLogin } from "../middleware/auth.js";
import { Layout, LeftNav, Box, timeAgo } from "../views/layout.js";
import { db } from "../db/index.js";
import { repEvents, users, wallPosts, type User } from "../db/schema.js";
import { canViewProfile, ensureReferralCode, friendIds } from "../lib/social.js";
import { REP, castVote, type VoteTarget } from "../lib/rep.js";
import { backPath } from "../lib/url.js";
import { inviteLink } from "../lib/invite.js";

export const repRoutes = new Hono<AppEnv>();

const ANCHOR: Record<VoteTarget, string> = { wall: "wall", post: "post", comment: "c" };

repRoutes.post("/vote", async (c) => {
  const gate = needLogin(c);
  const wantsJson = c.req.header("accept")?.includes("application/json");
  if (gate.redirect) return wantsJson ? c.json({ ok: false, error: "login" }, 401) : gate.redirect;
  const user = gate.user;

  const body = await c.req.parseBody();
  const type = String(body.type ?? "") as VoteTarget;
  const id = Number(body.id);
  const dir = body.dir === "down" ? -1 : 1;
  if (!["wall", "post", "comment"].includes(type) || !Number.isInteger(id)) {
    return wantsJson ? c.json({ ok: false, error: "bad_request" }, 400) : c.redirect("/home");
  }

  const result = await castVote(user.id, type, id, dir, async (profileId) => {
    if (profileId == null) return true;
    const [profile] = await db.select().from(users).where(eq(users.id, profileId)).limit(1);
    return Boolean(profile) && (await canViewProfile(user, profile));
  });

  if (wantsJson) {
    return result.ok
      ? c.json({ ok: true, score: result.score, myVote: result.myVote })
      : c.json(result, result.error === "not_found" ? 404 : 403);
  }
  return c.redirect(`${backPath(c, "/home")}#${ANCHOR[type]}-${id}`);
});

// /wall/p/:id -> the wall post on its profile (used by rep history links)
repRoutes.get("/wall/p/:id{[0-9]+}", async (c) => {
  const [post] = await db
    .select({ profileUserId: wallPosts.profileUserId })
    .from(wallPosts)
    .where(eq(wallPosts.id, Number(c.req.param("id"))))
    .limit(1);
  return post
    ? c.redirect(`/profile/${post.profileUserId}#wall-${c.req.param("id")}`)
    : c.redirect("/rep");
});

function describe(
  e: typeof repEvents.$inferSelect,
  actor: User | undefined
) {
  const who = actor ? <a href={`/profile/${actor.id}`}>{actor.name}</a> : "Someone";
  const thing =
    e.sourceType === "wall"
      ? { label: "wall post", href: `/wall/p/${e.sourceId}` }
      : e.sourceType === "post"
        ? { label: "discussion post", href: `/d/p/${e.sourceId}` }
        : e.sourceType === "comment"
          ? { label: "comment", href: `/d/c/${e.sourceId}` }
          : null;
  const link = thing ? <a href={thing.href}>your {thing.label}</a> : "your content";
  switch (e.reason) {
    case "referral":
      return <>{who} joined through your invite link</>;
    case "accepted_answer":
      return (
        <>
          {who} marked <a href={`/d/c/${e.sourceId}`}>your comment</a> as the answer
        </>
      );
    case "answer_unaccepted":
      return (
        <>
          {who} un-marked <a href={`/d/c/${e.sourceId}`}>your answer</a>
        </>
      );
    case "reply":
      return <>{who} replied to {link}</>;
    case "upvote":
      return <>{who} upvoted {link}</>;
    case "downvote":
      return <>vote change on {link}</>;
    default:
      return <>{e.reason}</>;
  }
}

repRoutes.get("/rep", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;

  // Only activated members are ranked; pre-created accounts sit at 0 anyway.
  const leaders = await db
    .select()
    .from(users)
    .where(and(isNotNull(users.claimedAt), isNull(users.suspendedAt)))
    .orderBy(desc(users.rep), users.id)
    .limit(25);
  // Status/class year only for people whose privacy lets this viewer see them.
  const myFriends = new Set(await friendIds(user.id));
  const showDetails = (u: User) =>
    u.privacy === "network" || u.id === user.id || myFriends.has(u.id);

  const [{ rank }] = await db
    .select({ rank: sql<number>`count(*)::int + 1` })
    .from(users)
    .where(and(isNotNull(users.claimedAt), isNull(users.suspendedAt), sql`${users.rep} > ${user.rep}`));

  const history = await db
    .select()
    .from(repEvents)
    .where(eq(repEvents.userId, user.id))
    .orderBy(desc(repEvents.createdAt), desc(repEvents.id))
    .limit(20);
  const actorIds = [
    ...new Set(history.map((h) => h.actorUserId).filter((id): id is number => id != null)),
  ];
  const actors = actorIds.length
    ? await db.select().from(users).where(inArray(users.id, actorIds))
    : [];
  const actorMap = new Map(actors.map((a) => [a.id, a]));

  const breakdown = await db
    .select({ reason: repEvents.reason, total: sql<number>`sum(${repEvents.amount})::int` })
    .from(repEvents)
    .where(eq(repEvents.userId, user.id))
    .groupBy(repEvents.reason);
  const totals = new Map(breakdown.map((b) => [b.reason, Number(b.total)]));
  const fromVotes = (totals.get("upvote") ?? 0) + (totals.get("downvote") ?? 0);
  const fromAnswers =
    (totals.get("accepted_answer") ?? 0) + (totals.get("answer_unaccepted") ?? 0);

  const link = inviteLink(c, await ensureReferralCode(user));

  return c.html(
    <Layout title="Rep" user={user} banner="Rep">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title="[ Your Rep ]" alt>
              <table class="stat-row">
                <tr>
                  <td>
                    <div class="stat-num">{user.rep}</div>
                    <div class="meta">total rep</div>
                  </td>
                  <td>
                    <div class="stat-num">#{rank}</div>
                    <div class="meta">at QAIRU</div>
                  </td>
                  <td>
                    <div class="stat-num">{fromVotes >= 0 ? `+${fromVotes}` : fromVotes}</div>
                    <div class="meta">from votes</div>
                  </td>
                  <td>
                    <div class="stat-num">+{totals.get("referral") ?? 0}</div>
                    <div class="meta">from invites</div>
                  </td>
                  <td>
                    <div class="stat-num">+{totals.get("reply") ?? 0}</div>
                    <div class="meta">from replies</div>
                  </td>
                  <td>
                    <div class="stat-num">
                      {fromAnswers >= 0 ? `+${fromAnswers}` : fromAnswers}
                    </div>
                    <div class="meta">from answers</div>
                  </td>
                </tr>
              </table>
            </Box>

            <Box title="[ How to Earn Rep ]">
              <p class="rep-why">
                Rep is a quiet signal of who helps others — not a popularity contest.
              </p>
              <table class="bordertable rules">
                <tr>
                  <td class="rule-pts">+{REP.referral}</td>
                  <td>
                    A classmate activates their account through your invite link (they
                    still need their @qairu.edu.kz email; up to {REP.referralDailyCap}
                    /day). <a href="/invite">Get your link</a>
                  </td>
                </tr>
                <tr>
                  <td class="rule-pts">+{REP.vote}</td>
                  <td>
                    Someone upvotes your wall post, wall reply, discussion post or
                    comment
                  </td>
                </tr>
                <tr>
                  <td class="rule-pts">−{REP.vote}</td>
                  <td>Someone downvotes it</td>
                </tr>
                <tr>
                  <td class="rule-pts">+{REP.replyReceived}</td>
                  <td>Someone new replies to your post or comment (once per person)</td>
                </tr>
                <tr>
                  <td class="rule-pts">+{REP.acceptedAnswer}</td>
                  <td>Your comment is marked as the answer to a question</td>
                </tr>
                <tr>
                  <td class="rule-pts">{REP.createBoard}</td>
                  <td>Rep needed to start your own discussion board</td>
                </tr>
              </table>
              <p class="meta">
                You can't vote on your own stuff. Your invite link:{" "}
                <a href="/invite">{link}</a>
              </p>
            </Box>

            <table class="layout-table two-col">
              <tr>
                <td>
                  <Box title="[ Leaderboard ]" alt>
                    <table class="bordertable leaderboard">
                      {leaders.map((u, i) => (
                        <tr class={u.id === user.id ? "me" : ""}>
                          <td class="lb-rank">{i + 1}</td>
                          <td>
                            <a href={`/profile/${u.id}`}>{u.name}</a>
                            {showDetails(u) ? (
                              <>
                                <br />
                                <span class="meta">
                                  {u.status}
                                  {u.classYear ? ` · ${u.classYear}` : ""}
                                </span>
                              </>
                            ) : null}
                          </td>
                          <td class="lb-rep">{u.rep}</td>
                        </tr>
                      ))}
                    </table>
                  </Box>
                </td>
                <td>
                  <Box title="[ Recent Rep Activity ]">
                    {history.length ? (
                      history.map((e) => (
                        <div class="rep-item">
                          <span class={e.amount > 0 ? "rep-gain" : "rep-loss"}>
                            {e.amount > 0 ? `+${e.amount}` : e.amount}
                          </span>{" "}
                          {describe(e, e.actorUserId ? actorMap.get(e.actorUserId) : undefined)}
                          <span class="meta"> · {timeAgo(e.createdAt)}</span>
                        </div>
                      ))
                    ) : (
                      <p class="meta">
                        No rep yet. Post in <a href="/d">Discussions</a> or{" "}
                        <a href="/invite">invite a friend</a>.
                      </p>
                    )}
                  </Box>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </Layout>
  );
});
