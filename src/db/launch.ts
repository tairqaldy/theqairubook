import { readFile } from "node:fs/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./index.js";
import { appMeta, boards, discussionPosts, users } from "./schema.js";
import { ensureSchema } from "./migrate.js";
import { importStudents, type StudentRow } from "./students.js";
import { addBoardEvent } from "../lib/social.js";

// One-time launch job, run at every boot right after ensureSchema(). It reads
// a private file (never committed), archives the pre-launch data, imports the
// student list, promotes admins and pins the welcome announcement. A marker in
// app_meta makes it a no-op on every later boot.

type LaunchFile = {
  launchId: string;
  archiveExisting?: boolean;
  students: StudentRow[];
  admins?: string[];
  displayNames?: Record<string, string>;
  announcement?: {
    authorEmail: string;
    board?: string;
    title?: string;
    body?: string;
  };
};

// Every app table, in the order they were introduced. Moved, never dropped.
const APP_TABLES = [
  "users",
  "friendships",
  "pokes",
  "messages",
  "wall_posts",
  "invites",
  "board_events",
  "votes",
  "rep_events",
  "boards",
  "discussion_posts",
  "discussion_comments",
  "saved_posts",
  "media",
  "email_codes",
  "app_meta",
];

export const DEFAULT_ANNOUNCEMENT = {
  title: "theqairubook is live — welcome, QAIRU 👋",
  body: `Hi everyone!

theqairubook is a calm little student network just for QAIRU — built in the style of the original 2004 thefacebook. It's a QairuHub passion project, made by a student, for students.

What it's for: talking about whatever topics you care about, getting and giving homework help, asking and answering questions, sharing notes, PDFs and materials for coding, development and study — and simply meeting people. Fill in your profile, decorate it, add friends and chat.

Anyone can start their own discussions and topics on the boards. There is no feed, no algorithm and no ads. Nothing disappears after 24 hours — everything stays saved, so good answers stay useful.

How to start:
1. Fill in your profile so classmates know who you are.
2. Find your classmates — everyone on the student list already has a spot here, even if they haven't joined yet.
3. Send friend requests, and share your invite link with people who haven't joined.
4. Post in Homework Help, Coding & Dev or Study Materials — or just say hi below.

Rep is simple: you earn it when people upvote your posts, reply to you, accept your answer, or join through your invite link.

The vibe: be kind, be useful, keep it low-dopamine. This is a place to learn and help each other, not to scroll.

Found a bug or have an idea? Reply here or message me directly.

— Tair

────────────────────

Всем привет!

theqairubook — это спокойная студенческая сеть только для QAIRU, сделанная в стиле самого первого thefacebook 2004 года. Это passion-проект QairuHub, сделанный студентом для студентов.

Для чего она: обсуждать темы, которые вам интересны, получать и давать помощь с домашкой, задавать вопросы и отвечать на них, делиться конспектами, PDF и материалами по программированию, разработке и учёбе — и просто знакомиться. Заполните профиль, оформите его, добавляйте друзей и общайтесь в чате.

Каждый может создавать свои обсуждения и темы на досках. Здесь нет ленты, алгоритмов и рекламы. Ничего не исчезает через 24 часа — всё сохраняется, так что хорошие ответы остаются полезными.

С чего начать:
1. Заполните профиль, чтобы одногруппники знали, кто вы.
2. Найдите одногруппников — у каждого из списка студентов уже есть место здесь, даже если он ещё не присоединился.
3. Отправляйте запросы в друзья и делитесь своей ссылкой-приглашением с теми, кто ещё не присоединился.
4. Пишите в Homework Help, Coding & Dev или Study Materials — или просто поздоровайтесь ниже.

Rep — это просто: вы получаете его, когда ваши посты апвоутят, вам отвечают, ваш ответ отмечают как принятый или кто-то присоединяется по вашей ссылке.

Атмосфера: будьте добрыми, полезными и спокойными. Это место, чтобы учиться и помогать друг другу, а не бесконечно листать.

Нашли баг или есть идея? Ответьте здесь или напишите мне в личные сообщения.

— Таир`,
};

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[ launch ] step "${name}" failed:`, err);
    throw err;
  }
}

function archiveSchemaName(launchId: string): string {
  return `archive_${launchId.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`.slice(0, 63);
}

async function readLaunchFile(): Promise<LaunchFile | null> {
  const path = process.env.LAUNCH_FILE ?? "./private/launch.json";
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let data: LaunchFile;
  try {
    data = JSON.parse(text.replace(/^﻿/, "")) as LaunchFile;
  } catch {
    // Not rethrowing the parser's message: it can quote file contents (emails).
    throw new Error("launch file: invalid JSON");
  }
  if (!data || typeof data.launchId !== "string" || !data.launchId.trim()) {
    throw new Error("launch file: launchId is required");
  }
  if (!Array.isArray(data.students)) {
    throw new Error("launch file: students must be an array");
  }
  return data;
}

/** Moves every existing app table into archive_<launchId>. Returns the schema or null. */
async function archiveExisting(launchId: string): Promise<string | null> {
  const schema = archiveSchemaName(launchId);

  // A previous boot already archived for this launch but crashed before the
  // marker was written: resume on the fresh tables instead of archiving twice.
  const already = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM information_schema.tables
     WHERE table_schema = ${schema} AND table_name = 'users'`);
  if (Number(already[0]?.n ?? 0) > 0) {
    await advanceSequences(schema);
    return schema;
  }

  const present = await db.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN (${sql.join(APP_TABLES.map((t) => sql`${t}`), sql`, `)})`);
  const tables = new Set(present.map((r) => r.table_name));
  if (!tables.has("users")) return null;

  const [{ n }] = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM (SELECT 1 FROM public.users LIMIT 1) t`
  );
  if (Number(n) === 0) return null;

  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${schema}"`));
    for (const table of APP_TABLES) {
      if (!tables.has(table)) continue;
      await tx.execute(sql.raw(`ALTER TABLE public."${table}" SET SCHEMA "${schema}"`));
    }
  });
  await ensureSchema();
  await advanceSequences(schema);
  return schema;
}

/**
 * The recreated tables get fresh sequences starting at 1. Ids are baked into
 * session cookies and signed invite links, so reusing them would let a
 * pre-launch cookie for user #7 authenticate as the new student #7. Start
 * every new sequence well past the archived maximum instead.
 */
async function advanceSequences(schema: string) {
  const archived = await db.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = ${schema} AND column_name = 'id'
       AND table_name IN (${sql.join(APP_TABLES.map((t) => sql`${t}`), sql`, `)})`);
  for (const { table_name: table } of archived) {
    await db.execute(
      sql.raw(`SELECT setval(
        pg_get_serial_sequence('public."${table}"', 'id'),
        GREATEST(
          (SELECT COALESCE(max(id), 0) FROM "${schema}"."${table}") + 1001,
          (SELECT COALESCE(max(id), 0) + 1 FROM public."${table}")
        ),
        false)`)
    );
  }
}

export async function runLaunchBootstrap(): Promise<void> {
  const file = await step("read file", readLaunchFile);
  if (!file) return;

  const markerKey = `launch:${file.launchId}`;
  const done = await step("check marker", () =>
    db.select({ key: appMeta.key }).from(appMeta).where(eq(appMeta.key, markerKey)).limit(1)
  );
  if (done.length) return;

  const archivedTo = file.archiveExisting
    ? await step("archive", () => archiveExisting(file.launchId))
    : null;

  const imported = await step("import students", () => importStudents(file.students));

  const adminEmails = (file.admins ?? [])
    .filter((e): e is string => typeof e === "string")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const admins = await step("admins", async () => {
    if (!adminEmails.length) return 0;
    const rows = await db
      .update(users)
      .set({ role: "admin" })
      .where(inArray(users.email, adminEmails))
      .returning({ id: users.id });
    return rows.length;
  });

  const renamed = await step("display names", async () => {
    let count = 0;
    for (const [email, rawName] of Object.entries(file.displayNames ?? {})) {
      const name = typeof rawName === "string" ? rawName.replace(/\s+/g, " ").trim() : "";
      if (name.length < 2 || name.length > 80) continue;
      const rows = await db
        .update(users)
        .set({ name })
        .where(eq(users.email, email.trim().toLowerCase()))
        .returning({ id: users.id });
      count += rows.length;
    }
    return count;
  });

  const announcementPostId = await step("announcement", async () => {
    const a = file.announcement;
    if (!a) return null;
    const [author] = await db
      .select()
      .from(users)
      .where(eq(users.email, String(a.authorEmail ?? "").trim().toLowerCase()))
      .limit(1);
    if (!author) throw new Error("announcement author is not on the student list");
    const slug = (a.board ?? "general").trim().toLowerCase();
    const [board] = await db.select().from(boards).where(eq(boards.slug, slug)).limit(1);
    if (!board) throw new Error("announcement board does not exist");
    const title = a.title?.trim() || DEFAULT_ANNOUNCEMENT.title;
    const body = a.body?.trim() || DEFAULT_ANNOUNCEMENT.body;

    // Don't pin a second copy if an earlier boot got this far.
    const [existing] = await db
      .select({ id: discussionPosts.id })
      .from(discussionPosts)
      .where(
        and(
          eq(discussionPosts.authorUserId, author.id),
          eq(discussionPosts.boardId, board.id),
          eq(discussionPosts.flair, "announcement"),
          eq(discussionPosts.title, title)
        )
      )
      .limit(1);
    if (existing) return existing.id;

    const [post] = await db
      .insert(discussionPosts)
      .values({
        boardId: board.id,
        authorUserId: author.id,
        title,
        body,
        flair: "announcement",
        pinned: true,
      })
      .returning();
    await addBoardEvent(
      author.id,
      "discussion",
      JSON.stringify({ postId: post.id, slug: board.slug, title: post.title })
    );
    return post.id;
  });

  const summary = {
    archivedTo,
    created: imported.created,
    updated: imported.updated,
    admins,
    announcementPostId,
    at: new Date().toISOString(),
  };
  await step("write marker", () =>
    db
      .insert(appMeta)
      .values({ key: markerKey, value: JSON.stringify(summary) })
      .onConflictDoNothing()
  );

  console.log(
    `[ launch ] ${file.launchId}: archived=${archivedTo ?? "no"} created=${imported.created} ` +
      `updated=${imported.updated} skippedActivated=${imported.skippedActivated} ` +
      `invalid=${imported.invalid.length} admins=${admins} renamed=${renamed} ` +
      `announcement=${announcementPostId ?? "none"}`
  );
}
