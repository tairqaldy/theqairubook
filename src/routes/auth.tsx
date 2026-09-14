import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../middleware/auth.js";
import { Layout, Box } from "../views/layout.js";
import { db } from "../db/index.js";
import { users, invites, friendships } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { encodeSession, allowedEmail } from "../auth/session.js";
import { addBoardEvent } from "../lib/social.js";

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/register", (c) => {
  if (c.get("user")) return c.redirect("/home");
  return c.html(registerForm());
});

authRoutes.post("/register", async (c) => {
  if (c.get("user")) return c.redirect("/home");
  const body = await c.req.parseBody();
  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const sex = String(body.sex ?? "");
  const status = String(body.status ?? "Student");

  if (!name || name.split(/\s+/).length < 2) {
    return c.html(registerForm("Please enter your real first and last name."));
  }
  if (!allowedEmail(email)) {
    return c.html(
      registerForm("You must register with a @qairu.edu.kz email address.")
    );
  }
  if (password.length < 6) {
    return c.html(registerForm("Password must be at least 6 characters."));
  }

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length) {
    return c.html(registerForm("That email is already registered. Try logging in."));
  }

  const [user] = await db
    .insert(users)
    .values({
      name,
      email,
      passwordHash: hashPassword(password),
      sex,
      status,
      school: "QAIRU",
    })
    .returning();

  await addBoardEvent(user.id, "joined", `${user.name} joined theqairubook`);

  setCookie(c, "session", encodeSession(user.id), {
    httpOnly: true,
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    sameSite: "Lax",
  });
  return c.redirect("/edit-profile");
});

authRoutes.get("/join/:token", async (c) => {
  if (c.get("user")) return c.redirect("/home");
  const token = c.req.param("token");
  const [invite] = await db
    .select()
    .from(invites)
    .where(eq(invites.token, token))
    .limit(1);

  if (!invite) return c.html(inviteProblem("This invite link is not valid."));
  if (invite.usedByUserId)
    return c.html(
      inviteProblem("This invite link has already been used.", true)
    );

  const [inviter] = await db
    .select()
    .from(users)
    .where(eq(users.id, invite.fromUserId))
    .limit(1);

  return c.html(joinForm(token, inviter?.name ?? "a theqairubook member"));
});

authRoutes.post("/join/:token", async (c) => {
  if (c.get("user")) return c.redirect("/home");
  const token = c.req.param("token");
  const [invite] = await db
    .select()
    .from(invites)
    .where(eq(invites.token, token))
    .limit(1);

  if (!invite) return c.html(inviteProblem("This invite link is not valid."));
  if (invite.usedByUserId)
    return c.html(
      inviteProblem("This invite link has already been used.", true)
    );

  const [inviter] = await db
    .select()
    .from(users)
    .where(eq(users.id, invite.fromUserId))
    .limit(1);
  const inviterName = inviter?.name ?? "a theqairubook member";

  const body = await c.req.parseBody();
  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const sex = String(body.sex ?? "");
  const status = String(body.status ?? "Student");

  if (!name || name.split(/\s+/).length < 2) {
    return c.html(
      joinForm(token, inviterName, "Please enter your real first and last name.")
    );
  }
  if (!email.includes("@") || !email.includes(".")) {
    return c.html(joinForm(token, inviterName, "Please enter a valid email address."));
  }
  if (password.length < 6) {
    return c.html(
      joinForm(token, inviterName, "Password must be at least 6 characters.")
    );
  }

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length) {
    return c.html(
      joinForm(token, inviterName, "That email is already registered. Try logging in.")
    );
  }

  const [user] = await db
    .insert(users)
    .values({
      name,
      email,
      passwordHash: hashPassword(password),
      sex,
      status,
      school: "QAIRU",
    })
    .returning();

  await db
    .update(invites)
    .set({ usedByUserId: user.id, usedAt: new Date() })
    .where(eq(invites.id, invite.id));

  if (invite.fromUserId !== user.id) {
    await db.insert(friendships).values({
      fromUserId: invite.fromUserId,
      toUserId: user.id,
      status: "accepted",
    });
  }

  await addBoardEvent(user.id, "joined", `${user.name} joined theqairubook`);
  await addBoardEvent(
    user.id,
    "friend",
    "became friends",
    invite.fromUserId
  );

  setCookie(c, "session", encodeSession(user.id), {
    httpOnly: true,
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    sameSite: "Lax",
  });
  return c.redirect("/edit-profile");
});

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

  setCookie(c, "session", encodeSession(user.id), {
    httpOnly: true,
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    sameSite: "Lax",
  });
  return c.redirect("/home");
});

authRoutes.get("/logout", (c) => {
  deleteCookie(c, "session", { path: "/" });
  return c.redirect("/");
});

function registerForm(error?: string) {
  return (
    <Layout title="Register" user={null} banner="Register">
      <Box title="[ Registration ]" alt>
        {error ? <p class="error">{error}</p> : null}
        <p>
          You must use a <b>@qairu.edu.kz</b> email address and your real name.
        </p>
        <form method="post" action="/register">
          <table class="search-form">
            <tr>
              <td class="field-label">Name:</td>
              <td>
                <input type="text" name="name" size={30} required />
              </td>
            </tr>
            <tr>
              <td class="field-label">Email:</td>
              <td>
                <input type="email" name="email" size={30} required />
              </td>
            </tr>
            <tr>
              <td class="field-label">Password:</td>
              <td>
                <input type="password" name="password" size={30} required />
              </td>
            </tr>
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

function joinForm(token: string, inviterName: string, error?: string) {
  return (
    <Layout title="Join theqairubook" user={null} banner="You're Invited!">
      <Box title="[ Join theqairubook ]" alt>
        {error ? <p class="error">{error}</p> : null}
        <p>
          <b>{inviterName}</b> invited you to theqairubook. Register below
          with any email — invited friends don't need a{" "}
          <code>@qairu.edu.kz</code> address.
        </p>
        <form method="post" action={`/join/${token}`}>
          <table class="search-form">
            <tr>
              <td class="field-label">Name:</td>
              <td>
                <input type="text" name="name" size={30} required />
              </td>
            </tr>
            <tr>
              <td class="field-label">Email:</td>
              <td>
                <input type="email" name="email" size={30} required />
              </td>
            </tr>
            <tr>
              <td class="field-label">Password:</td>
              <td>
                <input type="password" name="password" size={30} required />
              </td>
            </tr>
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
          </table>
          <div class="btn-row">
            <button class="btn" type="submit">
              Join Now!
            </button>
          </div>
        </form>
      </Box>
    </Layout>
  );
}

function inviteProblem(message: string, alreadyUsed?: boolean) {
  return (
    <Layout title="Invite" user={null} banner="Invite Link">
      <Box title="[ Invite Link ]" alt>
        <p class="error">{message}</p>
        <p>
          {alreadyUsed ? (
            <>Already have an account? <a href="/login">Login</a>.</>
          ) : (
            <>
              You can still <a href="/register">register</a> with a{" "}
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
                <input type="email" name="email" size={30} required />
              </td>
            </tr>
            <tr>
              <td class="field-label">Password:</td>
              <td>
                <input type="password" name="password" size={30} required />
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
