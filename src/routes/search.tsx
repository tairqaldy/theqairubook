import { Hono } from "hono";
import { and, eq, ilike, sql, ne, inArray, or, desc } from "drizzle-orm";
import type { AppEnv } from "../middleware/auth.js";
import { needLogin } from "../middleware/auth.js";
import { Layout, LeftNav, Box, FriendButton } from "../views/layout.js";
import { db } from "../db/index.js";
import { users, type User } from "../db/schema.js";
import { parseCourses, friendIds, friendshipStatuses } from "../lib/social.js";

export const searchRoutes = new Hono<AppEnv>();

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
    if (q) conditions.push(or(ilike(users.name, `%${q}%`), ilike(users.email, `%${q}%`))!);
    if (classYear) conditions.push(ilike(users.classYear, `%${classYear}%`));
    if (residence) conditions.push(ilike(users.residence, `%${residence}%`));
    if (status) conditions.push(eq(users.status, status));
    if (course) conditions.push(ilike(users.courses, `%${course}%`));

    results = await db
      .select()
      .from(users)
      .where(and(...conditions))
      .orderBy(desc(users.rep))
      .limit(50);
  }
  const statuses = await friendshipStatuses(
    user.id,
    results.map((r) => r.id)
  );

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
                    <td class="field-label">Name or email:</td>
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
                  <table class="bordertable people-table">
                    {results.map((r) => (
                      <tr>
                        <td>
                          <a href={`/profile/${r.id}`}>{r.name}</a>
                          <span class="rep-chip">{r.rep}</span>
                          <br />
                          <span class="meta">
                            {r.status}
                            {r.classYear ? ` · ${r.classYear}` : ""}
                            {r.residence ? ` · ${r.residence}` : ""}
                          </span>
                        </td>
                        <td class="actions">
                          {r.id === user.id ? (
                            <span class="meta">(you)</span>
                          ) : (
                            <>
                              <FriendButton
                                userId={r.id}
                                status={statuses.get(r.id) ?? "none"}
                              />{" "}
                              <a href={`/messages/with/${r.id}`}>message</a>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </table>
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

  const randomStatus = await friendshipStatuses(
    user.id,
    random.map((r) => r.id)
  );
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
                  <td></td>
                </tr>
                {random.map((r) => (
                  <tr>
                    <td>
                      <a href={`/profile/${r.id}`}>{r.name}</a>
                      <span class="rep-chip">{r.rep}</span>
                    </td>
                    <td>{r.status}</td>
                    <td>{r.residence || "—"}</td>
                    <td class="actions">
                      <FriendButton
                        userId={r.id}
                        status={randomStatus.get(r.id) ?? "none"}
                      />
                    </td>
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
