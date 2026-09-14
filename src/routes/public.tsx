import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import { Layout, Box } from "../views/layout.js";

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get("/", (c) => {
  const user = c.get("user");
  if (user) return c.redirect("/home");
  return c.html(
    <Layout title="Welcome" user={null} banner="Welcome to Theqairubook!">
      <table class="layout-table">
        <tr>
          <td style="width:55%; padding-right:12px">
            <Box title="[ Welcome to Theqairubook ]" alt>
              <p>
                Theqairubook is an online directory that connects people through
                social networks at <b>Qazaq AI Research University (QAIRU)</b>.
              </p>
              <p>On Theqairubook, you can:</p>
              <ul class="bullets">
                <li>Search for people at your school</li>
                <li>Find out who are in your classes</li>
                <li>Look up your friends' friends</li>
                <li>See a visualization of your social network</li>
              </ul>
              <div class="btn-row">
                <a href="/register">
                  <button class="btn" type="button">
                    Register
                  </button>
                </a>
                <a href="/login">
                  <button class="btn" type="button">
                    Login
                  </button>
                </a>
              </div>
            </Box>
          </td>
          <td>
            <Box title="[ QAIRU ]">
              <p>
                <b>School:</b> Qazaq AI Research University
                <br />
                <b>Campus:</b> пр. Мәңгілік Ел 55/1, EXPO, Astana
                <br />
                <b>Network:</b> Students, faculty and staff with a{" "}
                <code>@qairu.edu.kz</code> address.
              </p>
              <p class="meta">
                Alma mater of AI · a QAIRU student production
              </p>
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
});

publicRoutes.get("/about", (c) => {
  return c.html(
    <Layout title="About" user={c.get("user")} banner="About Theqairubook">
      <Box title="[ About ]" alt>
        <p>
          Theqairubook is a student-built homage to the early college directory
          that launched in 2004. It is made for{" "}
          <b>Qazaq AI Research University (QAIRU)</b> in Astana.
        </p>
        <p>
          Registration is limited to <code>@qairu.edu.kz</code> email addresses.
          Use your real name. Find classmates, add friends, poke people, write
          on walls, and browse the social net — just like the old days.
        </p>
        <p>
          This is an independent student project. It is not affiliated with Meta
          Platforms, Inc. or Facebook.
        </p>
      </Box>
    </Layout>
  );
});

publicRoutes.get("/faq", (c) => {
  return c.html(
    <Layout title="FAQ" user={c.get("user")} banner="Frequently Asked Questions">
      <Box title="[ FAQ ]" alt>
        <p>
          <b>Who can join?</b>
          <br />
          Anyone with a valid <code>@qairu.edu.kz</code> email address.
        </p>
        <hr class="thin" />
        <p>
          <b>What is a poke?</b>
          <br />
          A poke is a simple way to say hello. What it means is up to you.
        </p>
        <hr class="thin" />
        <p>
          <b>Can people outside QAIRU see my profile?</b>
          <br />
          No. The network is QAIRU-only. You can further limit visibility under
          Privacy.
        </p>
        <hr class="thin" />
        <p>
          <b>Is this the official university site?</b>
          <br />
          No. Official QAIRU is at qairu.edu.kz. This is a student directory
          project.
        </p>
      </Box>
    </Layout>
  );
});

publicRoutes.get("/terms", (c) => {
  return c.html(
    <Layout title="Terms" user={c.get("user")} banner="Terms of Use">
      <Box title="[ Terms ]" alt>
        <p>
          Use your real name. Do not harass other students. Do not upload
          content you do not have rights to. Admins may remove accounts that
          break these rules.
        </p>
        <p>
          Data stays on the servers you deploy. This local demo stores passwords
          hashed with scrypt.
        </p>
      </Box>
    </Layout>
  );
});
