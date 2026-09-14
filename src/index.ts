import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { mkdir } from "node:fs/promises";
import type { AppEnv } from "./middleware/auth.js";
import { loadUser } from "./middleware/auth.js";
import { publicRoutes } from "./routes/public.js";
import { authRoutes } from "./routes/auth.js";
import { profileRoutes } from "./routes/profile.js";
import { socialRoutes } from "./routes/social.js";
import { searchRoutes } from "./routes/search.js";
import { boardRoutes } from "./routes/board.js";

const uploadDir = process.env.UPLOAD_DIR ?? "./uploads";
await mkdir(uploadDir, { recursive: true });

const app = new Hono<AppEnv>();

app.use("*", loadUser);
app.use("/static/*", serveStatic({ root: "./src" }));
app.use(
  "/uploads/*",
  serveStatic({
    root: uploadDir,
    rewriteRequestPath: (path) => path.replace(/^\/uploads/, ""),
  })
);

app.route("/", publicRoutes);
app.route("/", authRoutes);
app.route("/", profileRoutes);
app.route("/", socialRoutes);
app.route("/", searchRoutes);
app.route("/", boardRoutes);

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

const port = Number(process.env.PORT ?? 8787);

console.log(`[ theqairubook ] listening on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
