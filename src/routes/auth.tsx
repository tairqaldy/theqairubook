import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../middleware/auth.js";
import { startSession } from "../middleware/auth.js";
import { Layout, Box } from "../views/layout.js";
import { db } from "../db/index.js";
import { users, invites, friendships, type User } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { allowedEmail } from "../auth/session.js";
import { addBoardEvent, makeReferralCode } from "../lib/social.js";
import { awardReferral } from "../lib/rep.js";

export const authRoutes = new Hono<AppEnv>();

const REF_COOKIE = "ref";

type Referral = {
  referrer: User;
  // Legacy one-time invite row, if the link was an old /join/<token>.
  inviteId: number | null;
  code: string;
};

/**
 * Resolves both permanent referral codes (/r/aigerim-3f9a1) and legacy
 * one-time invite tokens (/join/<hex>). Returns null when invalid or used up.
 */
async function resolveReferral(code: string): Promise<Referral | "used" | null> {
  if (!code) return null;
  const [byCode] = await db
    .select()
    .from(users)
    .where(eq(users.referralCode, code))
    .limit(1);
  if (byCode) return { referrer: byCode, inviteId: null, code };

  const [invite] = await db
    .select()
    .from(invites)
    .where(eq(invites.token, code))
    .limit(1);
  if (!invite) return null;
  if (invite.usedByUserId) return "used";
  const [inviter] = await db
    .select()
    .from(users)
    .where(eq(users.id, invite.fromUserId))
    .limit(1);
  if (!inviter) return null;
  return { referrer: inviter, inviteId: invite.id, code };
}

function readForm(body: Record<string, unknown>) {
  return {
    name: String(body.name ?? "").trim().replace(/\s+/g, " "),
    email: String(body.email ?? "").trim().toLowerCase(),
    password: String(body.password ?? ""),
    sex: String(body.sex ?? ""),
    status: String(body.status ?? "Student"),
  };
}

function validate(form: ReturnType<typeof readForm>): string | null {
  if (!form.name || form.name.split(" ").length < 2) {
    return "Please enter your real first and last name.";
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) {
    return "Please enter a valid email address.";
  }
  if (form.password.length < 6) return "Password must be at least 6 characters.";
  if (!["Student", "Faculty", "Staff", "Alumnus/Alumna"].includes(form.status)) {
    return "Please pick a status.";
  }
  return null;
}

async function createAccount(
  c: Context<AppEnv>,
  form: ReturnType<typeof readForm>,
  referral: Referral | null
): Promise<string | null> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, form.email))
    .limit(1);
  if (existing) return "That email is already registered. Try logging in.";

  const [user] = await db
    .insert(users)
    .values({
      name: form.name,
      email: form.email,
      passwordHash: hashPassword(form.password),
      sex: form.sex,
      status: form.status,
      school: "QAIRU",
      referralCode: makeReferralCode(form.name),
      referredByUserId: referral?.referrer.id ?? null,
    })
    .returning();

  await addBoardEvent(user.id, "joined", `${user.name} joined theqairubook`);

  if (referral) {
    if (referral.inviteId) {
      await db
        .update(invites)
        .set({ usedByUserId: user.id, usedAt: new Date() })
        .where(eq(invites.id, referral.inviteId));
    }
    await db
      .insert(friendships)
      .values({
        fromUserId: referral.referrer.id,
        toUserId: user.id,
        status: "accepted",
      })
      .onConflictDoNothing();
    const earned = await awardReferral(referral.referrer.id, user.id);
    await addBoardEvent(
      user.id,
      "referral",
      earned ? `+${earned} rep` : "",
      referral.referrer.id
    );
    deleteCookie(c, REF_COOKIE, { path: "/" });
  }

  startSession(c, user.id);
  return null;
}

authRoutes.get("/register", async (c) => {
  if (c.get("user")) return c.redirect("/home");
  // Someone who opened a referral link and then clicked "register" keeps it.
  const ref = await resolveReferral(getCookie(c, REF_COOKIE) ?? "");
  if (ref && ref !== "used") return c.redirect(`/r/${ref.code}`);
  return c.html(registerForm());
});

authRoutes.post("/register", async (c) => {
  if (c.get("user")) return c.redirect("/home");
  const form = readForm(await c.req.parseBody());
  const invalid = validate(form);
  if (invalid) return c.html(registerForm(invalid));
  if (!allowedEmail(form.email)) {
    return c.html(
      registerForm(
        "You must register with a @qairu.edu.kz email address — or ask a member for their invite link."
      )
    );
  }
  const error = await createAccount(c, form, null);
  if (error) return c.html(registerForm(error));
  return c.redirect("/edit-profile");
});

async function showJoin(c: Context<AppEnv>, code: string) {
  const ref = await resolveReferral(code);
  if (!ref) return c.html(inviteProblem(c.get("user"), "This invite link is not valid."), 404);
  if (ref === "used")
    return c.html(inviteProblem(c.get("user"), "This one-time invite link has already been used.", true));

  const viewer = c.get("user");
  if (viewer) return c.html(alreadyMember(viewer, ref.referrer));

  setCookie(c, REF_COOKIE, ref.code, {
    httpOnly: true,
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    sameSite: "Lax",
  });
  return c.html(joinForm(ref.code, ref.referrer));
}

async function submitJoin(c: Context<AppEnv>, code: string) {
  if (c.get("user")) return c.redirect("/home");
  const ref = await resolveReferral(code);
  if (!ref) return c.html(inviteProblem(null, "This invite link is not valid."), 404);
  if (ref === "used")
    return c.html(inviteProblem(null, "This one-time invite link has already been used.", true));

  const form = readForm(await c.req.parseBody());
  const invalid = validate(form);
  if (invalid) return c.html(joinForm(ref.code, ref.referrer, invalid));
  const error = await createAccount(c, form, ref);
  if (error) return c.html(joinForm(ref.code, ref.referrer, error));
  return c.redirect("/edit-profile?welcome=1");
}

authRoutes.get("/r/:code", (c) => showJoin(c, c.req.param("code")));
authRoutes.post("/r/:code", (c) => submitJoin(c, c.req.param("code")));
// Legacy links already shared before referral codes existed.
authRoutes.get("/join/:token", (c) => showJoin(c, c.req.param("token")));
authRoutes.post("/join/:token", (c) => submitJoin(c, c.req.param("token")));

authRoutes.get("/login", (c) => {
  if (c.get("user")) return c.redirect("/home");
  return c.html(loginForm());
});

authRoutes.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return c.html(loginForm("Incorrect email or password."));
  }

  startSession(c, user.id);
  return c.redirect("/home");
});

authRoutes.get("/logout", (c) => {
  deleteCookie(c, "session", { path: "/" });
  return c.redirect("/");
});

const StatusAndSex = () => (
  <>
    <tr>
      <td class="field-label">Status:</td>
      <td>
        <select name="status">
          <option>Student</option>
          <option>Faculty</option>
          <option>Staff</option>
          <option>Alumnus/Alumna</option>
        </select>
      </td>
    </tr>
    <tr>
      <td class="field-label">Sex:</td>
      <td>
        <select name="sex">
          <option value="">-</option>
          <option>Male</option>
          <option>Female</option>
        </select>
      </td>
    </tr>
  </>
);

const AccountFields = () => (
  <>
    <tr>
      <td class="field-label">Name:</td>
      <td>
        <input type="text" name="name" size={30} required autocomplete="name" />
      </td>
    </tr>
    <tr>
      <td class="field-label">Email:</td>
      <td>
        <input type="email" name="email" size={30} required autocomplete="email" />
      </td>
    </tr>
    <tr>
      <td class="field-label">Password:</td>
      <td>
        <input
          type="password"
          name="password"
          size={30}
          required
          minlength={6}
          autocomplete="new-password"
        />
      </td>
    </tr>
    <StatusAndSex />
  </>
);

function registerForm(error?: string) {
  return (
    <Layout title="Register" user={null} banner="Register">
      <Box title="[ Registration ]" alt>
        {error ? <p class="error">{error}</p> : null}
        <p>
          You must use a <b>@qairu.edu.kz</b> email address and your real name.
          Got an invite link from a friend? Open it instead — invited people can
          use any email.
        </p>
        <form method="post" action="/register">
          <table class="search-form">
            <AccountFields />
          </table>
          <div class="btn-row">
            <button class="btn" type="submit">
              Register Now!
            </button>
          </div>
        </form>
      </Box>
    </Layout>
  );
}

function joinForm(code: string, referrer: User, error?: string) {
  const first = referrer.name.split(" ")[0];
  return (
    <Layout title={`${first} invited you`} user={null} banner="You're Invited!">
      <table class="layout-table">
        <tr>
          <td style="width:62%; padding-right:12px">
            <Box title="[ Join theqairubook ]" alt>
              {error ? <p class="error">{error}</p> : null}
              <p>
                <b>{referrer.name}</b> invited you to theqairubook — the QAIRU
                college directory. Register below with any email. You'll be
                friends with {first} right away.
              </p>
              <form method="post" action={`/r/${code}`}>
                <table class="search-form">
                  <AccountFields />
                </table>
                <div class="btn-row">
                  <button class="btn" type="submit">
                    Join Now!
                  </button>
                </div>
              </form>
              <p class="meta">
                Already a member? <a href="/login">Login</a>.
              </p>
            </Box>
          </td>
          <td>
            <Box title="[ Your Friend ]">
              <p>
                <b>{referrer.name}</b>
                <br />
                {referrer.status}
                {referrer.classYear ? ` · Class of ${referrer.classYear}` : ""}
                <br />
                <span class="rep-chip">{referrer.rep}</span> rep
              </p>
              <p class="meta">
                On theqairubook you can find classmates, join discussions, earn
                rep, and message people — like 2004, but for QAIRU.
              </p>
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
}

function alreadyMember(viewer: User, referrer: User) {
  const own = viewer.id === referrer.id;
  return (
    <Layout title="Invite" user={viewer} banner="Invite Link">
      <Box title="[ Invite Link ]" alt>
        {own ? (
          <p>
            This is <b>your</b> invite link — it works! Send it to classmates;
            when they join through it you both become friends and you earn rep.
          </p>
        ) : (
          <p>
            This is <b>{referrer.name}</b>'s invite link. You're already logged
            in as <b>{viewer.name}</b>, so there's nothing to join.
          </p>
        )}
        <p>
          <a href="/invite">Get your own invite link</a> ·{" "}
          {own ? null : (
            <>
              <a href={`/profile/${referrer.id}`}>View {referrer.name.split(" ")[0]}'s profile</a> ·{" "}
            </>
          )}
          <a href="/home">Home</a>
        </p>
      </Box>
    </Layout>
  );
}

function inviteProblem(viewer: User | null, message: string, alreadyUsed?: boolean) {
  return (
    <Layout title="Invite" user={viewer} banner="Invite Link">
      <Box title="[ Invite Link ]" alt>
        <p class="error">{message}</p>
        <p>
          {alreadyUsed ? (
            <>
              Ask your friend for their permanent link from the <b>invite</b>{" "}
              tab — those never run out. Already have an account?{" "}
              <a href="/login">Login</a>.
            </>
          ) : (
            <>
              Double-check the link, or <a href="/register">register</a> with a{" "}
              <code>@qairu.edu.kz</code> email.
            </>
          )}
        </p>
      </Box>
    </Layout>
  );
}

function loginForm(error?: string) {
  return (
    <Layout title="Login" user={null} banner="Login">
      <Box title="[ Login ]" alt>
        {error ? <p class="error">{error}</p> : null}
        <form method="post" action="/login">
          <table class="search-form">
            <tr>
              <td class="field-label">Email:</td>
              <td>
                <input type="email" name="email" size={30} required autocomplete="email" />
              </td>
            </tr>
            <tr>
              <td class="field-label">Password:</td>
              <td>
                <input
                  type="password"
                  name="password"
                  size={30}
                  required
                  autocomplete="current-password"
                />
              </td>
            </tr>
          </table>
          <div class="btn-row">
            <button class="btn" type="submit">
              Login
            </button>
          </div>
        </form>
        <p>
          Don't have an account? <a href="/register">Register</a>
        </p>
      </Box>
    </Layout>
  );
}
