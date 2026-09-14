import { Hono } from "hono";
import type { Context } from "hono";
import { and, desc, eq, ilike, inArray, or, sql, count, type SQL } from "drizzle-orm";
import type { AppEnv } from "../middleware/auth.js";
import { isAdmin, needLogin } from "../middleware/auth.js";
import {
  Layout,
  LeftNav,
  Box,
  VoteBox,
  UserLink,
  Linkified,
  FLAIRS,
  isFlair,
  FlairTag,
  Attachments,
  UploadField,
  timeAgo,
  type Flair,
} from "../views/layout.js";
import { db } from "../db/index.js";
import {
  boards,
  discussionPosts,
  discussionComments,
  savedPosts,
  users,
  type Board,
  type DiscussionComment,
  type DiscussionPost,
  type Media,
  type User,
} from "../db/schema.js";
import { addBoardEvent, buildTree, type TreeNode } from "../lib/social.js";
import { REP, awardReply, myVotes, setAcceptedAnswer } from "../lib/rep.js";
import { backPath, publicOrigin, safeHref } from "../lib/url.js";
import { withinLimit } from "../lib/security.js";
import {
  MEDIA_LIMITS,
  deleteMediaForComment,
  deleteMediaForPost,
  filesFromBody,
  mediaForComments,
  mediaForPosts,
  mediaUsage,
  prepareUploads,
  storeUploads,
  withUploadLock,
} from "../lib/media.js";
import { sign, verifySignature } from "../auth/session.js";

export const discussRoutes = new Hono<AppEnv>();

const PAGE_SIZE = 25;
const MAX_PAGE = 1000;
const SEARCH_LIMIT = 50;
const PINNED_LIMIT = 50;
const RESERVED_SLUGS = ["submit", "boards", "p", "c", "post", "comment", "all", "saved", "search"];
type Sort = "hot" | "new" | "top";

const authorCols = { id: users.id, name: users.name, rep: users.rep, claimedAt: users.claimedAt };
type Author = { id: number; name: string; rep: number; claimedAt: Date | null };
type ListRow = { post: DiscussionPost; author: Author; board: Board };

const SLOW_DOWN = "Slow down a little — you've been posting a lot. Try again in a few minutes.";
const SLOW_UPLOADS = "You've uploaded a lot of files recently. Try again in a few minutes.";

// Board-creation errors travel as a fixed code, so a crafted link can't put
// arbitrary text on the page.
const BOARD_ERRORS = {
  taken: "That board name is taken.",
  invalid: "Use 3–24 lowercase letters, numbers, - or _ for the board name.",
  reserved: "That name is reserved.",
  name: "Give your board a name.",
} as const;
type BoardError = keyof typeof BOARD_ERRORS;

function boardErrorOf(c: Context<AppEnv>): string | null {
  const code = c.req.query("board_error");
  return code && Object.prototype.hasOwnProperty.call(BOARD_ERRORS, code)
    ? BOARD_ERRORS[code as BoardError]
    : null;
}

/** Back to the discussions page the form was on, with the error code attached. */
function boardErrorRedirect(c: Context<AppEnv>, code: BoardError): string {
  const back = backPath(c, "/d");
  const url = new URL(back.startsWith("/d") ? back : "/d", "http://local");
  if (url.pathname !== "/d" && !url.pathname.startsWith("/d/")) url.pathname = "/d";
  url.searchParams.set("board_error", code);
  return `${url.pathname}${url.search}#start-board`;
}

/** What an upload-locked create returns: the created row, or a user-facing error. */
type Locked<T> = T | { error: string };

/** Postgres int ids from route params / form fields. */
function idParam(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

/** A string field from parseBody({ all: true }), which may be repeated. */
function field(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === "string" ? first : "";
}

function parseSort(value: string | undefined): Sort {
  return value === "new" || value === "top" ? value : "hot";
}

function parseFlair(value: string | undefined): Flair | null {
  return isFlair(value) ? value : null;
}

function orderFor(sort: Sort) {
  if (sort === "new") return [desc(discussionPosts.createdAt)];
  if (sort === "top") return [desc(discussionPosts.score), desc(discussionPosts.createdAt)];
  // Reddit's hot ranking: log-scaled score plus a time bonus.
  return [
    desc(
      sql`(sign(${discussionPosts.score}) * log(greatest(abs(${discussionPosts.score}), 1)))::float8
        + extract(epoch from ${discussionPosts.createdAt})::float8 / 45000`
    ),
  ];
}

function listingFilters(boardId: number | null, flair: Flair | null): SQL[] {
  const where: SQL[] = [eq(discussionPosts.deleted, false)];
  if (boardId) where.push(eq(discussionPosts.boardId, boardId));
  if (flair) where.push(eq(discussionPosts.flair, flair));
  return where;
}

function selectRows() {
  return db
    .select({ post: discussionPosts, author: authorCols, board: boards })
    .from(discussionPosts)
    .innerJoin(users, eq(discussionPosts.authorUserId, users.id))
    .innerJoin(boards, eq(discussionPosts.boardId, boards.id));
}

// Pinned posts are listed separately on page 1, so the paged list skips them.
async function listPosts(boardId: number | null, sort: Sort, page: number, flair: Flair | null) {
  return selectRows()
    .where(and(...listingFilters(boardId, flair), eq(discussionPosts.pinned, false)))
    .orderBy(...orderFor(sort))
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE);
}

async function pinnedPosts(boardId: number | null, flair: Flair | null) {
  return selectRows()
    .where(and(...listingFilters(boardId, flair), eq(discussionPosts.pinned, true)))
    .orderBy(desc(discussionPosts.createdAt))
    .limit(PINNED_LIMIT);
}

async function boardsWithCounts() {
  return db
    .select({ board: boards, posts: count(discussionPosts.id) })
    .from(boards)
    .leftJoin(
      discussionPosts,
      and(eq(discussionPosts.boardId, boards.id), eq(discussionPosts.deleted, false))
    )
    .groupBy(boards.id)
    .orderBy(boards.id);
}

async function savedIds(userId: number, postIds: number[]): Promise<Set<number>> {
  if (!postIds.length) return new Set();
  const rows = await db
    .select({ postId: savedPosts.postId })
    .from(savedPosts)
    .where(and(eq(savedPosts.userId, userId), inArray(savedPosts.postId, postIds)));
  return new Set(rows.map((r) => r.postId));
}

/** Everything a listing row needs besides the row itself, in three queries. */
async function rowExtras(viewerId: number, rows: ListRow[]) {
  const ids = rows.map((r) => r.post.id);
  const [votes, attachments, saved] = await Promise.all([
    myVotes(viewerId, "post", ids),
    mediaForPosts(ids),
    savedIds(viewerId, ids),
  ]);
  return { votes, attachments, saved };
}
type RowExtras = Awaited<ReturnType<typeof rowExtras>>;

function postUrl(board: Pick<Board, "slug">, post: Pick<DiscussionPost, "id">) {
  return `/d/${board.slug}/${post.id}`;
}

function listHref(base: string, p: { sort?: Sort; flair?: Flair | null; page?: number }) {
  const params = new URLSearchParams();
  if (p.sort && p.sort !== "hot") params.set("sort", p.sort);
  if (p.flair) params.set("flair", p.flair);
  if (p.page && p.page > 1) params.set("page", String(p.page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function submitHref(board: Board | null, flair?: Flair | null) {
  const params = new URLSearchParams();
  if (board) params.set("board", board.slug);
  if (flair && flair !== "announcement") params.set("flair", flair);
  const qs = params.toString();
  return qs ? `/d/submit?${qs}` : "/d/submit";
}

function isSolved(post: Pick<DiscussionPost, "flair" | "acceptedCommentId">) {
  return post.flair === "question" && post.acceptedCommentId != null;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Comment errors travel through a redirect; signing stops crafted links from
// putting arbitrary text on the page.
function errorRedirect(url: string, postId: number, message: string) {
  const params = new URLSearchParams({ err: message, es: sign(`discuss-err:${postId}:${message}`) });
  return `${url}?${params.toString()}#comment-form`;
}

function readError(c: Context<AppEnv>, postId: number): string | null {
  const message = c.req.query("err");
  const sig = c.req.query("es");
  if (!message || !sig) return null;
  return verifySignature(`discuss-err:${postId}:${message}`, sig) ? message : null;
}

const SaveButton = ({ postId, saved }: { postId: number; saved: boolean }) => (
  <form method="post" action={`/d/post/${postId}/save`} class="inline-form">
    <button
      class="btn-link"
      type="submit"
      title={saved ? "Remove from your saved posts" : "Keep this post in your saved posts"}
    >
      {saved ? "unsave" : "save"}
    </button>
  </form>
);

function PostRow(props: {
  row: ListRow;
  viewer: User;
  extras: RowExtras;
  showBoard: boolean;
  rank?: number;
}) {
  const { row, viewer, extras, showBoard, rank } = props;
  const { post, author, board } = row;
  const href = postUrl(board, post);
  const link = safeHref(post.url);
  const files = extras.attachments.get(post.id)?.length ?? 0;
  return (
    <div class={post.pinned ? "post-row pinned" : "post-row"} id={`post-${post.id}`}>
      {rank ? <div class="rank">{rank}</div> : null}
      <VoteBox
        type="post"
        id={post.id}
        score={post.score}
        myVote={extras.votes.get(post.id)}
        own={post.authorUserId === viewer.id}
      />
      <div class="post-main">
        {post.pinned ? (
          <span class="pin-mark" title="Pinned by an admin">
            📌
          </span>
        ) : null}
        <FlairTag flair={post.flair} solved={isSolved(post)} />{" "}
        <a class="post-title" href={link ?? href}>
          {post.title}
        </a>
        {link ? <span class="meta"> ({domainOf(link)})</span> : null}
        <div class="meta">
          submitted {timeAgo(post.createdAt)} by{" "}
          <a href={`/profile/${author.id}`}>{author.name}</a>
          <span class="rep-chip">{author.rep}</span>
          {showBoard ? (
            <>
              {" "}
              to <a href={`/d/${board.slug}`}>q/{board.slug}</a>
            </>
          ) : null}
        </div>
        <div class="post-links">
          <a href={href}>
            <b>
              {post.commentCount} comment{post.commentCount === 1 ? "" : "s"}
            </b>
          </a>
          {files ? (
            <span class="attach-count" title={`${files} attachment${files === 1 ? "" : "s"}`}>
              {" · "}📎 {files}
            </span>
          ) : null}
          {" · "}
          <SaveButton postId={post.id} saved={extras.saved.has(post.id)} />
        </div>
      </div>
    </div>
  );
}

async function BoardsBox(props: { current?: string; viewer: User; error?: string | null }) {
  const { current, viewer, error } = props;
  const all = await boardsWithCounts();
  return (
    <Box title="[ Boards ]">
      <div class="board-list">
        <a href="/d" class={!current ? "current" : ""}>
          front page
        </a>
        {all.map(({ board, posts }) => (
          <a href={`/d/${board.slug}`} class={current === board.slug ? "current" : ""}>
            q/{board.slug} <span class="meta">({posts})</span>
          </a>
        ))}
      </div>
      <hr class="thin" />
      <div class="board-list">
        <a href="/d/saved" class={current === "saved" ? "current" : ""}>
          ★ saved posts
        </a>
        <a href="/d/search" class={current === "search" ? "current" : ""}>
          search
        </a>
      </div>
      <hr class="thin" />
      {viewer.rep >= REP.createBoard ? (
        <details id="start-board" open={error ? true : undefined}>
          <summary>
            <b>+ start a board</b>
          </summary>
          {error ? <p class="error board-error">{error}</p> : null}
          <form method="post" action="/d/boards" class="stack-form">
            <label>
              q/
              <input type="text" name="slug" size={14} required pattern="[a-z0-9_\-]{3,24}" placeholder="robotics" />
            </label>
            <input type="text" name="name" size={22} required maxlength={40} placeholder="Name" />
            <input type="text" name="description" size={22} maxlength={140} placeholder="What's it about?" />
            <button class="btn btn-small" type="submit">
              Create
            </button>
          </form>
        </details>
      ) : (
        <p class="meta">
          Reach {REP.createBoard} rep to start your own board. You have{" "}
          {viewer.rep}.
        </p>
      )}
    </Box>
  );
}

const SortTabs = ({ base, sort, flair }: { base: string; sort: Sort; flair: Flair | null }) => (
  <div class="tabs">
    {(["hot", "new", "top"] as Sort[]).map((s) => (
      <a href={listHref(base, { sort: s, flair })} class={s === sort ? "tab current" : "tab"}>
        {s}
      </a>
    ))}
  </div>
);

const FLAIR_TABS: { flair: Flair | null; label: string }[] = [
  { flair: null, label: "All" },
  { flair: "question", label: "Questions" },
  { flair: "material", label: "Materials" },
  { flair: "discussion", label: "Discussions" },
];

const FlairTabs = ({ base, sort, flair }: { base: string; sort: Sort; flair: Flair | null }) => (
  <div class="flair-tabs">
    {FLAIR_TABS.map((t, i) => (
      <>
        {i > 0 ? " · " : null}
        {t.flair === flair ? (
          <b class="current">{t.label}</b>
        ) : (
          <a href={listHref(base, { sort, flair: t.flair })}>{t.label}</a>
        )}
      </>
    ))}
    {flair === "announcement" ? (
      <>
        {" · "}
        <b class="current">Announcements</b>
      </>
    ) : null}
  </div>
);

const SearchBox = (props: { q?: string; board?: Board | null }) => (
  <form method="get" action="/d/search" class="discuss-search">
    <input
      type="text"
      name="q"
      value={props.q ?? ""}
      maxlength={100}
      placeholder="Search questions, materials, discussions…"
    />
    {props.board ? (
      <label class="meta">
        <input type="checkbox" name="board" value={props.board.slug} checked /> only q/
        {props.board.slug}
      </label>
    ) : null}
    <button class="btn btn-small" type="submit">
      Search
    </button>
  </form>
);

function EmptyListing({ board, flair }: { board: Board | null; flair: Flair | null }) {
  const href = submitHref(board, flair);
  const where = board ? ` in q/${board.slug}` : "";
  if (flair === "question")
    return (
      <p class="empty-state">
        No questions yet{where} — <a href={href}>ask the first one</a>. Stuck on homework or a
        bug? Someone here has probably been there.
      </p>
    );
  if (flair === "material")
    return (
      <p class="empty-state">
        No materials yet{where} — <a href={href}>share your notes, PDFs or useful links</a> and
        help the next person studying for the same course.
      </p>
    );
  if (flair === "discussion")
    return (
      <p class="empty-state">
        No discussions yet{where} — <a href={href}>start one</a>.
      </p>
    );
  if (flair === "announcement")
    return <p class="empty-state">No announcements{where}.</p>;
  return (
    <p class="empty-state">
      Nothing here yet{where}. <a href={href}>Ask a question, share a material or start a
      discussion</a> — the first post sets the tone.
    </p>
  );
}

async function renderListing(c: Context<AppEnv>, viewer: User, board: Board | null) {
  const sort = parseSort(c.req.query("sort"));
  const flair = parseFlair(c.req.query("flair"));
  const page = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(c.req.query("page") ?? 1)) || 1));
  const [rows, pinned] = await Promise.all([
    listPosts(board?.id ?? null, sort, page, flair),
    page === 1 ? pinnedPosts(board?.id ?? null, flair) : Promise.resolve([] as ListRow[]),
  ]);
  const hasMore = rows.length > PAGE_SIZE;
  const shown = rows.slice(0, PAGE_SIZE);
  const extras = await rowExtras(viewer.id, [...pinned, ...shown]);
  const base = board ? `/d/${board.slug}` : "/d";

  return c.html(
    <Layout
      title={board ? `q/${board.slug}` : "Discussions"}
      user={viewer}
      banner={board ? `q/${board.slug} · ${board.name}` : "Discussions"}
    >
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={viewer} />
            <BoardsBox current={board?.slug} viewer={viewer} error={boardErrorOf(c)} />
          </td>
          <td class="maincol">
            <SearchBox board={board} />
            <div class="listing-head">
              <SortTabs base={base} sort={sort} flair={flair} />
              <a class="btn" href={submitHref(board, flair)}>
                + New Post
              </a>
            </div>
            <FlairTabs base={base} sort={sort} flair={flair} />
            {pinned.length ? (
              <Box title="[ 📌 Pinned ]">
                {pinned.map((r) => (
                  <PostRow row={r} viewer={viewer} extras={extras} showBoard={!board} />
                ))}
              </Box>
            ) : null}
            <Box
              title={
                board
                  ? `[ q/${board.slug} ] ${board.description}`
                  : "[ Front Page ] the best of every QAIRU board"
              }
              alt
            >
              {shown.length ? (
                shown.map((r, i) => (
                  <PostRow
                    row={r}
                    viewer={viewer}
                    extras={extras}
                    showBoard={!board}
                    rank={(page - 1) * PAGE_SIZE + i + 1}
                  />
                ))
              ) : page > 1 ? (
                <p class="empty-state">
                  No more posts. <a href={listHref(base, { sort, flair })}>Back to page 1</a>.
                </p>
              ) : pinned.length ? (
                <p class="meta">That's everything for now.</p>
              ) : (
                <EmptyListing board={board} flair={flair} />
              )}
              {page > 1 || hasMore ? (
                <p class="pager">
                  {page > 1 ? (
                    <a href={listHref(base, { sort, flair, page: page - 1 })}>‹ prev</a>
                  ) : null}
                  {page > 1 && hasMore ? " · " : null}
                  {hasMore ? (
                    <a href={listHref(base, { sort, flair, page: page + 1 })}>next ›</a>
                  ) : null}
                </p>
              ) : null}
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
}

async function boardBySlug(slug: string) {
  const [board] = await db.select().from(boards).where(eq(boards.slug, slug)).limit(1);
  return board ?? null;
}

discussRoutes.get("/d", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  return renderListing(c, gate.user, null);
});

type SubmitValues = { title: string; body: string; url: string; flair: string };

discussRoutes.get("/d/submit", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const flair = parseFlair(c.req.query("flair")) ?? "discussion";
  return c.html(
    await submitForm(gate.user, c.req.query("board") ?? "general", undefined, {
      title: "",
      body: "",
      url: "",
      flair,
    })
  );
});

discussRoutes.post("/d/submit", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const body = await c.req.parseBody({ all: true });
  const slug = field(body, "board");
  const title = field(body, "title").trim().replace(/\s+/g, " ");
  const text = field(body, "body").trim();
  const rawUrl = field(body, "url").trim();
  const flair = parseFlair(field(body, "flair") || "discussion");
  const values: SubmitValues = { title, body: text, url: rawUrl, flair: flair ?? "discussion" };
  const files = filesFromBody(body);
  // Browsers never refill file inputs, so say so when files were dropped.
  const fail = async (message: string) =>
    c.html(
      await submitForm(
        user,
        slug,
        files.length ? `${message} (Please pick your files again.)` : message,
        values
      )
    );

  const board = await boardBySlug(slug);
  if (!board) return fail("Pick a board.");
  if (!flair) return fail("Pick a flair.");
  if (flair === "announcement" && !isAdmin(user)) {
    values.flair = "discussion";
    return fail("Only admins can post announcements.");
  }
  if (title.length < 3) return fail("Title is too short.");
  const url = rawUrl ? safeHref(rawUrl) : "";
  if (url === null) return fail("That link doesn't look valid.");
  if (!withinLimit("postsPerUser", user.id)) return fail(SLOW_DOWN);

  // Validate → insert → store under the user's upload lock, so parallel
  // submits can't each pass the quota / daily-count check.
  const outcome = await withUploadLock<Locked<{ post: DiscussionPost }>>(user.id, async () => {
    let prepared: Awaited<ReturnType<typeof prepareUploads>>["prepared"] = [];
    if (files.length) {
      if (!withinLimit("uploadsPerUser", user.id)) return { error: SLOW_UPLOADS };
      const result = await prepareUploads(user.id, files, MEDIA_LIMITS.filesPerPost);
      if (result.error) return { error: result.error };
      prepared = result.prepared;
    }
    const [created] = await db
      .insert(discussionPosts)
      .values({
        boardId: board.id,
        authorUserId: user.id,
        title: title.slice(0, 300),
        body: text.slice(0, 10000),
        url,
        flair,
      })
      .returning();
    await storeUploads(user.id, prepared, { postId: created.id });
    return { post: created };
  });
  if ("error" in outcome) return fail(outcome.error);
  const { post } = outcome;

  await addBoardEvent(
    user.id,
    "discussion",
    JSON.stringify({ postId: post.id, slug: board.slug, title: post.title })
  );
  return c.redirect(postUrl(board, post));
});

discussRoutes.post("/d/boards", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  if (user.rep < REP.createBoard) return c.redirect("/d");
  const body = await c.req.parseBody();
  const slug = String(body.slug ?? "").trim().toLowerCase();
  const name = String(body.name ?? "").trim().slice(0, 40);
  const description = String(body.description ?? "").trim().slice(0, 140);
  if (!/^[a-z0-9_-]{3,24}$/.test(slug)) return c.redirect(boardErrorRedirect(c, "invalid"));
  if (RESERVED_SLUGS.includes(slug)) return c.redirect(boardErrorRedirect(c, "reserved"));
  if (!name) return c.redirect(boardErrorRedirect(c, "name"));
  const [created] = await db
    .insert(boards)
    .values({ slug, name, description, createdByUserId: user.id })
    .onConflictDoNothing()
    .returning();
  // Only land on the board when this request actually created it; a conflict
  // means the slug already belongs to someone else's board.
  if (!created) return c.redirect(boardErrorRedirect(c, "taken"));
  return c.redirect(`/d/${created.slug}`);
});

// Short permalinks used by the rep history and "copy link".
discussRoutes.get("/d/p/:id{[0-9]+}", async (c) => {
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const [row] = await db
    .select({ post: discussionPosts, board: boards })
    .from(discussionPosts)
    .innerJoin(boards, eq(discussionPosts.boardId, boards.id))
    .where(eq(discussionPosts.id, id))
    .limit(1);
  return row ? c.redirect(postUrl(row.board, row.post)) : c.notFound();
});

discussRoutes.get("/d/c/:id{[0-9]+}", async (c) => {
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const [row] = await db
    .select({ comment: discussionComments, post: discussionPosts, board: boards })
    .from(discussionComments)
    .innerJoin(discussionPosts, eq(discussionComments.postId, discussionPosts.id))
    .innerJoin(boards, eq(discussionPosts.boardId, boards.id))
    .where(eq(discussionComments.id, id))
    .limit(1);
  return row
    ? c.redirect(`${postUrl(row.board, row.post)}#c-${row.comment.id}`)
    : c.notFound();
});

// /d/saved and /d/search must be registered before /d/:slug.
discussRoutes.get("/d/saved", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const viewer = gate.user;
  const rows: ListRow[] = await db
    .select({ post: discussionPosts, author: authorCols, board: boards })
    .from(savedPosts)
    .innerJoin(discussionPosts, eq(savedPosts.postId, discussionPosts.id))
    .innerJoin(users, eq(discussionPosts.authorUserId, users.id))
    .innerJoin(boards, eq(discussionPosts.boardId, boards.id))
    .where(and(eq(savedPosts.userId, viewer.id), eq(discussionPosts.deleted, false)))
    .orderBy(desc(savedPosts.createdAt))
    .limit(200);
  const extras = await rowExtras(viewer.id, rows);

  return c.html(
    <Layout title="Saved Posts" user={viewer} banner="Your saved posts">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={viewer} />
            <BoardsBox current="saved" viewer={viewer} error={boardErrorOf(c)} />
          </td>
          <td class="maincol">
            <SearchBox />
            <Box title="[ Saved Posts ] only you can see this list" alt>
              {rows.length ? (
                rows.map((r) => (
                  <PostRow row={r} viewer={viewer} extras={extras} showBoard={true} />
                ))
              ) : (
                <div class="empty-state">
                  <p>
                    <b>Nothing saved yet.</b>
                  </p>
                  <p>
                    Saving is for keeping materials and answers you want to find later — lecture
                    notes before an exam, a question that solved your bug, a useful link. Hit{" "}
                    <b>save</b> under any post and it shows up here. Nobody else sees what you
                    save.
                  </p>
                  <p>
                    <a href="/d?flair=material">Browse materials</a> ·{" "}
                    <a href="/d?flair=question">Browse questions</a>
                  </p>
                </div>
              )}
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
});

discussRoutes.get("/d/search", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const viewer = gate.user;
  const q = (c.req.query("q") ?? "").trim().replace(/\s+/g, " ").slice(0, 100);
  const boardSlug = c.req.query("board") ?? "";
  const flair = parseFlair(c.req.query("flair"));
  const allBoards = await db.select().from(boards).orderBy(boards.id);
  const board = allBoards.find((b) => b.slug === boardSlug) ?? null;

  let rows: ListRow[] = [];
  const searched = q.length >= 2;
  if (searched) {
    // Treat the user's % and _ literally.
    const pattern = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const where: SQL[] = listingFilters(board?.id ?? null, flair);
    where.push(or(ilike(discussionPosts.title, pattern), ilike(discussionPosts.body, pattern))!);
    rows = await selectRows()
      .where(and(...where))
      .orderBy(desc(discussionPosts.score), desc(discussionPosts.createdAt))
      .limit(SEARCH_LIMIT);
  }
  const extras = await rowExtras(viewer.id, rows);

  return c.html(
    <Layout title={q ? `Search: ${q}` : "Search Discussions"} user={viewer} banner="Search Discussions">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={viewer} />
            <BoardsBox current="search" viewer={viewer} error={boardErrorOf(c)} />
          </td>
          <td class="maincol">
            <Box title="[ Search ]">
              <form method="get" action="/d/search" class="discuss-search full">
                <input
                  type="text"
                  name="q"
                  value={q}
                  maxlength={100}
                  placeholder="e.g. linear algebra midterm, segfault, lecture 5 notes"
                />
                <select name="board">
                  <option value="">all boards</option>
                  {allBoards.map((b) => (
                    <option value={b.slug} selected={b.slug === board?.slug}>
                      q/{b.slug}
                    </option>
                  ))}
                </select>
                <select name="flair">
                  <option value="">any flair</option>
                  {(Object.keys(FLAIRS) as Flair[]).map((f) => (
                    <option value={f} selected={f === flair}>
                      {FLAIRS[f]}
                    </option>
                  ))}
                </select>
                <button class="btn btn-small" type="submit">
                  Search
                </button>
              </form>
              <p class="meta">Searches post titles and text. Best-voted posts come first.</p>
            </Box>
            <Box
              title={
                searched
                  ? `[ Results ] ${rows.length}${rows.length === SEARCH_LIMIT ? "+" : ""} for "${q}"`
                  : "[ Results ]"
              }
              alt
            >
              {!searched ? (
                <p class="empty-state">
                  {q ? "Type at least 2 characters." : "Type something to search for."} Looking
                  for study material? Try the course name or code.
                </p>
              ) : rows.length ? (
                rows.map((r) => (
                  <PostRow row={r} viewer={viewer} extras={extras} showBoard={true} />
                ))
              ) : (
                <p class="empty-state">
                  Nothing matches "{q}". Try fewer words, or{" "}
                  <a href={submitHref(board, "question")}>ask it as a question</a>.
                </p>
              )}
              {rows.length === SEARCH_LIMIT ? (
                <p class="meta">Showing the top {SEARCH_LIMIT}. Add words to narrow it down.</p>
              ) : null}
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
});

discussRoutes.get("/d/:slug", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const board = await boardBySlug(c.req.param("slug"));
  if (!board) return c.notFound();
  return renderListing(c, gate.user, board);
});

type CommentRow = DiscussionComment & { author: Author };

type ThreadContext = {
  viewer: User;
  action: string;
  votes: Map<number, number>;
  media: Map<number, Media[]>;
  opId: number;
  postId: number;
  acceptedId: number | null;
  canAccept: boolean;
  admin: boolean;
  usedBytes: number;
};

const AcceptForm = ({ postId, commentId, label }: { postId: number; commentId: string; label: string }) => (
  <form method="post" action={`/d/post/${postId}/accept`} class="inline-form">
    <input type="hidden" name="commentId" value={commentId} />
    <button class={commentId ? "btn-link accept-link" : "btn-link"} type="submit">
      {label}
    </button>
  </form>
);

function CommentThread(props: { node: TreeNode<CommentRow>; ctx: ThreadContext; depth: number }) {
  const { node, ctx, depth } = props;
  const { viewer } = ctx;
  const accepted = !node.deleted && node.id === ctx.acceptedId;
  return (
    <div class={accepted ? "comment accepted" : "comment"} id={`c-${node.id}`}>
      <div class="thing">
        {node.deleted ? (
          <div class="vote vote-placeholder" />
        ) : (
          <VoteBox
            type="comment"
            id={node.id}
            score={node.score}
            myVote={ctx.votes.get(node.id)}
            own={node.authorUserId === viewer.id}
          />
        )}
        <div class="thing-body">
          <div class="meta">
            {node.deleted ? (
              <span>[deleted]</span>
            ) : (
              <>
                <UserLink user={node.author} />
                {node.authorUserId === ctx.opId ? <span class="op-tag">OP</span> : null}
                {accepted ? <span class="answer-badge">✓ answer</span> : null}
              </>
            )}{" "}
            · {node.score} point{node.score === 1 || node.score === -1 ? "" : "s"} ·{" "}
            {timeAgo(node.createdAt)}
          </div>
          <div class="post-text">
            {node.deleted ? <span class="meta">[deleted]</span> : <Linkified text={node.body} />}
          </div>
          {!node.deleted ? <Attachments items={ctx.media.get(node.id)} compact /> : null}
          {!node.deleted ? (
            <div class="thing-actions">
              <details class="reply-box">
                <summary>reply</summary>
                <form method="post" action={ctx.action} enctype="multipart/form-data">
                  <input type="hidden" name="parentId" value={String(node.id)} />
                  <textarea name="body" rows={3} required maxlength={5000} />
                  <UploadField max={MEDIA_LIMITS.filesPerComment} usedBytes={ctx.usedBytes} />
                  <button class="btn btn-small" type="submit">
                    Reply
                  </button>
                </form>
              </details>
              {ctx.canAccept ? (
                accepted ? (
                  <AcceptForm postId={ctx.postId} commentId="" label="unmark answer" />
                ) : (
                  <AcceptForm postId={ctx.postId} commentId={String(node.id)} label="✓ mark as answer" />
                )
              ) : null}
              {node.authorUserId === viewer.id || ctx.admin ? (
                <form
                  method="post"
                  action={`/d/comment/${node.id}/delete`}
                  class="inline-form"
                  data-confirm="Delete this comment?"
                >
                  <button class="btn-link" type="submit">
                    delete
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {node.children.length ? (
        <div class={depth < 6 ? "children" : "children flat"}>
          {node.children.map((child) => (
            <CommentThread node={child} ctx={ctx} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

discussRoutes.get("/d/:slug/:postId{[0-9]+}", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const viewer = gate.user;
  const postId = idParam(c.req.param("postId"));
  if (!postId) return c.notFound();
  const board = await boardBySlug(c.req.param("slug"));
  if (!board) return c.notFound();

  const [row] = await db
    .select({ post: discussionPosts, author: authorCols })
    .from(discussionPosts)
    .innerJoin(users, eq(discussionPosts.authorUserId, users.id))
    .where(and(eq(discussionPosts.id, postId), eq(discussionPosts.boardId, board.id)))
    .limit(1);
  if (!row) return c.notFound();
  const { post, author } = row;
  const admin = isAdmin(viewer);

  const commentSort = c.req.query("sort") === "new" ? "new" : "best";
  const comments: CommentRow[] = (
    await db
      .select({ comment: discussionComments, author: authorCols })
      .from(discussionComments)
      .innerJoin(users, eq(discussionComments.authorUserId, users.id))
      .where(eq(discussionComments.postId, post.id))
      .limit(1000)
  ).map((r) => ({ ...r.comment, author: r.author }));

  const tree = buildTree(comments, (a, b) =>
    commentSort === "new"
      ? b.createdAt.getTime() - a.createdAt.getTime()
      : b.score - a.score || a.createdAt.getTime() - b.createdAt.getTime()
  );
  const liveCommentIds = comments.filter((cm) => !cm.deleted).map((cm) => cm.id);
  const [postVote, commentVotes, postMedia, commentMedia, saved, usage] = await Promise.all([
    myVotes(viewer.id, "post", [post.id]),
    myVotes(viewer.id, "comment", liveCommentIds),
    post.deleted ? Promise.resolve(new Map<number, Media[]>()) : mediaForPosts([post.id]),
    mediaForComments(liveCommentIds),
    savedIds(viewer.id, [post.id]),
    mediaUsage(viewer.id),
  ]);

  const action = `${postUrl(board, post)}/comment`;
  const link = safeHref(post.url);
  const permalink = `${publicOrigin(c)}/d/p/${post.id}`;
  const isQuestion = post.flair === "question";
  const answer =
    isQuestion && post.acceptedCommentId != null
      ? comments.find((cm) => cm.id === post.acceptedCommentId && !cm.deleted) ?? null
      : null;
  const ctx: ThreadContext = {
    viewer,
    action,
    votes: commentVotes,
    media: commentMedia,
    opId: post.authorUserId,
    postId: post.id,
    acceptedId: answer?.id ?? null,
    canAccept: isQuestion && !post.deleted && (post.authorUserId === viewer.id || admin),
    admin,
    usedBytes: usage.bytes,
  };
  const commentError = readError(c, post.id);

  return c.html(
    <Layout title={post.title} user={viewer} banner={`q/${board.slug} · ${board.name}`}>
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={viewer} />
            <BoardsBox current={board.slug} viewer={viewer} error={boardErrorOf(c)} />
          </td>
          <td class="maincol">
            <div class="box">
              <div class="box-title-alt">
                <a href={`/d/${board.slug}`}>q/{board.slug}</a>
                {post.pinned ? <span class="pin-note"> · 📌 pinned</span> : null}
              </div>
              <div class="box-body">
                <div class="thing post-full">
                  <VoteBox
                    type="post"
                    id={post.id}
                    score={post.score}
                    myVote={postVote.get(post.id)}
                    own={post.authorUserId === viewer.id}
                  />
                  <div class="thing-body">
                    <div class="post-flairs">
                      <FlairTag flair={post.flair} solved={answer !== null} />
                    </div>
                    <div class="post-title big">{post.title}</div>
                    <div class="meta">
                      submitted {timeAgo(post.createdAt)} by{" "}
                      {post.deleted ? "[deleted]" : <UserLink user={author} />}
                    </div>
                    {link && !post.deleted ? (
                      <p>
                        <a href={link} target="_blank" rel="nofollow noopener">
                          {link}
                        </a>
                      </p>
                    ) : null}
                    <div class="post-text self-text">
                      {post.deleted ? (
                        <span class="meta">[deleted]</span>
                      ) : (
                        <Linkified text={post.body} />
                      )}
                    </div>
                    {!post.deleted ? <Attachments items={postMedia.get(post.id)} /> : null}
                    <div class="thing-actions post-actions">
                      <b>
                        {post.commentCount} comment{post.commentCount === 1 ? "" : "s"}
                      </b>
                      {!post.deleted ? (
                        <>
                          {" · "}
                          <SaveButton postId={post.id} saved={saved.has(post.id)} />
                        </>
                      ) : null}
                      {admin && !post.deleted ? (
                        <form method="post" action={`/d/post/${post.id}/pin`} class="inline-form">
                          {" · "}
                          <button class="btn-link" type="submit">
                            {post.pinned ? "unpin" : "pin"}
                          </button>
                        </form>
                      ) : null}
                      {(post.authorUserId === viewer.id || admin) && !post.deleted ? (
                        <form
                          method="post"
                          action={`/d/post/${post.id}/delete`}
                          class="inline-form"
                          data-confirm="Delete this post? Its attachments are removed too."
                        >
                          {" · "}
                          <button class="btn-link" type="submit">
                            delete
                          </button>
                        </form>
                      ) : null}
                    </div>
                    {!post.deleted ? (
                      <div class="permalink-row">
                        <input
                          type="text"
                          readonly
                          id={`permalink-${post.id}`}
                          class="permalink-input"
                          value={permalink}
                          data-select-on-click
                        />
                        <button
                          class="btn btn-small btn-gray"
                          type="button"
                          data-copy={`#permalink-${post.id}`}
                        >
                          copy link
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>

                {answer ? (
                  <div class="answer-box">
                    <div class="answer-title">
                      ✓ Answer
                      <span class="meta">
                        {" "}
                        accepted by the asker · <a href={`#c-${answer.id}`}>see it in the thread</a>
                      </span>
                    </div>
                    <div class="meta">
                      <UserLink user={answer.author} /> · {answer.score} point
                      {answer.score === 1 || answer.score === -1 ? "" : "s"} · {timeAgo(answer.createdAt)}
                    </div>
                    <div class="post-text">
                      <Linkified text={answer.body} />
                    </div>
                    <Attachments items={commentMedia.get(answer.id)} compact />
                  </div>
                ) : isQuestion && !post.deleted && ctx.canAccept && liveCommentIds.length ? (
                  <p class="answer-hint meta">
                    Did a reply solve it? Click <b>✓ mark as answer</b> under it so others with the
                    same question find it fast (and its author gets +{REP.acceptedAnswer} rep).
                  </p>
                ) : null}

                {!post.deleted ? (
                  <div id="comment-form" class="comment-form">
                    {commentError ? <p class="error">{commentError}</p> : null}
                    <form method="post" action={action} enctype="multipart/form-data">
                      <textarea
                        name="body"
                        rows={4}
                        required
                        maxlength={5000}
                        placeholder={
                          isQuestion
                            ? "Know the answer or have a hint? Explain how you'd solve it."
                            : "What are your thoughts?"
                        }
                      />
                      <UploadField max={MEDIA_LIMITS.filesPerComment} usedBytes={usage.bytes} />
                      <div class="btn-row">
                        <button class="btn" type="submit">
                          Comment
                        </button>
                      </div>
                    </form>
                  </div>
                ) : null}

                <div class="comment-sort meta">
                  sorted by:{" "}
                  <a href="?sort=best" class={commentSort === "best" ? "current" : ""}>
                    best
                  </a>{" "}
                  ·{" "}
                  <a href="?sort=new" class={commentSort === "new" ? "current" : ""}>
                    new
                  </a>
                </div>

                <div class="comments">
                  {tree.length ? (
                    tree.map((node) => <CommentThread node={node} ctx={ctx} depth={0} />)
                  ) : (
                    <p class="empty-state">
                      {post.deleted
                        ? "No comments."
                        : isQuestion
                          ? "No answers yet — if you know something that helps, be the first to reply."
                          : "No comments yet. Be the first!"}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </td>
        </tr>
      </table>
    </Layout>
  );
});

discussRoutes.post("/d/:slug/:postId{[0-9]+}/comment", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const postId = idParam(c.req.param("postId"));
  if (!postId) return c.notFound();
  const body = await c.req.parseBody({ all: true });
  const text = field(body, "body").trim();
  const rawParent = field(body, "parentId");
  const parentId = rawParent ? idParam(rawParent) : null;

  const [row] = await db
    .select({ post: discussionPosts, board: boards })
    .from(discussionPosts)
    .innerJoin(boards, eq(discussionPosts.boardId, boards.id))
    .where(eq(discussionPosts.id, postId))
    .limit(1);
  if (!row || row.post.deleted) return c.notFound();
  const { post } = row;
  const url = postUrl(row.board, post);
  const files = filesFromBody(body);
  if (rawParent && !parentId) return c.redirect(url);
  if (!text) {
    return c.redirect(
      files.length ? errorRedirect(url, postId, "Write a few words to go with your attachment.") : url
    );
  }

  let parent: DiscussionComment | undefined;
  if (parentId) {
    [parent] = await db
      .select()
      .from(discussionComments)
      .where(eq(discussionComments.id, parentId))
      .limit(1);
    if (!parent || parent.postId !== postId || parent.deleted) {
      return c.redirect(errorRedirect(url, postId, "That comment was deleted, so you can't reply to it."));
    }
  }

  if (!withinLimit("commentsPerUser", user.id)) {
    return c.redirect(errorRedirect(url, postId, SLOW_DOWN));
  }
  // Same lock as post submit: validate → insert → store runs one at a time per user.
  const outcome = await withUploadLock<Locked<{ comment: DiscussionComment }>>(user.id, async () => {
    let prepared: Awaited<ReturnType<typeof prepareUploads>>["prepared"] = [];
    if (files.length) {
      if (!withinLimit("uploadsPerUser", user.id)) return { error: SLOW_UPLOADS };
      const result = await prepareUploads(user.id, files, MEDIA_LIMITS.filesPerComment);
      if (result.error) return { error: `${result.error} Your comment wasn't posted.` };
      prepared = result.prepared;
    }
    const [created] = await db
      .insert(discussionComments)
      .values({
        postId,
        parentId,
        authorUserId: user.id,
        body: text.slice(0, 5000),
      })
      .returning();
    await db
      .update(discussionPosts)
      .set({ commentCount: sql`${discussionPosts.commentCount} + 1` })
      .where(eq(discussionPosts.id, postId));
    await storeUploads(user.id, prepared, { commentId: created.id });
    return { comment: created };
  });
  if ("error" in outcome) return c.redirect(errorRedirect(url, postId, outcome.error));
  const { comment } = outcome;

  if (parent) await awardReply(parent.authorUserId, user.id, "comment", parent.id);
  else await awardReply(post.authorUserId, user.id, "post", post.id);

  return c.redirect(`${url}#c-${comment.id}`);
});

discussRoutes.post("/d/post/:id{[0-9]+}/delete", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const [post] = await db.select().from(discussionPosts).where(eq(discussionPosts.id, id)).limit(1);
  if (!post) return c.notFound();
  if (!post.deleted && (post.authorUserId === user.id || isAdmin(user))) {
    await db.update(discussionPosts).set({ deleted: true }).where(eq(discussionPosts.id, id));
    await deleteMediaForPost(id);
  }
  return c.redirect(`/d/p/${id}`);
});

discussRoutes.post("/d/comment/:id{[0-9]+}/delete", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const [row] = await db
    .select({ comment: discussionComments, post: discussionPosts })
    .from(discussionComments)
    .innerJoin(discussionPosts, eq(discussionComments.postId, discussionPosts.id))
    .where(eq(discussionComments.id, id))
    .limit(1);
  if (!row) return c.notFound();
  const { comment, post } = row;
  if (!comment.deleted && (comment.authorUserId === user.id || isAdmin(user))) {
    await db.update(discussionComments).set({ deleted: true }).where(eq(discussionComments.id, id));
    await deleteMediaForComment(id);
    // A deleted comment can't stay the accepted answer (moves the rep back too).
    if (post.acceptedCommentId === id) await setAcceptedAnswer(post.id, null, user.id);
  }
  return c.redirect(`/d/c/${id}`);
});

discussRoutes.post("/d/post/:id{[0-9]+}/accept", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const body = await c.req.parseBody();
  const raw = typeof body.commentId === "string" ? body.commentId.trim() : "";
  const commentId = raw ? idParam(raw) : null;

  const [post] = await db.select().from(discussionPosts).where(eq(discussionPosts.id, id)).limit(1);
  if (!post) return c.notFound();
  const allowed =
    post.flair === "question" && !post.deleted && (post.authorUserId === user.id || isAdmin(user));
  if (allowed && !(raw && commentId === null)) {
    await setAcceptedAnswer(post.id, commentId, user.id);
  }
  return c.redirect(commentId ? `/d/c/${commentId}` : `/d/p/${post.id}`);
});

discussRoutes.post("/d/post/:id{[0-9]+}/pin", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  if (isAdmin(gate.user)) {
    await db
      .update(discussionPosts)
      .set({ pinned: sql`not ${discussionPosts.pinned}` })
      .where(eq(discussionPosts.id, id));
  }
  return c.redirect(backPath(c, `/d/p/${id}`));
});

discussRoutes.post("/d/post/:id{[0-9]+}/save", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const id = idParam(c.req.param("id"));
  if (!id) return c.notFound();
  const removed = await db
    .delete(savedPosts)
    .where(and(eq(savedPosts.userId, user.id), eq(savedPosts.postId, id)))
    .returning({ id: savedPosts.id });
  if (!removed.length) {
    const [post] = await db
      .select({ id: discussionPosts.id, deleted: discussionPosts.deleted })
      .from(discussionPosts)
      .where(eq(discussionPosts.id, id))
      .limit(1);
    if (!post) return c.notFound();
    if (!post.deleted) {
      await db.insert(savedPosts).values({ userId: user.id, postId: id }).onConflictDoNothing();
    }
  }
  return c.redirect(backPath(c, `/d/p/${id}`));
});

const FLAIR_CHOICES: { flair: Flair; hint: string }[] = [
  { flair: "discussion", hint: "talk about anything" },
  { flair: "question", hint: "ask for help; you can mark the answer" },
  { flair: "material", hint: "share notes, PDFs, links, resources" },
];

async function submitForm(
  user: User,
  selected: string,
  error?: string,
  values: SubmitValues = { title: "", body: "", url: "", flair: "discussion" }
) {
  const [all, usage] = await Promise.all([
    db.select().from(boards).orderBy(boards.id),
    mediaUsage(user.id),
  ]);
  const choices = isAdmin(user)
    ? [...FLAIR_CHOICES, { flair: "announcement" as Flair, hint: "official news for everyone (admins only)" }]
    : FLAIR_CHOICES;
  const checkedFlair = choices.some((ch) => ch.flair === values.flair) ? values.flair : "discussion";
  return (
    <Layout title="New Post" user={user} banner="Submit to Discussions">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
            <Box title="[ Tips ]">
              <ul class="bullets submit-tips">
                <li>Pick the right board and flair so people who can help find it.</li>
                <li>For questions, include what you tried and where you got stuck.</li>
                <li>Only share materials you have the right to share.</li>
                <li>Be kind — everyone here is a QAIRU student.</li>
              </ul>
            </Box>
          </td>
          <td class="maincol">
            <Box title="[ New Post ]" alt>
              {error ? <p class="error">{error}</p> : null}
              <form method="post" action="/d/submit" enctype="multipart/form-data">
                <table class="search-form wide-form">
                  <tr>
                    <td class="field-label">Board:</td>
                    <td>
                      <select name="board" required>
                        {all.map((b) => (
                          <option value={b.slug} selected={b.slug === selected}>
                            q/{b.slug} — {b.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Flair:</td>
                    <td>
                      <div class="flair-choices">
                        {choices.map((ch) => (
                          <label class="flair-choice">
                            <input
                              type="radio"
                              name="flair"
                              value={ch.flair}
                              checked={ch.flair === checkedFlair}
                              required
                            />{" "}
                            <FlairTag flair={ch.flair} /> <span class="meta">{ch.hint}</span>
                          </label>
                        ))}
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Title:</td>
                    <td>
                      <input
                        type="text"
                        name="title"
                        required
                        minlength={3}
                        maxlength={300}
                        value={values.title}
                        style="width:95%"
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Link (optional):</td>
                    <td>
                      <input
                        type="text"
                        name="url"
                        value={values.url}
                        placeholder="https://"
                        style="width:95%"
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Text:</td>
                    <td>
                      <textarea name="body" rows={8} maxlength={10000}>
                        {values.body}
                      </textarea>
                    </td>
                  </tr>
                  <tr>
                    <td class="field-label">Attachments:</td>
                    <td>
                      <UploadField max={MEDIA_LIMITS.filesPerPost} usedBytes={usage.bytes} />
                    </td>
                  </tr>
                </table>
                <div class="btn-row">
                  <button class="btn" type="submit">
                    Post
                  </button>
                  <span class="meta">
                    Upvotes on your post earn you rep. Be nice — this is QAIRU.
                  </span>
                </div>
              </form>
            </Box>
          </td>
        </tr>
      </table>
    </Layout>
  );
}
