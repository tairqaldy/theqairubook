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

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
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
  (t) => [index("rep_events_user").on(t.userId, t.createdAt)]
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
    deleted: boolean("deleted").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("discussion_posts_board").on(t.boardId, t.createdAt)]
);

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
