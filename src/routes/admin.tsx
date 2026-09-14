import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import { and, count, desc, eq, ilike, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AppEnv } from "../middleware/auth.js";
import { isAdmin } from "../middleware/auth.js";
import {
  Layout,
  LeftNav,
  Box,
  FlairTag,
  InviteCopy,
  UserLink,
  formatDate,
  timeAgo,
} from "../views/layout.js";
import { db } from "../db/index.js";
import {
  boards,
  discussionComments,
  discussionPosts,
  emailCodes,
  media,
  users,
  wallPosts,
  type User,
} from "../db/schema.js";
import { importStudents, parseStudentList, type ImportResult } from "../db/students.js";
import { claimLinkToken } from "../lib/codes.js";
import { emailEnabled } from "../lib/email.js";
import { MEDIA_LIMITS, formatBytes } from "../lib/media.js";
import { turnstileEnabled } from "../lib/security.js";
import { backPath, publicOrigin } from "../lib/url.js";

export const adminRoutes = new Hono<AppEnv>();

const PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The signed-in admin, or null (callers answer 404 so the area stays invisible). */
function adminUser(c: Context<AppEnv>): User | null {
  const user = c.get("user");
  return user && isAdmin(user) ? user : null;
}

type Section = "overview" | "students" | "import" | "content";

const SECTIONS: [Section, string, string][] = [
  ["overview", "Overview", "/admin"],
  ["students", "Students", "/admin/students"],
  ["import", "Import List", "/admin/import"],
  ["content", "Content", "/admin/content"],
];

function AdminPage(props: { user: User; title: string; section: Section; children: Child }) {
  const { user, title, section, children } = props;
  return (
    <Layout title={title} user={user} banner="Admin">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <div class="tabs admin-tabs">
              {SECTIONS.map(([key, label, href]) => (
                <a class={key === section ? "tab current" : "tab"} href={href}>
                  {label}
                </a>
              ))}
            </div>
            {children}
          </td>
        </tr>
      </table>
    </Layout>
  );
}

/** Escapes LIKE wildcards so a search for "a_b" or "50%" is literal. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function percent(part: number, total: number): string {
  return total ? `${Math.round((part / total) * 100)}%` : "0%";
}

// ---------------------------------------------------------------- overview

adminRoutes.get("/admin", async (c) => {
  const user = adminUser(c);
  if (!user) return c.notFound();

  const since24h = new Date(Date.now() - DAY_MS).toISOString();
  const since7d = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const [stats] = await db.execute<{
    total: number;
    activated: number;
    joined24h: number;
    joined7d: number;
    posts: number;
    comments: number;
    messages24h: number;
    uploads: number;
    uploadBytes: string;
    suspended: number;
    locked: number;
  }>(sql`select
      (select count(*)::int from users) as total,
      (select count(*)::int from users where claimed_at is not null) as activated,
      (select count(*)::int from users where claimed_at >= ${since24h}) as "joined24h",
      (select count(*)::int from users where claimed_at >= ${since7d}) as "joined7d",
      (select count(*)::int from discussion_posts where deleted = false) as posts,
      (select count(*)::int from discussion_comments where deleted = false) as comments,
      (select count(*)::int from messages where created_at >= ${since24h}) as "messages24h",
      (select count(*)::int from media where deleted_at is null) as uploads,
      (select coalesce(sum(size_bytes), 0)::bigint::text from media where deleted_at is null) as "uploadBytes",
      (select count(*)::int from users where suspended_at is not null) as suspended,
      (select count(*)::int from users where claim_locked = true) as locked`);

  const total = Number(stats?.total ?? 0);
  const activated = Number(stats?.activated ?? 0);
  const uploadBytes = Number(stats?.uploadBytes ?? 0);
  const suspended = Number(stats?.suspended ?? 0);
  const locked = Number(stats?.locked ?? 0);
  const emailOn = emailEnabled();
  const turnstileOn = turnstileEnabled();

  const topUploaders = await db
    .select({
      id: users.id,
      name: users.name,
      rep: users.rep,
      claimedAt: users.claimedAt,
      files: sql<number>`count(${media.id})::int`,
      bytes: sql<string>`sum(${media.sizeBytes})::bigint::text`,
    })
    .from(media)
    .innerJoin(users, eq(users.id, media.userId))
    .where(isNull(media.deletedAt))
    .groupBy(users.id)
    .orderBy(desc(sql`sum(${media.sizeBytes})`))
    .limit(5);

  const recent = await db
    .select({
      id: users.id,
      name: users.name,
      rep: users.rep,
      claimedAt: users.claimedAt,
      referredByUserId: users.referredByUserId,
    })
    .from(users)
    .where(isNotNull(users.claimedAt))
    .orderBy(desc(users.claimedAt), desc(users.id))
    .limit(10);

  return c.html(
    <AdminPage user={user} title="Admin" section="overview">
      <Box title="[ theqairubook at a Glance ]" alt>
        <table class="stat-row">
          <tr>
            <td>
              <div class="stat-num">{total}</div>
              <div class="meta">on the student list</div>
            </td>
            <td>
              <div class="stat-num">{activated}</div>
              <div class="meta">activated ({percent(activated, total)})</div>
            </td>
            <td>
              <div class="stat-num">+{Number(stats?.joined24h ?? 0)}</div>
              <div class="meta">joined in 24h</div>
            </td>
            <td>
              <div class="stat-num">+{Number(stats?.joined7d ?? 0)}</div>
              <div class="meta">joined in 7 days</div>
            </td>
          </tr>
          <tr>
            <td>
              <div class="stat-num">{Number(stats?.posts ?? 0)}</div>
              <div class="meta">discussion posts</div>
            </td>
            <td>
              <div class="stat-num">{Number(stats?.comments ?? 0)}</div>
              <div class="meta">comments</div>
            </td>
            <td>
              <div class="stat-num">{Number(stats?.messages24h ?? 0)}</div>
              <div class="meta">messages in 24h</div>
            </td>
            <td>
              <div class="stat-num">{Number(stats?.uploads ?? 0)}</div>
              <div class="meta">uploaded files</div>
            </td>
          </tr>
          <tr>
            <td>
              <div class="stat-num">
                {suspended ? (
                  <a href="/admin/students?joined=suspended" class="admin-badge suspended">
                    {suspended} suspended
                  </a>
                ) : (
                  0
                )}
              </div>
              <div class="meta">suspended accounts</div>
            </td>
            <td>
              <div class="stat-num">
                {locked ? (
                  <a href="/admin/students?joined=locked" class="admin-badge locked">
                    {locked} locked
                  </a>
                ) : (
                  0
                )}
              </div>
              <div class="meta">activation locked</div>
            </td>
            <td></td>
            <td></td>
          </tr>
        </table>
        <div class="admin-meter-label">
          Upload storage: <b>{formatBytes(uploadBytes)}</b> of{" "}
          {formatBytes(MEDIA_LIMITS.globalBytes)} ({percent(uploadBytes, MEDIA_LIMITS.globalBytes)})
        </div>
        <div class="admin-meter">
          <div
            class={uploadBytes >= MEDIA_LIMITS.globalBytes * 0.8 ? "admin-meter-fill warn" : "admin-meter-fill"}
            style={`width:${Math.min(100, Math.round((uploadBytes / MEDIA_LIMITS.globalBytes) * 100))}%`}
          ></div>
        </div>
        <div class="admin-meter-label">
          Activation: <b>{activated}</b> of {total} students
        </div>
        <div class="admin-meter">
          <div
            class="admin-meter-fill"
            style={`width:${total ? Math.round((activated / total) * 100) : 0}%`}
          ></div>
        </div>
      </Box>

      <Box title="[ Configuration ]">
        <table class="admin-table admin-config">
          <tr>
            <td class="admin-nowrap">Email verification</td>
            <td class="admin-nowrap">
              <b class={emailOn ? "admin-on" : "admin-off"}>{emailOn ? "ON" : "OFF"}</b>
            </td>
            <td class="meta">
              {emailOn
                ? "Students prove they own their university mailbox with an emailed code."
                : "Set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_EMAIL_API_TOKEN + EMAIL_FROM (or RESEND_API_KEY + EMAIL_FROM) in Railway. Until then, use activation links for disputed accounts."}
            </td>
          </tr>
          <tr>
            <td class="admin-nowrap">Turnstile anti-bot check</td>
            <td class="admin-nowrap">
              <b class={turnstileOn ? "admin-on" : "admin-off"}>{turnstileOn ? "ON" : "OFF"}</b>
            </td>
            <td class="meta">
              {turnstileOn
                ? "Registration and sign-in forms ask for a Cloudflare bot check."
                : "Set TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY in Railway."}
            </td>
          </tr>
        </table>
      </Box>

      <table class="layout-table two-col">
        <tr>
          <td>
            <Box title="[ Recent Activations ]">
              {recent.length ? (
                <table class="bordertable admin-table">
                  {recent.map((u) => (
                    <tr>
                      <td>
                        <UserLink user={u} />
                        {u.referredByUserId ? <span class="meta"> · invited</span> : null}
                      </td>
                      <td class="admin-nowrap meta">{u.claimedAt ? timeAgo(u.claimedAt) : ""}</td>
                    </tr>
                  ))}
                </table>
              ) : (
                <p class="meta">Nobody has activated their account yet.</p>
              )}
            </Box>
          </td>
          <td>
            <Box title="[ Top Uploaders ]">
              {topUploaders.length ? (
                <table class="bordertable admin-table">
                  {topUploaders.map((u) => (
                    <tr>
                      <td>
                        <UserLink user={u} />
                      </td>
                      <td class="admin-num">
                        {formatBytes(Number(u.bytes))}
                        <div class="meta">
                          {u.files} file{u.files === 1 ? "" : "s"}
                        </div>
                      </td>
                    </tr>
                  ))}
                </table>
              ) : (
                <p class="meta">No uploads yet.</p>
              )}
            </Box>
          </td>
        </tr>
      </table>

      <Box title="[ Admin Tools ]">
        <ul class="bullets">
          <li>
            <a href="/admin/students">Students</a> — search the list, see who activated, suspend
            abusive accounts, reset &amp; lock an activation (impersonation reports), send a
            private activation link, manage admins, fix names.
          </li>
          <li>
            <a href="/admin/import">Import List</a> — add or update students from a pasted JSON or
            CSV list. Activated accounts are never touched.
          </li>
          <li>
            <a href="/admin/content">Content</a> — the latest discussion posts, comments and wall
            posts, with links to moderate them.
          </li>
        </ul>
      </Box>
    </AdminPage>
  );
});

// ---------------------------------------------------------------- students

const DONE_MESSAGES: Record<string, { text: string; error?: boolean }> = {
  reset: {
    text: "Activation reset and locked. Every session is logged out and pending codes are cancelled. Only an activation link from an admin can activate it now.",
  },
  unlocked: { text: "Lock removed. The student can activate the account normally again." },
  suspended: { text: "Account suspended. They are logged out and can't sign in." },
  unsuspended: { text: "Suspension lifted. They can sign in again." },
  admin: { text: "They are now an admin." },
  member: { text: "Admin rights removed." },
  renamed: { text: "Name updated." },
  self: { text: "You can't do that to your own account.", error: true },
  nolink: { text: "Suspended accounts can't get an activation link. Unsuspend first.", error: true },
  badname: { text: "Names must be 2–60 characters.", error: true },
  missing: { text: "That account doesn't exist.", error: true },
};

/** Back to the student list the admin came from, keeping its filters. */
function studentsRedirect(c: Context<AppEnv>, done: string) {
  const back = backPath(c, "/admin/students");
  const url = new URL(back.startsWith("/admin/students") ? back : "/admin/students", "http://x");
  url.searchParams.set("done", done);
  return c.redirect(`${url.pathname}${url.search}`);
}

adminRoutes.get("/admin/students", async (c) => {
  const user = adminUser(c);
  if (!user) return c.notFound();

  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const joinedParam = c.req.query("joined");
  const joined =
    joinedParam === "yes" || joinedParam === "no" || joinedParam === "suspended" || joinedParam === "locked"
      ? joinedParam
      : "all";
  const pageParam = Number(c.req.query("page"));
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;
  const done = DONE_MESSAGES[c.req.query("done") ?? ""];

  const conditions: SQL[] = [];
  if (q) {
    const pattern = likePattern(q);
    conditions.push(
      or(ilike(users.name, pattern), ilike(users.nativeName, pattern), ilike(users.email, pattern))!
    );
  }
  if (joined === "yes") conditions.push(isNotNull(users.claimedAt));
  if (joined === "no") conditions.push(isNull(users.claimedAt));
  if (joined === "suspended") conditions.push(isNotNull(users.suspendedAt));
  if (joined === "locked") conditions.push(eq(users.claimLocked, true));
  const where = conditions.length ? and(...conditions) : undefined;

  const [{ total }] = await db.select({ total: count() }).from(users).where(where);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(page, pages);

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      nativeName: users.nativeName,
      email: users.email,
      claimedAt: users.claimedAt,
      rep: users.rep,
      role: users.role,
      suspendedAt: users.suspendedAt,
      claimLocked: users.claimLocked,
    })
    .from(users)
    .where(where)
    .orderBy(users.name, users.id)
    .limit(PAGE_SIZE)
    .offset((current - 1) * PAGE_SIZE);

  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (joined !== "all") params.set("joined", joined);
    if (p > 1) params.set("page", String(p));
    const s = params.toString();
    return s ? `/admin/students?${s}` : "/admin/students";
  };

  return c.html(
    <AdminPage user={user} title="Admin · Students" section="students">
      <Box title="[ Students ]">
        {done ? <p class={done.error ? "error" : "notice"}>{done.text}</p> : null}
        <form method="get" action="/admin/students" class="admin-filter">
          <input type="text" name="q" value={q} placeholder="name, native name or email" />{" "}
          <select name="joined">
            <option value="all" selected={joined === "all"}>
              everyone
            </option>
            <option value="yes" selected={joined === "yes"}>
              activated
            </option>
            <option value="no" selected={joined === "no"}>
              not joined yet
            </option>
            <option value="suspended" selected={joined === "suspended"}>
              suspended
            </option>
            <option value="locked" selected={joined === "locked"}>
              activation locked
            </option>
          </select>{" "}
          <button class="btn" type="submit">
            Search
          </button>
        </form>
        <p class="meta">
          {total} account{total === 1 ? "" : "s"}
          {pages > 1 ? ` · page ${current} of ${pages}` : ""}
        </p>

        {rows.length ? (
          <div class="admin-scroll">
            <table class="admin-table admin-grid">
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Activated</th>
                <th>Rep</th>
                <th>Role</th>
                <th></th>
              </tr>
              {rows.map((r) => {
                const self = r.id === user.id;
                return (
                  <tr class={self ? "me" : ""}>
                    <td>
                      <a href={`/profile/${r.id}`}>
                        <b>{r.name}</b>
                      </a>
                      {r.nativeName ? <div class="meta">{r.nativeName}</div> : null}
                      {r.suspendedAt || r.claimLocked ? (
                        <div>
                          {r.suspendedAt ? (
                            <span class="admin-badge suspended" title={`since ${r.suspendedAt.toISOString()}`}>
                              suspended
                            </span>
                          ) : null}{" "}
                          {r.claimLocked ? (
                            <span class="admin-badge locked" title="Only an admin activation link can activate this account">
                              locked
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                    <td class="admin-email">{r.email}</td>
                    <td class="admin-nowrap">
                      {r.claimedAt ? (
                        <span title={r.claimedAt.toISOString()}>{formatDate(r.claimedAt)}</span>
                      ) : (
                        <span class="not-joined">not joined yet</span>
                      )}
                    </td>
                    <td class="admin-num">{r.rep}</td>
                    <td>{r.role === "admin" ? <b class="admin-role">admin</b> : "member"}</td>
                    <td class="admin-actions-cell">
                      {self ? (
                        <span class="meta">(you)</span>
                      ) : (
                        <details class="admin-actions">
                          <summary>manage</summary>
                          <form method="post" action={`/admin/students/${r.id}/rename`} data-confirm="Rename this account?">
                            <input type="text" name="name" value={r.name} maxlength={60} required />{" "}
                            <button class="btn btn-small" type="submit">
                              Rename
                            </button>
                          </form>
                          <form
                            method="post"
                            action={`/admin/students/${r.id}/role`}
                            data-confirm={r.role === "admin" ? "Remove admin rights?" : "Make this person an admin?"}
                          >
                            <input type="hidden" name="role" value={r.role === "admin" ? "member" : "admin"} />
                            <button class="btn btn-small btn-gray" type="submit">
                              {r.role === "admin" ? "Remove admin" : "Make admin"}
                            </button>
                          </form>
                          <form
                            method="post"
                            action={`/admin/students/${r.id}/suspend`}
                            data-confirm={
                              r.suspendedAt
                                ? "Lift the suspension? They can sign in again."
                                : "Suspend this account? They are logged out everywhere and can't sign in until you unsuspend them. Their profile and posts stay."
                            }
                          >
                            <input type="hidden" name="value" value={r.suspendedAt ? "off" : "on"} />
                            <button class={r.suspendedAt ? "btn btn-small btn-gray" : "btn btn-small admin-danger"} type="submit">
                              {r.suspendedAt ? "Unsuspend" : "Suspend"}
                            </button>
                          </form>
                          <form
                            method="post"
                            action={`/admin/students/${r.id}/reset`}
                            data-confirm={
                              r.claimedAt
                                ? "Reset & lock this activation? The password is removed, they are logged out everywhere and pending codes are cancelled. The account stays locked until you send the real student an activation link. Their profile and posts stay."
                                : "Lock activation? Nobody can activate this account until you send the real student an activation link."
                            }
                          >
                            <button class="btn btn-small btn-gray" type="submit">
                              {r.claimedAt ? "Reset & lock" : "Lock activation"}
                            </button>
                          </form>
                          {r.claimLocked && !r.claimedAt ? (
                            <form
                              method="post"
                              action={`/admin/students/${r.id}/unlock`}
                              data-confirm="Remove the lock? Anyone who passes the normal activation check can then activate this account."
                            >
                              <button class="btn btn-small btn-gray" type="submit">
                                Unlock
                              </button>
                            </form>
                          ) : null}
                          {r.suspendedAt ? null : (
                            <form method="post" action={`/admin/students/${r.id}/claim-link`}>
                              <button class="btn btn-small btn-gray" type="submit">
                                Activation link
                              </button>
                            </form>
                          )}
                        </details>
                      )}
                    </td>
                  </tr>
                );
              })}
            </table>
          </div>
        ) : (
          <p class="meta">No accounts matched.</p>
        )}

        {pages > 1 ? (
          <div class="admin-pager">
            {current > 1 ? <a href={pageHref(current - 1)}>« previous</a> : <span class="meta">« previous</span>}
            {" · "}
            {current < pages ? <a href={pageHref(current + 1)}>next »</a> : <span class="meta">next »</span>}
          </div>
        ) : null}
        <p class="meta">
          <b>Suspend</b> is for abusive accounts: it logs them out everywhere and blocks sign-in
          until you unsuspend.
        </p>
        <p class="meta">
          <b>Reset &amp; lock</b> is for impersonation reports: someone activated a student's account
          who isn't them. It clears the password, logs out every session, cancels pending email
          codes and locks the account so the impersonator can't simply activate it again. Then
          use <b>Activation link</b> to send the real student a private link that activates it.
        </p>
      </Box>
    </AdminPage>
  );
});

/** Loads the target of a student action, refusing the admin's own account. */
async function actionTarget(c: Context<AppEnv>, admin: User) {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return { error: "missing" as const };
  if (id === admin.id) return { error: "self" as const };
  const [target] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      claimedAt: users.claimedAt,
      claimLocked: users.claimLocked,
      suspendedAt: users.suspendedAt,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return target ?? { error: "missing" as const };
}

// Suspend / unsuspend. Suspending bumps session_version, which logs out every
// session and invalidates any activation link already handed out.
adminRoutes.post("/admin/students/:id{[0-9]+}/suspend", async (c) => {
  const user = adminUser(c);
  if (!user) return c.notFound();
  const target = await actionTarget(c, user);
  if ("error" in target) return studentsRedirect(c, target.error);
  const body = await c.req.parseBody();
  if (body.value === "off") {
    await db.update(users).set({ suspendedAt: null }).where(eq(users.id, target.id));
    return studentsRedirect(c, "unsuspended");
  }
  await db
    .update(users)
    .set({
      suspendedAt: sql`coalesce(${users.suspendedAt}, now())`,
      sessionVersion: sql`${users.sessionVersion} + 1`,
    })
    .where(eq(users.id, target.id));
  return studentsRedirect(c, "suspended");
});

// Reset & lock (impersonation reports). Clears the activation, logs out every
// session, cancels outstanding email codes and locks the account so only an
// admin activation link can activate it again. referred_by is cleared so the
// real student's own referral (if any) is recorded fresh.
adminRoutes.post("/admin/students/:id{[0-9]+}/reset", async (c) => {
  const user = adminUser(c);
  if (!user) return c.notFound();
  const target = await actionTarget(c, user);
  if ("error" in target) return studentsRedirect(c, target.error);
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        passwordHash: "",
        claimedAt: null,
        sessionVersion: sql`${users.sessionVersion} + 1`,
        claimLocked: true,
        referredByUserId: null,
      })
      .where(eq(users.id, target.id));
    await tx
      .update(emailCodes)
      .set({ consumedAt: sql`now()` })
      .where(and(eq(emailCodes.userId, target.id), isNull(emailCodes.consumedAt)));
  });
  return studentsRedirect(c, "reset");
});

adminRoutes.post("/admin/students/:id{[0-9]+}/unlock", async (c) => {
  const user = adminUser(c);
  if (!user) return c.notFound();
  const target = await actionTarget(c, user);
  if ("error" in target) return studentsRedirect(c, target.error);
  await db.update(users).set({ claimLocked: false }).where(eq(users.id, target.id));
  return studentsRedirect(c, "unlocked");
});

// A private activation link for the real student: activates a new (or locked)
// account, or sets a new password on an activated one. The token dies once
// session_version changes, i.e. after it is used or the account is reset/suspended.
adminRoutes.post("/admin/students/:id{[0-9]+}/claim-link", async (c) => {
  const user = adminUser(c);
  if (!user) return c.notFound();
  const target = await actionTarget(c, user);
  if ("error" in target) return studentsRedirect(c, target.error);
  if (target.suspendedAt) return studentsRedirect(c, "nolink");

  const link = `${publicOrigin(c)}/claim/${claimLinkToken(target)}`;
  const firstName = target.name.split(" ")[0] || target.name;
  const message = target.claimedAt
    ? `Hi ${firstName}, here is your personal link to set a new password for your theqairubook account: ${link} It works once and expires in 7 days. Please don't share it with anyone.`
    : `Hi ${firstName}, here is your personal link to activate your theqairubook account: ${link} It works once and expires in 7 days. Please don't share it with anyone.`;
  c.header("Cache-Control", "no-store");

  return c.html(
    <AdminPage user={user} title="Admin · Activation Link" section="students">
      <Box title="[ Activation Link ]">
        <p>
          Activation link for <a href={`/profile/${target.id}`}><b>{target.name}</b></a>{" "}
          <span class="admin-email">({target.email})</span>
          {target.claimLocked ? (
            <>
              {" "}
              <span class="admin-badge locked">locked</span>
            </>
          ) : null}
        </p>
        <p class="error">
          Send this only to the real student, privately (e.g. Telegram). Valid 7 days, works once.
          Works for new activation and for password resets.
        </p>
        <InviteCopy id="claim-link" link={link} message={message} />
        <p class="meta">
          {target.claimedAt
            ? "This account is already activated: opening the link lets the student choose a new password, and logs out every other session."
            : "Opening the link lets the student choose a password and activate the account, even while it is locked."}{" "}
          Every link for this account stops working as soon as one of them is used, or when you
          reset, lock or suspend the account.
        </p>
        <p>
          <a href="/admin/students">« back to students</a>
        </p>
      </Box>
    </AdminPage>
  );
});

adminRoutes.post("/admin/students/:id{[0-9]+}/role", async (c) => {
  const user = adminUser(c);
  if (!user) return c.notFound();
  const target = await actionTarget(c, user);
  if ("error" in target) return studentsRedirect(c, target.error);
  const body = await c.req.parseBody();
  const role = body.role === "admin" ? "admin" : "member";
  await db.update(users).set({ role }).where(eq(users.id, target.id));
  return studentsRedirect(c, role);
});

adminRoutes.post("/admin/students/:id{[0-9]+}/rename", async (c) => {
  const user = adminUser(c);
  if (!user) return c.notFound();
  const target = await actionTarget(c, user);
  if ("error" in target) return studentsRedirect(c, target.error);
  const body = await c.req.parseBody();
  const name = String(body.name ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 60 || /[\u0000-\u001f]/.test(name)) {
    return studentsRedirect(c, "badname");
  }
  await db.update(users).set({ name, lastUpdate: new Date() }).where(eq(users.id, target.id));
  return studentsRedirect(c, "renamed");
});

// ---------------------------------------------------------------- import

const MAX_IMPORT_CHARS = 1_000_000;

function ImportPage(props: {
  user: User;
  total: number;
  text?: string;
  result?: ImportResult & { problems: string[]; parsed: number };
  error?: string;
}) {
  const { user, total, text, result, error } = props;
  return (
    <AdminPage user={user} title="Admin · Import" section="import">
      {result ? (
        <Box title="[ Import Result ]" alt>
          <table class="stat-row">
            <tr>
              <td>
                <div class="stat-num">{result.parsed}</div>
                <div class="meta">rows read</div>
              </td>
              <td>
                <div class="stat-num">{result.created}</div>
                <div class="meta">created</div>
              </td>
              <td>
                <div class="stat-num">{result.updated}</div>
                <div class="meta">updated</div>
              </td>
              <td>
                <div class="stat-num">{result.skippedActivated}</div>
                <div class="meta">already activated (untouched)</div>
              </td>
              <td>
                <div class="stat-num">{result.problems.length}</div>
                <div class="meta">invalid</div>
              </td>
            </tr>
          </table>
          {result.problems.length ? (
            <p class="error">
              Skipped: {result.problems.slice(0, 10).join(", ")}
              {result.problems.length > 10 ? ` and ${result.problems.length - 10} more` : ""}. Each
              row needs a university email and a name of 2–80 characters.
            </p>
          ) : (
            <p class="notice">Every row was valid.</p>
          )}
        </Box>
      ) : null}

      <Box title="[ Import Student List ]">
        <p>
          <b>{total}</b> accounts are on the list now. Paste the official list below. New students
          get a pre-created account that shows as <span class="not-joined">not joined yet</span>{" "}
          until they activate it. Names of students who haven't activated are updated; activated
          accounts are never changed. Nothing is deleted.
        </p>
        {error ? <p class="error">{error}</p> : null}
        <form method="post" action="/admin/import" data-confirm="Import this list?">
          <textarea name="list" rows={16} class="admin-import" spellcheck={false} required>
            {text ?? ""}
          </textarea>
          <div class="btn-row">
            <button class="btn" type="submit">
              Import
            </button>
          </div>
        </form>
        <div class="section-label">Accepted formats</div>
        <p class="meta">CSV or tab-separated, one student per line (a header line is fine):</p>
        <pre class="admin-code">{`email,name,nativeName
a.student@qairu.edu.kz,Aigerim Student,Айгерим Студентова`}</pre>
        <p class="meta">or a JSON array:</p>
        <pre class="admin-code">{`[{ "email": "a.student@qairu.edu.kz", "name": "Aigerim Student", "nativeName": "Айгерим Студентова" }]`}</pre>
      </Box>
    </AdminPage>
  );
}

async function studentTotal() {
  const [{ total }] = await db.select({ total: count() }).from(users);
  return total;
}

adminRoutes.get("/admin/import", async (c) => {
  const user = adminUser(c);
  if (!user) return c.notFound();
  return c.html(<ImportPage user={user} total={await studentTotal()} />);
});

adminRoutes.post("/admin/import", async (c) => {
  const user = adminUser(c);
  if (!user) return c.notFound();
  const body = await c.req.parseBody();
  const text = String(body.list ?? "");
  if (text.length > MAX_IMPORT_CHARS) {
    return c.html(
      <ImportPage user={user} total={await studentTotal()} error="That list is too long." />,
      413
    );
  }

  const parsed = parseStudentList(text);
  if (!parsed.rows.length) {
    return c.html(
      <ImportPage
        user={user}
        total={await studentTotal()}
        text={text}
        error={
          parsed.errors.length
            ? `Couldn't read any students (${parsed.errors.slice(0, 10).join(", ")}).`
            : "Couldn't read any students."
        }
      />,
      400
    );
  }

  const result = await importStudents(parsed.rows);
  return c.html(
    <ImportPage
      user={user}
      total={await studentTotal()}
      result={{
        ...result,
        parsed: parsed.rows.length + parsed.errors.length,
        problems: [...parsed.errors, ...result.invalid],
      }}
    />
  );
});

// ---------------------------------------------------------------- content

adminRoutes.get("/admin/content", async (c) => {
  const user = adminUser(c);
  if (!user) return c.notFound();

  const wallOwners = alias(users, "wall_owner");
  const wall = await db
    .select({
      id: wallPosts.id,
      body: wallPosts.body,
      parentId: wallPosts.parentId,
      createdAt: wallPosts.createdAt,
      authorId: users.id,
      authorName: users.name,
      profileId: wallOwners.id,
      profileName: wallOwners.name,
    })
    .from(wallPosts)
    .innerJoin(users, eq(users.id, wallPosts.authorUserId))
    .innerJoin(wallOwners, eq(wallOwners.id, wallPosts.profileUserId))
    .orderBy(desc(wallPosts.createdAt), desc(wallPosts.id))
    .limit(30);

  const posts = await db
    .select({
      id: discussionPosts.id,
      title: discussionPosts.title,
      flair: discussionPosts.flair,
      pinned: discussionPosts.pinned,
      deleted: discussionPosts.deleted,
      score: discussionPosts.score,
      commentCount: discussionPosts.commentCount,
      createdAt: discussionPosts.createdAt,
      boardSlug: boards.slug,
      boardName: boards.name,
      authorId: users.id,
      authorName: users.name,
    })
    .from(discussionPosts)
    .innerJoin(boards, eq(boards.id, discussionPosts.boardId))
    .innerJoin(users, eq(users.id, discussionPosts.authorUserId))
    .orderBy(desc(discussionPosts.createdAt), desc(discussionPosts.id))
    .limit(30);

  const comments = await db
    .select({
      id: discussionComments.id,
      body: discussionComments.body,
      deleted: discussionComments.deleted,
      score: discussionComments.score,
      createdAt: discussionComments.createdAt,
      postId: discussionPosts.id,
      postTitle: discussionPosts.title,
      authorId: users.id,
      authorName: users.name,
    })
    .from(discussionComments)
    .innerJoin(discussionPosts, eq(discussionPosts.id, discussionComments.postId))
    .innerJoin(users, eq(users.id, discussionComments.authorUserId))
    .orderBy(desc(discussionComments.createdAt), desc(discussionComments.id))
    .limit(30);

  return c.html(
    <AdminPage user={user} title="Admin · Content" section="content">
      <Box title="[ Latest Discussion Posts ]">
        <p class="meta">Open a post to delete, pin or moderate it.</p>
        {posts.length ? (
          <table class="admin-table admin-grid">
            <tr>
              <th>Post</th>
              <th>Author</th>
              <th>Score</th>
              <th>When</th>
            </tr>
            {posts.map((p) => (
              <tr class={p.deleted ? "admin-deleted" : ""}>
                <td>
                  <FlairTag flair={p.flair} /> <a href={`/d/p/${p.id}`}>{p.title}</a>
                  <div class="meta">
                    in <a href={`/d/${p.boardSlug}`}>{p.boardName}</a> · {p.commentCount} comment
                    {p.commentCount === 1 ? "" : "s"}
                    {p.pinned ? " · pinned" : ""}
                    {p.deleted ? <b class="admin-flag"> · deleted</b> : null}
                  </div>
                </td>
                <td>
                  <a href={`/profile/${p.authorId}`}>{p.authorName}</a>
                </td>
                <td class="admin-num">{p.score}</td>
                <td class="admin-nowrap meta">{timeAgo(p.createdAt)}</td>
              </tr>
            ))}
          </table>
        ) : (
          <p class="meta">No posts yet.</p>
        )}
      </Box>

      <Box title="[ Latest Comments ]">
        {comments.length ? (
          <table class="admin-table admin-grid">
            <tr>
              <th>Comment</th>
              <th>Author</th>
              <th>Score</th>
              <th>When</th>
            </tr>
            {comments.map((cm) => (
              <tr class={cm.deleted ? "admin-deleted" : ""}>
                <td>
                  <a href={`/d/c/${cm.id}`}>
                    {cm.body.length > 140 ? `${cm.body.slice(0, 140)}…` : cm.body}
                  </a>
                  <div class="meta">
                    on <a href={`/d/p/${cm.postId}`}>{cm.postTitle}</a>
                    {cm.deleted ? <b class="admin-flag"> · deleted</b> : null}
                  </div>
                </td>
                <td>
                  <a href={`/profile/${cm.authorId}`}>{cm.authorName}</a>
                </td>
                <td class="admin-num">{cm.score}</td>
                <td class="admin-nowrap meta">{timeAgo(cm.createdAt)}</td>
              </tr>
            ))}
          </table>
        ) : (
          <p class="meta">No comments yet.</p>
        )}
      </Box>

      <Box title="[ Latest Wall Posts ]">
        <p class="meta">Open a wall post to delete it from the profile page.</p>
        {wall.length ? (
          <table class="admin-table admin-grid">
            <tr>
              <th>Wall post</th>
              <th>Author</th>
              <th>When</th>
            </tr>
            {wall.map((w) => (
              <tr>
                <td>
                  <a href={`/wall/p/${w.id}`}>
                    {w.body.length > 140 ? `${w.body.slice(0, 140)}…` : w.body || "(empty)"}
                  </a>
                  <div class="meta">
                    {w.parentId ? "reply " : ""}on <a href={`/profile/${w.profileId}`}>{w.profileName}</a>'s
                    wall
                  </div>
                </td>
                <td>
                  <a href={`/profile/${w.authorId}`}>{w.authorName}</a>
                </td>
                <td class="admin-nowrap meta">{timeAgo(w.createdAt)}</td>
              </tr>
            ))}
          </table>
        ) : (
          <p class="meta">No wall posts yet.</p>
        )}
      </Box>
    </AdminPage>
  );
});
