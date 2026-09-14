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
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS native_name text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS headline text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS looking_for text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS clubs text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS github text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS instagram text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS linkedin text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS claim_locked boolean NOT NULL DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at timestamp`,
  // Accounts that existed before pre-created accounts were a thing are activated.
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'users'
                     AND column_name = 'claimed_at') THEN
      ALTER TABLE users ADD COLUMN claimed_at timestamp;
      UPDATE users SET claimed_at = member_since WHERE password_hash <> '';
    END IF;
  END $$`,

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
  `ALTER TABLE discussion_posts ADD COLUMN IF NOT EXISTS flair text NOT NULL DEFAULT 'discussion'`,
  `ALTER TABLE discussion_posts ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false`,
  `ALTER TABLE discussion_posts ADD COLUMN IF NOT EXISTS accepted_comment_id integer`,

  `CREATE TABLE IF NOT EXISTS saved_posts (
    id serial PRIMARY KEY,
    user_id integer NOT NULL,
    post_id integer NOT NULL,
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS saved_posts_unique ON saved_posts (user_id, post_id)`,

  `CREATE TABLE IF NOT EXISTS media (
    id serial PRIMARY KEY,
    user_id integer NOT NULL,
    post_id integer,
    comment_id integer,
    kind text NOT NULL,
    mime text NOT NULL,
    original_name text NOT NULL,
    stored_name text NOT NULL,
    size_bytes integer NOT NULL,
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS media_user ON media (user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS media_post ON media (post_id)`,
  `CREATE INDEX IF NOT EXISTS media_comment ON media (comment_id)`,
  `ALTER TABLE media ADD COLUMN IF NOT EXISTS deleted_at timestamp`,

  `CREATE TABLE IF NOT EXISTS email_codes (
    id serial PRIMARY KEY,
    user_id integer NOT NULL,
    purpose text NOT NULL,
    code_hash text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    expires_at timestamp NOT NULL,
    consumed_at timestamp,
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS email_codes_user ON email_codes (user_id, purpose)`,

  // Once-only rep: a reply bonus per (author, thing, replier) and one referral per new member.
  // Wrapped so an older database with historical duplicates still boots.
  `DO $$ BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS rep_events_reply_once
      ON rep_events (user_id, source_type, source_id, actor_user_id) WHERE reason = 'reply';
  EXCEPTION WHEN others THEN RAISE NOTICE 'rep_events_reply_once skipped: %', SQLERRM;
  END $$`,
  `DO $$ BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS rep_events_referral_once
      ON rep_events (source_id) WHERE reason = 'referral';
  EXCEPTION WHEN others THEN RAISE NOTICE 'rep_events_referral_once skipped: %', SQLERRM;
  END $$`,

  `CREATE TABLE IF NOT EXISTS app_meta (
    key text PRIMARY KEY,
    value text NOT NULL DEFAULT '',
    updated_at timestamp NOT NULL DEFAULT now()
  )`,
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
  ["saved_posts", "user_id", "users"],
  ["saved_posts", "post_id", "discussion_posts"],
  ["media", "user_id", "users"],
  ["media", "post_id", "discussion_posts"],
  ["media", "comment_id", "discussion_comments"],
  ["email_codes", "user_id", "users"],
];

export const DEFAULT_BOARDS: [string, string, string][] = [
  ["general", "General", "Anything and everything QAIRU."],
  ["homework", "Homework Help", "Stuck on an assignment? Ask here — and help others when you can."],
  ["coding", "Coding & Dev", "Code, bugs, tools, stacks, side projects."],
  ["materials", "Study Materials", "Notes, cheat sheets, past papers, useful links and PDFs."],
  ["courses", "Courses", "Which course, which prof, study groups."],
  ["projects", "Projects & Hackathons", "Show what you're building. Find teammates."],
  ["career", "Internships & Career", "Internships, CVs, interviews, opportunities."],
  ["events", "Events", "Meetups, AI Fridays, hackathons, parties."],
  ["ask", "Ask Anything", "Campus life, admin stuff, where-is-what."],
  ["housing", "Housing", "Dorms, roommates, apartments in Astana."],
  ["marketplace", "Marketplace", "Buy, sell and trade textbooks and stuff."],
  ["memes", "Memes & Off-topic", "Shitposting, but make it academic."],
];

export async function ensureSchema() {
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }

  for (const [table, column, ref, onDelete] of foreignKeys) {
    const name = `${table}_${column}_${ref}_id_fk`;
    await db.execute(
      sql.raw(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conname = '${name}' AND conrelid = 'public.${table}'::regclass) THEN
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
