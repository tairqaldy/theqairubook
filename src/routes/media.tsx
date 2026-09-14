import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { AppEnv } from "../middleware/auth.js";
import { isAdmin, needLogin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { discussionComments, discussionPosts, media } from "../db/schema.js";
import { deleteMedia, mediaPath } from "../lib/media.js";
import { backPath } from "../lib/url.js";

export const mediaRoutes = new Hono<AppEnv>();

async function attachmentVisible(row: typeof media.$inferSelect): Promise<boolean> {
  if (row.postId) {
    const [post] = await db
      .select({ deleted: discussionPosts.deleted })
      .from(discussionPosts)
      .where(eq(discussionPosts.id, row.postId))
      .limit(1);
    return Boolean(post && !post.deleted);
  }
  if (row.commentId) {
    const [comment] = await db
      .select({ deleted: discussionComments.deleted })
      .from(discussionComments)
      .where(eq(discussionComments.id, row.commentId))
      .limit(1);
    return Boolean(comment && !comment.deleted);
  }
  return false;
}

// Attachments are members-only, like the rest of the network.
mediaRoutes.get("/media/:id{[0-9]+}/:name?", async (c) => {
  const user = c.get("user");
  if (!user) return c.text("Log in to view attachments.", 401);

  const [row] = await db
    .select()
    .from(media)
    .where(eq(media.id, Number(c.req.param("id"))))
    .limit(1);
  if (!row || row.deletedAt || !(await attachmentVisible(row))) return c.notFound();

  const file = mediaPath(row);
  const info = await stat(file).catch(() => null);
  if (!info) return c.notFound();

  const encoded = encodeURIComponent(row.originalName);
  const headers: Record<string, string> = {
    "Content-Type": row.mime,
    "Content-Length": String(info.size),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=86400",
    "Content-Disposition": `${c.req.query("download") ? "attachment" : "inline"}; filename*=UTF-8''${encoded}`,
  };
  // Images can't run anything anyway; lock them down further just in case.
  if (row.kind === "image") headers["Content-Security-Policy"] = "default-src 'none'; sandbox";

  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(stream, { status: 200, headers });
});

mediaRoutes.post("/media/:id{[0-9]+}/delete", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const [row] = await db
    .select()
    .from(media)
    .where(eq(media.id, Number(c.req.param("id"))))
    .limit(1);
  if (row && (row.userId === gate.user.id || isAdmin(gate.user))) {
    await deleteMedia([row]);
  }
  return c.redirect(backPath(c, "/account#uploads"));
});
