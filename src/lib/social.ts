import { and, eq, or, inArray, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import { friendships, boardEvents, users, type User } from "../db/schema.js";

export async function areFriends(a: number, b: number): Promise<boolean> {
  if (a === b) return true;
  const rows = await db
    .select()
    .from(friendships)
    .where(
      and(
        eq(friendships.status, "accepted"),
        or(
          and(eq(friendships.fromUserId, a), eq(friendships.toUserId, b)),
          and(eq(friendships.fromUserId, b), eq(friendships.toUserId, a))
        )
      )
    )
    .limit(1);
  return rows.length > 0;
}

export async function friendshipStatus(
  a: number,
  b: number
): Promise<FriendStatus> {
  if (a === b) return "friends";
  const rows = await db
    .select()
    .from(friendships)
    .where(
      or(
        and(eq(friendships.fromUserId, a), eq(friendships.toUserId, b)),
        and(eq(friendships.fromUserId, b), eq(friendships.toUserId, a))
      )
    )
    .limit(1);
  if (!rows.length) return "none";
  const f = rows[0];
  if (f.status === "accepted") return "friends";
  if (f.fromUserId === a) return "pending_out";
  return "pending_in";
}

export type FriendStatus = "none" | "pending_out" | "pending_in" | "friends";

/** Friendship status between `me` and each of `ids`, in one query. */
export async function friendshipStatuses(
  me: number,
  ids: number[]
): Promise<Map<number, FriendStatus>> {
  const result = new Map<number, FriendStatus>();
  for (const id of ids) result.set(id, id === me ? "friends" : "none");
  if (!ids.length) return result;
  const rows = await db
    .select()
    .from(friendships)
    .where(
      or(
        and(eq(friendships.fromUserId, me), inArray(friendships.toUserId, ids)),
        and(eq(friendships.toUserId, me), inArray(friendships.fromUserId, ids))
      )
    );
  for (const f of rows) {
    const other = f.fromUserId === me ? f.toUserId : f.fromUserId;
    if (f.status === "accepted") result.set(other, "friends");
    else result.set(other, f.fromUserId === me ? "pending_out" : "pending_in");
  }
  return result;
}

export async function navCounts(userId: number) {
  const [row] = await db.execute<{
    unread: number;
    requests: number;
    pokes: number;
  }>(sql`select
      (select count(*)::int from messages where to_user_id = ${userId} and read = false) as unread,
      (select count(*)::int from friendships where to_user_id = ${userId} and status = 'pending') as requests,
      (select count(*)::int from pokes where to_user_id = ${userId} and seen = false) as pokes`);
  return {
    unread: Number(row?.unread ?? 0),
    requests: Number(row?.requests ?? 0),
    pokes: Number(row?.pokes ?? 0),
  };
}

export async function friendIds(userId: number): Promise<number[]> {
  const rows = await db
    .select()
    .from(friendships)
    .where(
      and(
        eq(friendships.status, "accepted"),
        or(eq(friendships.fromUserId, userId), eq(friendships.toUserId, userId))
      )
    );
  return rows.map((r) =>
    r.fromUserId === userId ? r.toUserId : r.fromUserId
  );
}

/** Friends of my friends who aren't me or already my friends — one query. */
export async function friendsOfFriends(userId: number): Promise<number[]> {
  const rows = await db.execute<{ id: number }>(sql`
    WITH edges AS (
      SELECT from_user_id AS a, to_user_id AS b FROM friendships WHERE status = 'accepted'
      UNION ALL
      SELECT to_user_id, from_user_id FROM friendships WHERE status = 'accepted'
    ),
    mine AS (SELECT b AS id FROM edges WHERE a = ${userId})
    SELECT DISTINCT e.b AS id
      FROM edges e JOIN mine m ON e.a = m.id
     WHERE e.b <> ${userId} AND e.b NOT IN (SELECT id FROM mine)`);
  return rows.map((r) => Number(r.id));
}

export async function mutualFriends(
  viewerId: number,
  profileId: number
): Promise<User[]> {
  const a = await friendIds(viewerId);
  const b = await friendIds(profileId);
  const mutual = a.filter((id) => b.includes(id));
  if (!mutual.length) return [];
  return db.select().from(users).where(inArray(users.id, mutual));
}

export async function canViewProfile(
  viewer: User | null,
  profile: User
): Promise<boolean> {
  if (!viewer) return profile.privacy === "network";
  if (viewer.id === profile.id) return true;
  if (profile.privacy === "network") return true;
  if (profile.privacy === "friends") return areFriends(viewer.id, profile.id);
  if (profile.privacy === "friends_of_friends") {
    if (await areFriends(viewer.id, profile.id)) return true;
    const fof = await friendsOfFriends(profile.id);
    return fof.includes(viewer.id);
  }
  return true;
}

export async function addBoardEvent(
  actorUserId: number,
  kind: string,
  detail: string,
  targetUserId?: number
) {
  await db.insert(boardEvents).values({
    actorUserId,
    targetUserId: targetUserId ?? null,
    kind,
    detail,
  });
}

/** Gives older accounts a permanent referral code the first time they need one. */
export async function ensureReferralCode(user: User): Promise<User> {
  if (user.referralCode) return user;
  const [updated] = await db
    .update(users)
    .set({ referralCode: makeReferralCode(user.name) })
    .where(eq(users.id, user.id))
    .returning();
  return updated ?? user;
}

/** How many accounts on the student list have been activated. */
export async function joinedStats(): Promise<{ joined: number; total: number }> {
  const [row] = await db
    .select({
      joined: sql<number>`count(*) filter (where ${users.claimedAt} is not null)::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(users);
  return { joined: Number(row?.joined ?? 0), total: Number(row?.total ?? 0) };
}

export function makeReferralCode(name: string): string {
  const first =
    name.split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, "") || "qairu";
  return `${first.slice(0, 16)}-${randomBytes(3).toString("hex").slice(0, 5)}`;
}

export type TreeNode<T> = T & { children: TreeNode<T>[] };

/** Nest flat rows with id/parentId into a tree. Orphans become roots. */
export function buildTree<T extends { id: number; parentId: number | null }>(
  rows: T[],
  sortChildren: (a: T, b: T) => number
): TreeNode<T>[] {
  const nodes = new Map<number, TreeNode<T>>();
  for (const r of rows) nodes.set(r.id, { ...r, children: [] });
  const roots: TreeNode<T>[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId != null ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortAll = (list: TreeNode<T>[]) => {
    list.sort(sortChildren);
    for (const n of list) sortAll(n.children);
  };
  sortAll(roots);
  return roots;
}

export function parseCourses(courses: string): string[] {
  return courses
    .split(/[,;\n]/)
    .map((c) => c.trim())
    .filter(Boolean);
}
