import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
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
  memberSince: timestamp("member_since").notNull().defaultNow(),
  lastUpdate: timestamp("last_update").notNull().defaultNow(),
});

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

export const messages = pgTable("messages", {
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
});

export const wallPosts = pgTable("wall_posts", {
  id: serial("id").primaryKey(),
  profileUserId: integer("profile_user_id")
    .notNull()
    .references(() => users.id),
  authorUserId: integer("author_user_id")
    .notNull()
    .references(() => users.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
