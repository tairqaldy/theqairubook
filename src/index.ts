import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { mkdir } from "node:fs/promises";
import type { AppEnv } from "./middleware/auth.js";
import { loadUser } from "./middleware/auth.js";
import { publicOrigin } from "./lib/url.js";
import { ensureSchema } from "./db/migrate.js";
import { runLaunchBootstrap } from "./db/launch.js";
import { publicRoutes } from "./routes/public.js";
import { authRoutes } from "./routes/auth.js";
import { profileRoutes } from "./routes/profile.js";
import { socialRoutes } from "./routes/social.js";
import { searchRoutes } from "./routes/search.js";
import { boardRoutes } from "./routes/board.js";
import { messageRoutes } from "./routes/messages.js";
import { discussRoutes } from "./routes/discuss.js";
import { repRoutes } from "./routes/rep.js";
import { mediaRoutes } from "./routes/media.js";
import { adminRoutes } from "./routes/admin.js";

const uploadDir = process.env.UPLOAD_DIR ?? "./uploads";
await mkdir(uploadDir, { recursive: true });
await ensureSchema();
await runLaunchBootstrap();

const app = new Hono<AppEnv>();

app.get("/healthz", (c) => c.text("ok"));

// Send visitors on the Railway domain to the real one (opt-in, once DNS works).
const publicUrl = process.env.PUBLIC_URL?.trim().replace(/\/+$/, "");
if (publicUrl && process.env.REDIRECT_TO_PUBLIC_URL === "1") {
  const canonicalHost = new URL(publicUrl).host;
  app.use("*", async (c, next) => {
    const host = c.req.header("x-forwarded-host") || c.req.header("host");
    if (host && host !== canonicalHost) {
      const url = new URL(c.req.url);
      return c.redirect(`${publicUrl}${url.pathname}${url.search}`, 301);
    }
    await next();
  });
}

app.use(
  "*",
  secureHeaders({
    referrerPolicy: "strict-origin-when-cross-origin",
    xFrameOptions: "DENY",
    crossOriginResourcePolicy: "same-origin",
    crossOriginOpenerPolicy: "same-origin",
  })
);

// Only the logged-in upload forms accept big bodies (4 × 10 MB); everything else stays small.
const tooLarge = bodyLimit({
  maxSize: 45 * 1024 * 1024,
  onError: (c) => c.text("That upload is too large.", 413),
});
const small = bodyLimit({
  maxSize: 1024 * 1024,
  onError: (c) => c.text("Request too large.", 413),
});
const UPLOAD_PATHS = [/^\/d\/submit$/, /^\/d\/[^/]+\/\d+\/comment$/, /^\/edit-profile$/];
app.use("*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  const isUpload = UPLOAD_PATHS.some((re) => re.test(c.req.path));
  return (isUpload ? tooLarge : small)(c, next);
});

// CSRF: SameSite=Lax cookies still ride along on POSTs from other *.qairuhub.com
// sites, so state-changing requests must come from this origin. Browsers always
// send Sec-Fetch-Site and/or Origin; requests with neither aren't from a victim's
// browser and can't carry a CSRF attack.
app.use("*", async (c, next) => {
  if (/^(GET|HEAD|OPTIONS)$/.test(c.req.method)) return next();
  const site = c.req.header("sec-fetch-site");
  const origin = c.req.header("origin");
  if (site === "same-origin") return next();
  if (origin) {
    const url = new URL(c.req.url);
    const host = c.req.header("x-forwarded-host") || c.req.header("host") || url.host;
    const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
    const allowed = new Set([`${proto}://${host}`, publicOrigin(c)]);
    if (allowed.has(origin)) return next();
    return c.text("Forbidden: cross-site request", 403);
  }
  if (site) return c.text("Forbidden: cross-site request", 403);
  return next();
});

app.use("/static/*", serveStatic({ root: "./src" }));
app.use("*", loadUser);
// Profile photos are members-only (file names are guessable).
app.use("/uploads/*", async (c, next) => {
  if (!c.get("user")) return c.text("Log in to view photos.", 401);
  if (c.req.path.startsWith("/uploads/media/")) return c.notFound();
  await next();
});
app.use(
  "/uploads/*",
  serveStatic({
    root: uploadDir,
    rewriteRequestPath: (path) => path.replace(/^\/uploads/, ""),
    onFound: (_path, c) => {
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Cache-Control", "private, max-age=3600");
    },
  })
);

app.route("/", publicRoutes);
app.route("/", authRoutes);
app.route("/", profileRoutes);
app.route("/", socialRoutes);
app.route("/", searchRoutes);
app.route("/", boardRoutes);
app.route("/", messageRoutes);
app.route("/", discussRoutes);
app.route("/", repRoutes);
app.route("/", mediaRoutes);
app.route("/", adminRoutes);

app.notFound((c) =>
  c.html(
    `<html><body style="font-family:Tahoma;font-size:11px;padding:20px">
      <h3 style="color:#3B5998">[ Page Not Found ]</h3>
      <p>That page does not exist on theqairubook.</p>
      <p><a href="/">Home</a></p>
    </body></html>`,
    404
  )
);

// Postgres errors caused by bad user input rather than bugs: out-of-range ids,
// invalid text (e.g. NUL bytes), malformed numbers, over-long values.
const BAD_INPUT_CODES = new Set(["22003", "22021", "22P02", "22001", "54000"]);

app.onError((err, c) => {
  const code = (err as { code?: string }).code;
  if ((code && BAD_INPUT_CODES.has(code)) || err instanceof URIError) {
    return c.html(
      `<html><body style="font-family:Tahoma;font-size:11px;padding:20px">
        <h3 style="color:#3B5998">[ Bad Request ]</h3>
        <p>Something in that request wasn't valid. Go back and try again.</p>
        <p><a href="/">Home</a></p>
      </body></html>`,
      400
    );
  }
  console.error(err);
  return c.html(
    `<html><body style="font-family:Tahoma;font-size:11px;padding:20px">
      <h3 style="color:#3B5998">[ Something Broke ]</h3>
      <p>Sorry — theqairubook hit an error. Try again in a moment.</p>
      <p><a href="/">Home</a></p>
    </body></html>`,
    500
  );
});

const port = Number(process.env.PORT ?? 8787);

console.log(`[ theqairubook ] listening on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
