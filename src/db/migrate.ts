import { sql } from "drizzle-orm";
import { db } from "./index.js";

// Idempotent schema bootstrap, run on every server start.
// Railway deploys don't run `drizzle-kit push`, so every table/column the app
// needs is created here with IF NOT EXISTS. Constraint names follow
// drizzle-kit's conventions so `npm run db:push` stays a no-op afterwards.
const statements = [
  `CREATE TABLE IF NOT EXISTS users (
    id serial PRIMARY KEY,
    email text NOT NULL,
    password_hash text NOT NULL,
    name text NOT NULL,
    sex text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'Student',
    school text NOT NULL DEFAULT 'QAIRU',
    residence text NOT NULL DEFAULT '',
    birthday text NOT NULL DEFAULT '',
    hometown text NOT NULL DEFAULT '',
    high_school text NOT NULL DEFAULT '',
    screenname text NOT NULL DEFAULT '',
    mobile text NOT NULL DEFAULT '',
    website text NOT NULL DEFAULT '',
    courses text NOT NULL DEFAULT '',
    interests text NOT NULL DEFAULT '',
    music text NOT NULL DEFAULT '',
    books text NOT NULL DEFAULT '',
    about_me text NOT NULL DEFAULT '',
    photo_path text,
    class_year text NOT NULL DEFAULT '',
    privacy text NOT NULL DEFAULT 'network',
    member_since timestamp NOT NULL DEFAULT now(),
    last_update timestamp NOT NULL DEFAULT now(),
    CONSTRAINT users_email_unique UNIQUE (email)
  )`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS rep integer NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code text`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_user_id integer`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code ON users (referral_code)`,

  `CREATE TABLE IF NOT EXISTS friendships (
    id serial PRIMARY KEY,
    from_user_id integer NOT NULL,
    to_user_id integer NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS friendship_pair ON friendships (from_user_id, to_user_id)`,

  `CREATE TABLE IF NOT EXISTS pokes (
    id serial PRIMARY KEY,
    from_user_id integer NOT NULL,
    to_user_id integer NOT NULL,
    seen boolean NOT NULL DEFAULT false,
    created_at timestamp NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS messages (
    id serial PRIMARY KEY,
    from_user_id integer NOT NULL,
    to_user_id integer NOT NULL,
    subject text NOT NULL DEFAULT '(no subject)',
    body text NOT NULL,
    read boolean NOT NULL DEFAULT false,
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS messages_pair ON messages (from_user_id, to_user_id, id)`,

  `CREATE TABLE IF NOT EXISTS wall_posts (
    id serial PRIMARY KEY,
    profile_user_id integer NOT NULL,
    author_user_id integer NOT NULL,
    body text NOT NULL,
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE wall_posts ADD COLUMN IF NOT EXISTS parent_id integer`,
  `ALTER TABLE wall_posts ADD COLUMN IF NOT EXISTS score integer NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS wall_posts_profile ON wall_posts (profile_user_id)`,

  `CREATE TABLE IF NOT EXISTS invites (
    id serial PRIMARY KEY,
    from_user_id integer NOT NULL,
    email text NOT NULL DEFAULT '',
    token text NOT NULL,
    used_by_user_id integer,
    used_at timestamp,
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS invite_token ON invites (token)`,

  `CREATE TABLE IF NOT EXISTS board_events (
    id serial PRIMARY KEY,
    actor_user_id integer NOT NULL,
    target_user_id integer,
    kind text NOT NULL,
    detail text NOT NULL DEFAULT '',
    created_at timestamp NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS votes (
    id serial PRIMARY KEY,
    user_id integer NOT NULL,
    target_type text NOT NULL,
    target_id integer NOT NULL,
    value integer NOT NULL,
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS votes_unique ON votes (user_id, target_type, target_id)`,

  `CREATE TABLE IF NOT EXISTS rep_events (
    id serial PRIMARY KEY,
    user_id integer NOT NULL,
    amount integer NOT NULL,
    reason text NOT NULL,
    source_type text NOT NULL DEFAULT '',
    source_id integer,
    actor_user_id integer,
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS rep_events_user ON rep_events (user_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS boards (
    id serial PRIMARY KEY,
    slug text NOT NULL,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    created_by_user_id integer,
    created_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT boards_slug_unique UNIQUE (slug)
  )`,

  `CREATE TABLE IF NOT EXISTS discussion_posts (
    id serial PRIMARY KEY,
    board_id integer NOT NULL,
    author_user_id integer NOT NULL,
    title text NOT NULL,
    body text NOT NULL DEFAULT '',
    url text NOT NULL DEFAULT '',
    score integer NOT NULL DEFAULT 0,
    comment_count integer NOT NULL DEFAULT 0,
    deleted boolean NOT NULL DEFAULT false,
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS discussion_posts_board ON discussion_posts (board_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS discussion_comments (
    id serial PRIMARY KEY,
    post_id integer NOT NULL,
    parent_id integer,
    author_user_id integer NOT NULL,
    body text NOT NULL,
    score integer NOT NULL DEFAULT 0,
    deleted boolean NOT NULL DEFAULT false,
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS discussion_comments_post ON discussion_comments (post_id)`,
];

// [table, column, referenced table, on delete]
const foreignKeys: [string, string, string, string?][] = [
  ["users", "referred_by_user_id", "users"],
  ["friendships", "from_user_id", "users"],
  ["friendships", "to_user_id", "users"],
  ["pokes", "from_user_id", "users"],
  ["pokes", "to_user_id", "users"],
  ["messages", "from_user_id", "users"],
  ["messages", "to_user_id", "users"],
  ["wall_posts", "profile_user_id", "users"],
  ["wall_posts", "author_user_id", "users"],
  ["wall_posts", "parent_id", "wall_posts", "cascade"],
  ["invites", "from_user_id", "users"],
  ["invites", "used_by_user_id", "users"],
  ["board_events", "actor_user_id", "users"],
  ["board_events", "target_user_id", "users"],
  ["votes", "user_id", "users"],
  ["rep_events", "user_id", "users"],
  ["rep_events", "actor_user_id", "users"],
  ["boards", "created_by_user_id", "users"],
  ["discussion_posts", "board_id", "boards"],
  ["discussion_posts", "author_user_id", "users"],
  ["discussion_comments", "post_id", "discussion_posts"],
  ["discussion_comments", "parent_id", "discussion_comments"],
  ["discussion_comments", "author_user_id", "users"],
];

export const DEFAULT_BOARDS: [string, string, string][] = [
  ["general", "General", "Anything and everything QAIRU."],
  ["courses", "Courses", "Homework help, study groups, which prof to take."],
  ["housing", "Housing", "Dorms, roommates, apartments in Astana."],
  ["events", "Events", "AI Fridays, hackathons, parties, meetups."],
  ["marketplace", "Marketplace", "Buy, sell and trade textbooks and stuff."],
  ["memes", "Memes", "Shitposting, but make it academic."],
  ["ask", "Ask QAIRU", "Questions for upperclassmen, faculty and staff."],
];

export async function ensureSchema() {
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }

  for (const [table, column, ref, onDelete] of foreignKeys) {
    const name = `${table}_${column}_${ref}_id_fk`;
    await db.execute(
      sql.raw(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
          ALTER TABLE ${table} ADD CONSTRAINT ${name} FOREIGN KEY (${column})
            REFERENCES ${ref}(id) ON DELETE ${onDelete ?? "no action"};
        END IF;
      END $$`)
    );
  }

  // Everyone gets a permanent personal referral code.
  await db.execute(
    sql.raw(`UPDATE users SET referral_code =
      coalesce(nullif(lower(regexp_replace(split_part(name, ' ', 1), '[^a-zA-Z0-9]', '', 'g')), ''), 'qairu')
      || '-' || substr(md5(random()::text || id::text), 1, 5)
      WHERE referral_code IS NULL`)
  );

  for (const [slug, name, description] of DEFAULT_BOARDS) {
    await db.execute(
      sql`INSERT INTO boards (slug, name, description) VALUES (${slug}, ${name}, ${description})
          ON CONFLICT (slug) DO NOTHING`
    );
  }
}
