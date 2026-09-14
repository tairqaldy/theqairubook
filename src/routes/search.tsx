import { Hono } from "hono";
import { and, eq, ilike, sql, ne, inArray, or, desc, isNull, isNotNull, type SQL } from "drizzle-orm";
import type { AppEnv } from "../middleware/auth.js";
import { needLogin } from "../middleware/auth.js";
import { Layout, LeftNav, Box, FriendButton, NotJoined, timeAgo } from "../views/layout.js";
import { db } from "../db/index.js";
import { users, type User } from "../db/schema.js";
import { parseCourses, friendIds, friendshipStatuses, joinedStats } from "../lib/social.js";

export const searchRoutes = new Hono<AppEnv>();

/** Escape LIKE wildcards so "%" and "_" in a query match literally. */
function likeTerm(s: string): string {
  return `%${s.replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * Listings only reveal profile details (status, class year, residence,
 * courses) when the listed person's privacy is "network", it's the viewer,
 * or they're an accepted friend of the viewer.
 */
function detailsVisible(viewerId: number, r: User, isFriend: boolean): boolean {
  return r.privacy === "network" || r.id === viewerId || isFriend;
}

const JOINED_OPTIONS = [
  ["", "Anyone"],
  ["yes", "Joined"],
  ["no", "Not joined yet"],
] as const;

searchRoutes.get("/search", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;

  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const classYear = (c.req.query("classYear") ?? "").trim().slice(0, 50);
  const residence = (c.req.query("residence") ?? "").trim().slice(0, 100);
  const course = (c.req.query("course") ?? "").trim().slice(0, 100);
  const status = (c.req.query("status") ?? "").trim();
  const joinedParam = c.req.query("joined") ?? "";
  const joined = joinedParam === "yes" || joinedParam === "no" ? joinedParam : "";

  let results: User[] = [];
  const hasQuery = q || classYear || residence || course || status || joined;

  if (hasQuery) {
    const conditions: SQL[] = [];
    if (q) {
      const term = likeTerm(q);
      conditions.push(
        or(ilike(users.name, term), ilike(users.nativeName, term), ilike(users.email, term))!
      );
    }
    if (classYear) conditions.push(ilike(users.classYear, likeTerm(classYear)));
    if (residence) conditions.push(ilike(users.residence, likeTerm(residence)));
    if (status) conditions.push(eq(users.status, status));
    if (course) conditions.push(ilike(users.courses, likeTerm(course)));
    if (joined === "yes") conditions.push(isNotNull(users.claimedAt));
    if (joined === "no") conditions.push(isNull(users.claimedAt));
    // Filtering on profile details must not match people whose details the
    // viewer isn't allowed to see.
    if (classYear || residence || status || course) {
      const fids = await friendIds(user.id);
      const visible: SQL[] = [eq(users.privacy, "network"), eq(users.id, user.id)];
      if (fids.length) visible.push(inArray(users.id, fids));
      conditions.push(or(...visible)!);
    }

    results = await db
      .select()
      .from(users)
      .where(and(...conditions))
      // Activated members first, then by rep and name.
      .orderBy(sql`${users.claimedAt} is null`, desc(users.rep), users.name)
      .limit(50);
  }
  const statuses = await friendshipStatuses(
    user.id,
    results.map((r) => r.id)
  );
  const stats = await joinedStats();

  return c.html(
    <Layout title="Search" user={user} banner="Search">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <p class="stats-line">
              <b>{stats.joined}</b> of <b>{stats.total}</b> QAIRU students have joined
              theqairubook
            </p>
            <Box title="[ Search People at QAIRU ]" alt>
              <form method="get" action="/search">
                <table class="search-form">
                  <tr>
                    <td class="field-label">Name or email:</td>
                    <td>
                      <input type="text" name="q" size={30} value={q} maxlength={100} />
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
                  <tr>
                    <td class="field-label">Joined:</td>
                    <td>
                      <select name="joined">
                        {JOINED_OPTIONS.map(([value, label]) => (
                          <option selected={joined === value} value={value}>
                            {label}
                          </option>
                        ))}
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
                          {r.claimedAt === null ? (
                            <NotJoined />
                          ) : (
                            <span class="rep-chip">{r.rep}</span>
                          )}
                          {detailsVisible(user.id, r, statuses.get(r.id) === "friends") ? (
                            <>
                              <br />
                              <span class="meta">
                                {r.status}
                                {r.classYear ? ` · ${r.classYear}` : ""}
                                {r.residence ? ` · ${r.residence}` : ""}
                              </span>
                            </>
                          ) : null}
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
                              {r.claimedAt === null ? (
                                <a href={`/profile/${r.id}#invite`}>invite</a>
                              ) : (
                                <a href={`/messages/with/${r.id}`}>message</a>
                              )}
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
  // c.req.param() is already percent-decoded; decoding again breaks on "%".
  const courseName = c.req.param("name");

  const all = await db.select().from(users).where(isNotNull(users.claimedAt)).limit(1000);
  // Course membership is profile info: only list people the viewer may see.
  const myFriends = new Set(await friendIds(user.id));
  const classmates = all.filter(
    (u) =>
      detailsVisible(user.id, u, myFriends.has(u.id)) &&
      parseCourses(u.courses).some((x) => x.toLowerCase() === courseName.toLowerCase())
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
    .where(and(ne(users.id, user.id), isNotNull(users.claimedAt)))
    .orderBy(sql`random()`)
    .limit(10);

  const recent = await db
    .select()
    .from(users)
    .where(isNotNull(users.claimedAt))
    .orderBy(desc(users.claimedAt), desc(users.id))
    .limit(10);

  const statusMap = await friendshipStatuses(user.id, [
    ...new Set([...random, ...recent].map((r) => r.id)),
  ]);
  const myFriendIds = await friendIds(user.id);
  const myFriends = myFriendIds.length
    ? await db.select().from(users).where(inArray(users.id, myFriendIds))
    : [];
  const stats = await joinedStats();

  return c.html(
    <Layout title="Social Net" user={user} banner="Social Network">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <p class="stats-line">
              <b>{stats.joined}</b> of <b>{stats.total}</b> QAIRU students have joined
              theqairubook · <a href="/search?joined=no">find classmates to invite</a>
            </p>
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
            <Box title="[ Recently Joined ]">
              {recent.length ? (
                <table class="bordertable">
                  {recent.map((r) => (
                    <tr>
                      <td>
                        <a href={`/profile/${r.id}`}>{r.name}</a>
                        <span class="rep-chip">{r.rep}</span>
                      </td>
                      <td class="meta">{r.claimedAt ? `joined ${timeAgo(r.claimedAt)}` : ""}</td>
                      <td class="actions">
                        {r.id === user.id ? (
                          <span class="meta">(you)</span>
                        ) : (
                          <FriendButton
                            userId={r.id}
                            status={statusMap.get(r.id) ?? "none"}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </table>
              ) : (
                <p class="meta">Nobody has joined yet.</p>
              )}
            </Box>
            <Box title="[ 10 Random People at QAIRU ]">
              {random.length ? (
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
                  {random.map((r) => {
                    const shown = detailsVisible(user.id, r, statusMap.get(r.id) === "friends");
                    return (
                    <tr>
                      <td>
                        <a href={`/profile/${r.id}`}>{r.name}</a>
                        <span class="rep-chip">{r.rep}</span>
                      </td>
                      <td>{shown ? r.status : "—"}</td>
                      <td>{(shown && r.residence) || "—"}</td>
                      <td class="actions">
                        <FriendButton
                          userId={r.id}
                          status={statusMap.get(r.id) ?? "none"}
                        />
                      </td>
                    </tr>
                    );
                  })}
                </table>
              ) : (
                <p class="meta">You're the first one here. Invite some classmates!</p>
              )}
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
});
