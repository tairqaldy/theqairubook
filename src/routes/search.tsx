import { Hono } from "hono";
import { and, eq, ilike, sql, ne, inArray } from "drizzle-orm";
import type { AppEnv } from "../middleware/auth.js";
import { Layout, LeftNav, Box } from "../views/layout.js";
import { db } from "../db/index.js";
import { users, type User } from "../db/schema.js";
import { parseCourses, friendIds } from "../lib/social.js";

export const searchRoutes = new Hono<AppEnv>();

function needLogin(c: {
  get: (k: "user") => User | null;
  redirect: (u: string) => Response;
}) {
  const user = c.get("user");
  if (!user) return { user: null as never, redirect: c.redirect("/login") };
  return { user, redirect: null as Response | null };
}

searchRoutes.get("/search", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;

  const q = (c.req.query("q") ?? "").trim();
  const classYear = (c.req.query("classYear") ?? "").trim();
  const residence = (c.req.query("residence") ?? "").trim();
  const course = (c.req.query("course") ?? "").trim();
  const status = (c.req.query("status") ?? "").trim();

  let results: User[] = [];
  const hasQuery = q || classYear || residence || course || status;

  if (hasQuery) {
    const conditions = [ne(users.id, -1)];
    if (q) conditions.push(ilike(users.name, `%${q}%`));
    if (classYear) conditions.push(ilike(users.classYear, `%${classYear}%`));
    if (residence) conditions.push(ilike(users.residence, `%${residence}%`));
    if (status) conditions.push(eq(users.status, status));
    if (course) conditions.push(ilike(users.courses, `%${course}%`));

    results = await db
      .select()
      .from(users)
      .where(and(...conditions))
      .limit(50);
  }

  return c.html(
    <Layout title="Search" user={user} banner="Search">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title="[ Search People at QAIRU ]" alt>
              <form method="get" action="/search">
                <table class="search-form">
                  <tr>
                    <td class="field-label">Name:</td>
                    <td>
                      <input type="text" name="q" size={30} value={q} />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Class Year:</td>
                    <td>
                      <input
                        type="text"
                        name="classYear"
                        size={20}
                        value={classYear}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Residence:</td>
                    <td>
                      <input
                        type="text"
                        name="residence"
                        size={30}
                        value={residence}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Course:</td>
                    <td>
                      <input type="text" name="course" size={30} value={course} />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Status:</td>
                    <td>
                      <select name="status">
                        <option value="">Any</option>
                        {["Student", "Faculty", "Staff", "Alumnus/Alumna"].map(
                          (s) => (
                            <option selected={status === s} value={s}>
                              {s}
                            </option>
                          )
                        )}
                      </select>
                    </td>
                  </tr>
                </table>
                <div class="btn-row">
                  <button class="btn" type="submit">
                    Search
                  </button>
                </div>
              </form>
            </Box>

            {hasQuery ? (
              <Box title={`[ Results (${results.length}) ]`}>
                {results.length ? (
                  <ul class="bullets">
                    {results.map((r) => (
                      <li>
                        <a href={`/profile/${r.id}`}>{r.name}</a>
                        {r.classYear ? ` · ${r.classYear}` : ""}
                        {r.residence ? ` · ${r.residence}` : ""}
                        {r.status ? ` · ${r.status}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p class="meta">No people matched your search.</p>
                )}
              </Box>
            ) : null}
          </td>
        </tr>
      </table>
    </Layout>
  );
});

searchRoutes.get("/courses/:name", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const courseName = decodeURIComponent(c.req.param("name"));

  const all = await db.select().from(users).limit(500);
  const classmates = all.filter((u) =>
    parseCourses(u.courses).some(
      (x) => x.toLowerCase() === courseName.toLowerCase()
    )
  );

  return c.html(
    <Layout title={courseName} user={user} banner="Course Match">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title={`[ ${courseName} ]`} alt>
              <p>
                Students enrolled in <b>{courseName}</b> at QAIRU:
              </p>
              {classmates.length ? (
                <ul class="bullets">
                  {classmates.map((r) => (
                    <li>
                      <a href={`/profile/${r.id}`}>{r.name}</a>
                      {r.classYear ? ` · ${r.classYear}` : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="meta">Nobody listed this course yet.</p>
              )}
              <p>
                <a href={`/search?course=${encodeURIComponent(courseName)}`}>
                  Search again
                </a>
              </p>
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
});

searchRoutes.get("/social-net", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;

  const random = await db
    .select()
    .from(users)
    .where(ne(users.id, user.id))
    .orderBy(sql`random()`)
    .limit(10);

  const myFriendIds = await friendIds(user.id);
  const myFriends = myFriendIds.length
    ? await db.select().from(users).where(inArray(users.id, myFriendIds))
    : [];

  return c.html(
    <Layout title="Social Net" user={user} banner="Social Network">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title="[ Your Connections ]" alt>
              {myFriends.length ? (
                <p>
                  {myFriends.map((f, i) => (
                    <>
                      {i > 0 ? " — " : ""}
                      <a href={`/profile/${f.id}`}>{f.name}</a>
                    </>
                  ))}
                </p>
              ) : (
                <p class="meta">Add some friends to see your network.</p>
              )}
            </Box>
            <Box title="[ 10 Random People at QAIRU ]">
              <table class="bordertable">
                <tr>
                  <td>
                    <b>Name</b>
                  </td>
                  <td>
                    <b>Status</b>
                  </td>
                  <td>
                    <b>Residence</b>
                  </td>
                </tr>
                {random.map((r) => (
                  <tr>
                    <td>
                      <a href={`/profile/${r.id}`}>{r.name}</a>
                    </td>
                    <td>{r.status}</td>
                    <td>{r.residence || "—"}</td>
                  </tr>
                ))}
              </table>
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
});
