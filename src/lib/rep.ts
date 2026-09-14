import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  users,
  votes,
  repEvents,
  wallPosts,
  discussionPosts,
  discussionComments,
} from "../db/schema.js";

export const REP = {
  referral: 25,
  vote: 1,
  replyReceived: 1,
  // Anti-farming: max referral payouts per referrer per 24h.
  referralDailyCap: 10,
  createBoard: 50,
};

export type VoteTarget = "wall" | "post" | "comment";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function addRep(
  tx: Tx | typeof db,
  userId: number,
  amount: number,
  reason: string,
  sourceType: string,
  sourceId: number | null,
  actorUserId: number | null
) {
  if (!amount) return;
  await tx.insert(repEvents).values({
    userId,
    amount,
    reason,
    sourceType,
    sourceId,
    actorUserId,
  });
  await tx
    .update(users)
    .set({ rep: sql`${users.rep} + ${amount}` })
    .where(eq(users.id, userId));
}

/** Referrer earns rep when someone joins through their link (daily-capped). */
export async function awardReferral(referrerId: number, newUserId: number) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(repEvents)
    .where(
      and(
        eq(repEvents.userId, referrerId),
        eq(repEvents.reason, "referral"),
        gte(repEvents.createdAt, since)
      )
    );
  if (count >= REP.referralDailyCap) return 0;
  await addRep(db, referrerId, REP.referral, "referral", "user", newUserId, newUserId);
  return REP.referral;
}

/** Author earns rep the first time a given person replies to their content. */
export async function awardReply(
  authorId: number,
  replierId: number,
  sourceType: VoteTarget,
  parentId: number
) {
  if (authorId === replierId) return;
  const existing = await db
    .select({ id: repEvents.id })
    .from(repEvents)
    .where(
      and(
        eq(repEvents.userId, authorId),
        eq(repEvents.reason, "reply"),
        eq(repEvents.sourceType, sourceType),
        eq(repEvents.sourceId, parentId),
        eq(repEvents.actorUserId, replierId)
      )
    )
    .limit(1);
  if (existing.length) return;
  await addRep(db, authorId, REP.replyReceived, "reply", sourceType, parentId, replierId);
}

async function loadTarget(tx: Tx, type: VoteTarget, id: number) {
  if (type === "wall") {
    const [row] = await tx
      .select({ authorId: wallPosts.authorUserId, profileId: wallPosts.profileUserId })
      .from(wallPosts)
      .where(eq(wallPosts.id, id))
      .limit(1);
    return row ? { authorId: row.authorId, profileId: row.profileId } : null;
  }
  if (type === "post") {
    const [row] = await tx
      .select({ authorId: discussionPosts.authorUserId, deleted: discussionPosts.deleted })
      .from(discussionPosts)
      .where(eq(discussionPosts.id, id))
      .limit(1);
    return row && !row.deleted ? { authorId: row.authorId, profileId: null } : null;
  }
  const [row] = await tx
    .select({ authorId: discussionComments.authorUserId, deleted: discussionComments.deleted })
    .from(discussionComments)
    .where(eq(discussionComments.id, id))
    .limit(1);
  return row && !row.deleted ? { authorId: row.authorId, profileId: null } : null;
}

async function bumpScore(tx: Tx, type: VoteTarget, id: number, delta: number) {
  if (type === "wall") {
    const [r] = await tx
      .update(wallPosts)
      .set({ score: sql`${wallPosts.score} + ${delta}` })
      .where(eq(wallPosts.id, id))
      .returning({ score: wallPosts.score });
    return r.score;
  }
  if (type === "post") {
    const [r] = await tx
      .update(discussionPosts)
      .set({ score: sql`${discussionPosts.score} + ${delta}` })
      .where(eq(discussionPosts.id, id))
      .returning({ score: discussionPosts.score });
    return r.score;
  }
  const [r] = await tx
    .update(discussionComments)
    .set({ score: sql`${discussionComments.score} + ${delta}` })
    .where(eq(discussionComments.id, id))
    .returning({ score: discussionComments.score });
  return r.score;
}

export type VoteResult =
  | { ok: true; score: number; myVote: number; profileId: number | null }
  | { ok: false; error: string };

/**
 * Reddit-style vote. Clicking the same arrow again removes the vote,
 * clicking the other arrow flips it. The author's rep moves with the score.
 */
export async function castVote(
  voterId: number,
  type: VoteTarget,
  id: number,
  direction: 1 | -1,
  canVote?: (profileId: number | null) => Promise<boolean>
): Promise<VoteResult> {
  return db.transaction(async (tx) => {
    const target = await loadTarget(tx, type, id);
    if (!target) return { ok: false as const, error: "not_found" };
    if (target.authorId === voterId) return { ok: false as const, error: "own_content" };
    if (canVote && !(await canVote(target.profileId))) {
      return { ok: false as const, error: "forbidden" };
    }

    const [existing] = await tx
      .select()
      .from(votes)
      .where(
        and(eq(votes.userId, voterId), eq(votes.targetType, type), eq(votes.targetId, id))
      )
      .limit(1);

    let newValue: number;
    if (!existing) {
      newValue = direction;
      await tx.insert(votes).values({ userId: voterId, targetType: type, targetId: id, value: direction });
    } else if (existing.value === direction) {
      newValue = 0;
      await tx.delete(votes).where(eq(votes.id, existing.id));
    } else {
      newValue = direction;
      await tx.update(votes).set({ value: direction }).where(eq(votes.id, existing.id));
    }

    const delta = newValue - (existing?.value ?? 0);
    const score = await bumpScore(tx, type, id, delta);
    const reason = delta > 0 ? "upvote" : "downvote";
    await addRep(tx, target.authorId, delta * REP.vote, reason, type, id, voterId);

    return { ok: true as const, score, myVote: newValue, profileId: target.profileId };
  });
}

/** Map of targetId -> the viewer's vote (+1 / -1) for a list of targets. */
export async function myVotes(
  userId: number,
  type: VoteTarget,
  ids: number[]
): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ targetId: votes.targetId, value: votes.value })
    .from(votes)
    .where(
      and(
        eq(votes.userId, userId),
        eq(votes.targetType, type),
        inArray(votes.targetId, ids)
      )
    );
  return new Map(rows.map((r) => [r.targetId, r.value]));
}
