import { and, eq, or, inArray } from "drizzle-orm";
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
): Promise<"none" | "pending_out" | "pending_in" | "friends"> {
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

export async function friendsOfFriends(userId: number): Promise<number[]> {
  const mine = await friendIds(userId);
  const set = new Set<number>();
  for (const fid of mine) {
    const theirs = await friendIds(fid);
    for (const tid of theirs) {
      if (tid !== userId && !mine.includes(tid)) set.add(tid);
    }
  }
  return [...set];
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

export function parseCourses(courses: string): string[] {
  return courses
    .split(/[,;\n]/)
    .map((c) => c.trim())
    .filter(Boolean);
}
