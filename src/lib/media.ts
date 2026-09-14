import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { db } from "../db/index.js";
import { media, type Media } from "../db/schema.js";

const MB = 1024 * 1024;
const envMb = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n * MB : fallback * MB;
};

/** Upload limits. Override with env vars (in MB / counts) if needed. */
export const MEDIA_LIMITS = {
  imageBytes: envMb("MEDIA_MAX_IMAGE_MB", 5),
  pdfBytes: envMb("MEDIA_MAX_PDF_MB", 10),
  userQuotaBytes: envMb("MEDIA_USER_QUOTA_MB", 50),
  globalBytes: envMb("MEDIA_GLOBAL_CAP_MB", 3000),
  dailyUploads: Number(process.env.MEDIA_DAILY_UPLOADS) || 20,
  filesPerPost: 4,
  filesPerComment: 2,
};

export const MEDIA_ACCEPT = "image/jpeg,image/png,image/gif,image/webp,application/pdf";

type Sniffed = { kind: "image" | "pdf"; mime: string; ext: string };

/** Identify a file by its first bytes. Extensions and browser MIME types lie. */
export function sniff(bytes: Uint8Array): Sniffed | null {
  const b = bytes;
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (b.length >= 3 && starts(0xff, 0xd8, 0xff)) return { kind: "image", mime: "image/jpeg", ext: ".jpg" };
  if (b.length >= 8 && starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return { kind: "image", mime: "image/png", ext: ".png" };
  if (b.length >= 6 && (starts(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || starts(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)))
    return { kind: "image", mime: "image/gif", ext: ".gif" };
  if (
    b.length >= 12 &&
    starts(0x52, 0x49, 0x46, 0x46) &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return { kind: "image", mime: "image/webp", ext: ".webp" };
  if (b.length >= 5 && starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return { kind: "pdf", mime: "application/pdf", ext: ".pdf" };
  return null;
}

/** Non-empty uploaded files from a parsed multipart body field. */
export function filesFromBody(body: Record<string, unknown>, field = "files"): File[] {
  const raw = body[field] ?? body[`${field}[]`];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.filter(
    (f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f && (f as File).size > 0
  );
}

export type PreparedUpload = { file: File; bytes: Buffer; sniffed: Sniffed; name: string };

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
}

function cleanName(name: string, ext: string): string {
  const base = path
    .basename(name || "file")
    .replace(/\.[^.]*$/, "")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "")
    .trim()
    .slice(0, 80);
  return `${base || "file"}${ext}`;
}

/** Storage in use (live files) and uploads in the last 24h (deleted ones still count). */
export async function mediaUsage(userId: number) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({
      bytes: sql<number>`coalesce(sum(${media.sizeBytes}) filter (where ${media.deletedAt} is null), 0)::bigint`,
      today: sql<number>`count(*) filter (where ${media.createdAt} >= ${since.toISOString()}::timestamp)::int`,
    })
    .from(media)
    .where(eq(media.userId, userId));
  return { bytes: Number(row?.bytes ?? 0), today: Number(row?.today ?? 0) };
}

async function globalUsage(): Promise<number> {
  const [row] = await db
    .select({ bytes: sql<number>`coalesce(sum(${media.sizeBytes}), 0)::bigint` })
    .from(media)
    .where(isNull(media.deletedAt));
  return Number(row?.bytes ?? 0);
}

const uploadLocks = new Map<number, Promise<unknown>>();

/**
 * Runs validate → create post/comment → store for one user at a time, so
 * parallel requests can't each pass the quota check and overshoot it.
 */
export async function withUploadLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const previous = uploadLocks.get(userId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  uploadLocks.set(userId, tail);
  try {
    return await run;
  } finally {
    if (uploadLocks.get(userId) === tail) uploadLocks.delete(userId);
  }
}

/**
 * Validates files against type, size, per-user quota, daily count and the
 * global storage cap — without writing anything. Returns a user-facing error.
 */
export async function prepareUploads(
  userId: number,
  files: File[],
  maxFiles: number
): Promise<{ prepared: PreparedUpload[]; error: string | null }> {
  if (!files.length) return { prepared: [], error: null };
  if (files.length > maxFiles) {
    return { prepared: [], error: `You can attach up to ${maxFiles} file${maxFiles === 1 ? "" : "s"}.` };
  }

  const prepared: PreparedUpload[] = [];
  for (const file of files) {
    if (file.size > Math.max(MEDIA_LIMITS.imageBytes, MEDIA_LIMITS.pdfBytes)) {
      return { prepared: [], error: `"${file.name}" is too large.` };
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const sniffed = sniff(bytes);
    if (!sniffed) {
      return { prepared: [], error: `"${file.name}" isn't a supported file. Use JPG, PNG, GIF, WEBP or PDF.` };
    }
    const cap = sniffed.kind === "pdf" ? MEDIA_LIMITS.pdfBytes : MEDIA_LIMITS.imageBytes;
    if (bytes.length > cap) {
      return {
        prepared: [],
        error: `"${file.name}" is ${formatBytes(bytes.length)} — ${sniffed.kind === "pdf" ? "PDFs" : "images"} can be up to ${formatBytes(cap)}.`,
      };
    }
    prepared.push({ file, bytes, sniffed, name: cleanName(file.name, sniffed.ext) });
  }

  const incoming = prepared.reduce((sum, p) => sum + p.bytes.length, 0);
  const usage = await mediaUsage(userId);
  if (usage.today + prepared.length > MEDIA_LIMITS.dailyUploads) {
    return { prepared: [], error: `Daily upload limit reached (${MEDIA_LIMITS.dailyUploads} files per 24 hours). Try again tomorrow.` };
  }
  if (usage.bytes + incoming > MEDIA_LIMITS.userQuotaBytes) {
    return {
      prepared: [],
      error: `That would exceed your ${formatBytes(MEDIA_LIMITS.userQuotaBytes)} storage (you've used ${formatBytes(usage.bytes)}). Delete old attachments or upload smaller files.`,
    };
  }
  if ((await globalUsage()) + incoming > MEDIA_LIMITS.globalBytes) {
    return { prepared: [], error: "Uploads are paused — theqairubook's storage is full. Please tell an admin." };
  }
  return { prepared, error: null };
}

function mediaDir() {
  return path.join(process.env.UPLOAD_DIR ?? "./uploads", "media");
}

export function mediaPath(row: Pick<Media, "userId" | "storedName">): string {
  return path.join(mediaDir(), String(row.userId), row.storedName);
}

export async function storeUploads(
  userId: number,
  prepared: PreparedUpload[],
  attach: { postId?: number; commentId?: number }
): Promise<Media[]> {
  if (!prepared.length) return [];
  await mkdir(path.join(mediaDir(), String(userId)), { recursive: true });
  const rows: Media[] = [];
  for (const p of prepared) {
    const storedName = `${randomBytes(12).toString("hex")}${p.sniffed.ext}`;
    await writeFile(path.join(mediaDir(), String(userId), storedName), p.bytes);
    const [row] = await db
      .insert(media)
      .values({
        userId,
        postId: attach.postId ?? null,
        commentId: attach.commentId ?? null,
        kind: p.sniffed.kind,
        mime: p.sniffed.mime,
        originalName: p.name,
        storedName,
        sizeBytes: p.bytes.length,
      })
      .returning();
    rows.push(row);
  }
  return rows;
}

async function groupBy(column: typeof media.postId | typeof media.commentId, ids: number[]) {
  const map = new Map<number, Media[]>();
  if (!ids.length) return map;
  const rows = await db
    .select()
    .from(media)
    .where(and(inArray(column, ids), isNull(media.deletedAt)))
    .orderBy(media.id);
  for (const row of rows) {
    const key = (column === media.postId ? row.postId : row.commentId) as number;
    map.set(key, [...(map.get(key) ?? []), row]);
  }
  return map;
}

export const mediaForPosts = (ids: number[]) => groupBy(media.postId, ids);
export const mediaForComments = (ids: number[]) => groupBy(media.commentId, ids);

/**
 * Removes the files and marks the rows deleted: storage quota is freed, but the
 * rows still count towards the 24h upload limit.
 */
export async function deleteMedia(rows: Media[]) {
  const live = rows.filter((r) => !r.deletedAt);
  for (const row of live) {
    await unlink(mediaPath(row)).catch(() => {});
  }
  if (live.length) {
    await db
      .update(media)
      .set({ deletedAt: new Date() })
      .where(inArray(media.id, live.map((r) => r.id)));
  }
}

export async function deleteMediaForPost(postId: number) {
  await deleteMedia(await db.select().from(media).where(eq(media.postId, postId)));
}

export async function deleteMediaForComment(commentId: number) {
  await deleteMedia(await db.select().from(media).where(eq(media.commentId, commentId)));
}

/** A user's live uploads, newest first (for the "My uploads" list). */
export async function mediaForUser(userId: number, limit = 100): Promise<Media[]> {
  return db
    .select()
    .from(media)
    .where(and(eq(media.userId, userId), isNull(media.deletedAt)))
    .orderBy(desc(media.createdAt))
    .limit(limit);
}

export function mediaUrl(row: Pick<Media, "id" | "originalName">): string {
  return `/media/${row.id}/${encodeURIComponent(row.originalName)}`;
}
