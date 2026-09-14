import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull().unique(),
    // "" for pre-created (not yet activated) accounts: they cannot log in.
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    // Name as written in the official student list (e.g. Cyrillic).
    nativeName: text("native_name").notNull().default(""),
    // null = pre-created from the student list, not activated yet.
    claimedAt: timestamp("claimed_at"),
    role: text("role").notNull().default("member"),
    // Bumped on password change / admin reset to invalidate old sessions.
    sessionVersion: integer("session_version").notNull().default(0),
    // Admin reset after an impersonation report: only an admin claim link can activate it.
    claimLocked: boolean("claim_locked").notNull().default(false),
    // Suspended accounts can't log in (moderation).
    suspendedAt: timestamp("suspended_at"),
    headline: text("headline").notNull().default(""),
    lookingFor: text("looking_for").notNull().default(""),
    clubs: text("clubs").notNull().default(""),
    telegram: text("telegram").notNull().default(""),
    github: text("github").notNull().default(""),
    instagram: text("instagram").notNull().default(""),
    linkedin: text("linkedin").notNull().default(""),
    sex: text("sex").notNull().default(""),
    status: text("status").notNull().default("Student"),
    school: text("school").notNull().default("QAIRU"),
    residence: text("residence").notNull().default(""),
    birthday: text("birthday").notNull().default(""),
    hometown: text("hometown").notNull().default(""),
    highSchool: text("high_school").notNull().default(""),
    screenname: text("screenname").notNull().default(""),
    mobile: text("mobile").notNull().default(""),
    website: text("website").notNull().default(""),
    courses: text("courses").notNull().default(""),
    interests: text("interests").notNull().default(""),
    music: text("music").notNull().default(""),
    books: text("books").notNull().default(""),
    aboutMe: text("about_me").notNull().default(""),
    photoPath: text("photo_path"),
    classYear: text("class_year").notNull().default(""),
    privacy: text("privacy").notNull().default("network"),
    rep: integer("rep").notNull().default(0),
    referralCode: text("referral_code"),
    referredByUserId: integer("referred_by_user_id").references(
      (): AnyPgColumn => users.id
    ),
    memberSince: timestamp("member_since").notNull().defaultNow(),
    lastUpdate: timestamp("last_update").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_referral_code").on(t.referralCode)]
);

export const friendships = pgTable(
  "friendships",
  {
    id: serial("id").primaryKey(),
    fromUserId: integer("from_user_id")
      .notNull()
      .references(() => users.id),
    toUserId: integer("to_user_id")
      .notNull()
      .references(() => users.id),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("friendship_pair").on(t.fromUserId, t.toUserId)]
);

export const pokes = pgTable("pokes", {
  id: serial("id").primaryKey(),
  fromUserId: integer("from_user_id")
    .notNull()
    .references(() => users.id),
  toUserId: integer("to_user_id")
    .notNull()
    .references(() => users.id),
  seen: boolean("seen").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    fromUserId: integer("from_user_id")
      .notNull()
      .references(() => users.id),
    toUserId: integer("to_user_id")
      .notNull()
      .references(() => users.id),
    subject: text("subject").notNull().default("(no subject)"),
    body: text("body").notNull(),
    read: boolean("read").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("messages_pair").on(t.fromUserId, t.toUserId, t.id)]
);

export const wallPosts = pgTable(
  "wall_posts",
  {
    id: serial("id").primaryKey(),
    profileUserId: integer("profile_user_id")
      .notNull()
      .references(() => users.id),
    authorUserId: integer("author_user_id")
      .notNull()
      .references(() => users.id),
    parentId: integer("parent_id").references((): AnyPgColumn => wallPosts.id, {
      onDelete: "cascade",
    }),
    body: text("body").notNull(),
    score: integer("score").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("wall_posts_profile").on(t.profileUserId)]
);

export const invites = pgTable(
  "invites",
  {
    id: serial("id").primaryKey(),
    fromUserId: integer("from_user_id")
      .notNull()
      .references(() => users.id),
    email: text("email").notNull().default(""),
    token: text("token").notNull(),
    usedByUserId: integer("used_by_user_id").references(() => users.id),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("invite_token").on(t.token)]
);

export const boardEvents = pgTable("board_events", {
  id: serial("id").primaryKey(),
  actorUserId: integer("actor_user_id")
    .notNull()
    .references(() => users.id),
  targetUserId: integer("target_user_id").references(() => users.id),
  kind: text("kind").notNull(),
  detail: text("detail").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// One row per (voter, thing). value is +1 or -1.
// targetType: "wall" | "post" | "comment"
export const votes = pgTable(
  "votes",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    targetType: text("target_type").notNull(),
    targetId: integer("target_id").notNull(),
    value: integer("value").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("votes_unique").on(t.userId, t.targetType, t.targetId)]
);

// Ledger of every rep change, so rep is auditable and explainable.
export const repEvents = pgTable(
  "rep_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    amount: integer("amount").notNull(),
    reason: text("reason").notNull(),
    sourceType: text("source_type").notNull().default(""),
    sourceId: integer("source_id"),
    actorUserId: integer("actor_user_id").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("rep_events_user").on(t.userId, t.createdAt),
    uniqueIndex("rep_events_reply_once")
      .on(t.userId, t.sourceType, t.sourceId, t.actorUserId)
      .where(sql`reason = 'reply'`),
    uniqueIndex("rep_events_referral_once").on(t.sourceId).where(sql`reason = 'referral'`),
  ]
);

export const boards = pgTable("boards", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const discussionPosts = pgTable(
  "discussion_posts",
  {
    id: serial("id").primaryKey(),
    boardId: integer("board_id")
      .notNull()
      .references(() => boards.id),
    authorUserId: integer("author_user_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    url: text("url").notNull().default(""),
    score: integer("score").notNull().default(0),
    commentCount: integer("comment_count").notNull().default(0),
    // "discussion" | "question" | "material" | "announcement" (admin only)
    flair: text("flair").notNull().default("discussion"),
    pinned: boolean("pinned").notNull().default(false),
    // For questions: the comment the author marked as the answer.
    acceptedCommentId: integer("accepted_comment_id"),
    deleted: boolean("deleted").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("discussion_posts_board").on(t.boardId, t.createdAt)]
);

export const savedPosts = pgTable(
  "saved_posts",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    postId: integer("post_id")
      .notNull()
      .references(() => discussionPosts.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("saved_posts_unique").on(t.userId, t.postId)]
);

// Uploaded images and PDFs attached to discussion posts / comments.
export const media = pgTable(
  "media",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    postId: integer("post_id").references(() => discussionPosts.id),
    commentId: integer("comment_id").references(
      (): AnyPgColumn => discussionComments.id
    ),
    // "image" | "pdf"
    kind: text("kind").notNull(),
    mime: text("mime").notNull(),
    originalName: text("original_name").notNull(),
    storedName: text("stored_name").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    // Deleted uploads keep their row (file removed) so the daily upload count holds.
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("media_user").on(t.userId, t.createdAt),
    index("media_post").on(t.postId),
    index("media_comment").on(t.commentId),
  ]
);

// One-time codes emailed to prove mailbox ownership (activation, password reset).
export const emailCodes = pgTable(
  "email_codes",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    // "claim" | "reset"
    purpose: text("purpose").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("email_codes_user").on(t.userId, t.purpose)]
);

// Small key/value store for one-time jobs (e.g. the launch bootstrap).
export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const discussionComments = pgTable(
  "discussion_comments",
  {
    id: serial("id").primaryKey(),
    postId: integer("post_id")
      .notNull()
      .references(() => discussionPosts.id),
    parentId: integer("parent_id").references(
      (): AnyPgColumn => discussionComments.id
    ),
    authorUserId: integer("author_user_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    score: integer("score").notNull().default(0),
    deleted: boolean("deleted").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("discussion_comments_post").on(t.postId)]
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type WallPost = typeof wallPosts.$inferSelect;
export type Board = typeof boards.$inferSelect;
export type DiscussionPost = typeof discussionPosts.$inferSelect;
export type DiscussionComment = typeof discussionComments.$inferSelect;
export type Media = typeof media.$inferSelect;
