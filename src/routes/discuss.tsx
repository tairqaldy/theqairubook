import { Hono } from "hono";
import type { Context } from "hono";
import { and, desc, eq, sql, count } from "drizzle-orm";
import type { AppEnv } from "../middleware/auth.js";
import { needLogin } from "../middleware/auth.js";
import {
  Layout,
  LeftNav,
  Box,
  VoteBox,
  UserLink,
  Linkified,
  timeAgo,
} from "../views/layout.js";
import { db } from "../db/index.js";
import {
  boards,
  discussionPosts,
  discussionComments,
  users,
  type Board,
  type DiscussionComment,
  type DiscussionPost,
  type User,
} from "../db/schema.js";
import { addBoardEvent, buildTree, type TreeNode } from "../lib/social.js";
import { REP, awardReply, myVotes } from "../lib/rep.js";
import { safeHref } from "../lib/url.js";

export const discussRoutes = new Hono<AppEnv>();

const PAGE_SIZE = 25;
const RESERVED_SLUGS = ["submit", "boards", "p", "c", "post", "comment", "all"];
type Sort = "hot" | "new" | "top";

const authorCols = { id: users.id, name: users.name, rep: users.rep };
type Author = { id: number; name: string; rep: number };

function parseSort(value: string | undefined): Sort {
  return value === "new" || value === "top" ? value : "hot";
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

async function listPosts(boardId: number | null, sort: Sort, page: number) {
  const where = boardId
    ? and(eq(discussionPosts.boardId, boardId), eq(discussionPosts.deleted, false))
    : eq(discussionPosts.deleted, false);
  return db
    .select({ post: discussionPosts, author: authorCols, board: boards })
    .from(discussionPosts)
    .innerJoin(users, eq(discussionPosts.authorUserId, users.id))
    .innerJoin(boards, eq(discussionPosts.boardId, boards.id))
    .where(where)
    .orderBy(...orderFor(sort))
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE);
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

function postUrl(board: Pick<Board, "slug">, post: Pick<DiscussionPost, "id">) {
  return `/d/${board.slug}/${post.id}`;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function PostRow(props: {
  post: DiscussionPost;
  author: Author;
  board: Board;
  viewer: User;
  myVote?: number;
  showBoard: boolean;
  rank?: number;
}) {
  const { post, author, board, viewer, myVote, showBoard, rank } = props;
  const href = postUrl(board, post);
  const link = safeHref(post.url);
  return (
    <div class="post-row" id={`post-${post.id}`}>
      {rank ? <div class="rank">{rank}</div> : null}
      <VoteBox
        type="post"
        id={post.id}
        score={post.score}
        myVote={myVote}
        own={post.authorUserId === viewer.id}
      />
      <div class="post-main">
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
        </div>
      </div>
    </div>
  );
}

async function BoardsBox({ current, viewer }: { current?: string; viewer: User }) {
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
      {viewer.rep >= REP.createBoard ? (
        <details>
          <summary>
            <b>+ start a board</b>
          </summary>
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

const SortTabs = ({ base, sort }: { base: string; sort: Sort }) => (
  <div class="tabs">
    {(["hot", "new", "top"] as Sort[]).map((s) => (
      <a href={`${base}?sort=${s}`} class={s === sort ? "tab current" : "tab"}>
        {s}
      </a>
    ))}
  </div>
);

async function renderListing(c: Context<AppEnv>, viewer: User, board: Board | null) {
  const sort = parseSort(c.req.query("sort"));
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const rows = await listPosts(board?.id ?? null, sort, page);
  const hasMore = rows.length > PAGE_SIZE;
  const shown = rows.slice(0, PAGE_SIZE);
  const votes = await myVotes(
    viewer.id,
    "post",
    shown.map((r) => r.post.id)
  );
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
            <BoardsBox current={board?.slug} viewer={viewer} />
          </td>
          <td class="maincol">
            <div class="listing-head">
              <SortTabs base={base} sort={sort} />
              <a
                class="btn"
                href={`/d/submit${board ? `?board=${board.slug}` : ""}`}
              >
                + New Post
              </a>
            </div>
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
                    post={r.post}
                    author={r.author}
                    board={r.board}
                    viewer={viewer}
                    myVote={votes.get(r.post.id)}
                    showBoard={!board}
                    rank={(page - 1) * PAGE_SIZE + i + 1}
                  />
                ))
              ) : (
                <p class="meta">
                  Nothing here yet.{" "}
                  <a href={`/d/submit${board ? `?board=${board.slug}` : ""}`}>
                    Start the first discussion
                  </a>
                  .
                </p>
              )}
              {page > 1 || hasMore ? (
                <p class="pager">
                  {page > 1 ? (
                    <a href={`${base}?sort=${sort}&page=${page - 1}`}>‹ prev</a>
                  ) : null}
                  {page > 1 && hasMore ? " · " : null}
                  {hasMore ? (
                    <a href={`${base}?sort=${sort}&page=${page + 1}`}>next ›</a>
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

discussRoutes.get("/d/submit", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  return c.html(await submitForm(gate.user, c.req.query("board") ?? "general"));
});

discussRoutes.post("/d/submit", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const user = gate.user;
  const body = await c.req.parseBody();
  const slug = String(body.board ?? "");
  const title = String(body.title ?? "").trim().replace(/\s+/g, " ");
  const text = String(body.body ?? "").trim();
  const rawUrl = String(body.url ?? "").trim();
  const values = { title, body: text, url: rawUrl };

  const board = await boardBySlug(slug);
  if (!board) return c.html(await submitForm(user, slug, "Pick a board.", values));
  if (title.length < 3) return c.html(await submitForm(user, slug, "Title is too short.", values));
  const url = rawUrl ? safeHref(rawUrl) : "";
  if (url === null) return c.html(await submitForm(user, slug, "That link doesn't look valid.", values));

  const [post] = await db
    .insert(discussionPosts)
    .values({
      boardId: board.id,
      authorUserId: user.id,
      title: title.slice(0, 300),
      body: text.slice(0, 10000),
      url,
    })
    .returning();

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
  if (!/^[a-z0-9_-]{3,24}$/.test(slug) || RESERVED_SLUGS.includes(slug) || !name) {
    return c.redirect("/d");
  }
  const [created] = await db
    .insert(boards)
    .values({ slug, name, description, createdByUserId: user.id })
    .onConflictDoNothing()
    .returning();
  return c.redirect(`/d/${created?.slug ?? slug}`);
});

// Short permalinks used by the rep history.
discussRoutes.get("/d/p/:id{[0-9]+}", async (c) => {
  const [row] = await db
    .select({ post: discussionPosts, board: boards })
    .from(discussionPosts)
    .innerJoin(boards, eq(discussionPosts.boardId, boards.id))
    .where(eq(discussionPosts.id, Number(c.req.param("id"))))
    .limit(1);
  return row ? c.redirect(postUrl(row.board, row.post)) : c.notFound();
});

discussRoutes.get("/d/c/:id{[0-9]+}", async (c) => {
  const [row] = await db
    .select({ comment: discussionComments, post: discussionPosts, board: boards })
    .from(discussionComments)
    .innerJoin(discussionPosts, eq(discussionComments.postId, discussionPosts.id))
    .innerJoin(boards, eq(discussionPosts.boardId, boards.id))
    .where(eq(discussionComments.id, Number(c.req.param("id"))))
    .limit(1);
  return row
    ? c.redirect(`${postUrl(row.board, row.post)}#c-${row.comment.id}`)
    : c.notFound();
});

discussRoutes.get("/d/:slug", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const board = await boardBySlug(c.req.param("slug"));
  if (!board) return c.notFound();
  return renderListing(c, gate.user, board);
});

type CommentRow = DiscussionComment & { author: Author };

function CommentThread(props: {
  node: TreeNode<CommentRow>;
  viewer: User;
  action: string;
  votes: Map<number, number>;
  opId: number;
  depth: number;
}) {
  const { node, viewer, action, votes, opId, depth } = props;
  return (
    <div class="comment" id={`c-${node.id}`}>
      <div class="thing">
        {node.deleted ? (
          <div class="vote vote-placeholder" />
        ) : (
          <VoteBox
            type="comment"
            id={node.id}
            score={node.score}
            myVote={votes.get(node.id)}
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
                {node.authorUserId === opId ? <span class="op-tag">OP</span> : null}
              </>
            )}{" "}
            · {node.score} point{node.score === 1 || node.score === -1 ? "" : "s"} ·{" "}
            {timeAgo(node.createdAt)}
          </div>
          <div class="post-text">
            {node.deleted ? <span class="meta">[deleted]</span> : <Linkified text={node.body} />}
          </div>
          {!node.deleted ? (
            <div class="thing-actions">
              <details class="reply-box">
                <summary>reply</summary>
                <form method="post" action={action}>
                  <input type="hidden" name="parentId" value={String(node.id)} />
                  <textarea name="body" rows={3} required maxlength={5000} />
                  <button class="btn btn-small" type="submit">
                    Reply
                  </button>
                </form>
              </details>
              {node.authorUserId === viewer.id ? (
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
            <CommentThread {...props} node={child} depth={depth + 1} />
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
  const board = await boardBySlug(c.req.param("slug"));
  if (!board) return c.notFound();

  const [row] = await db
    .select({ post: discussionPosts, author: authorCols })
    .from(discussionPosts)
    .innerJoin(users, eq(discussionPosts.authorUserId, users.id))
    .where(
      and(
        eq(discussionPosts.id, Number(c.req.param("postId"))),
        eq(discussionPosts.boardId, board.id)
      )
    )
    .limit(1);
  if (!row) return c.notFound();
  const { post, author } = row;

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
  const postVote = await myVotes(viewer.id, "post", [post.id]);
  const commentVotes = await myVotes(
    viewer.id,
    "comment",
    comments.map((cm) => cm.id)
  );
  const action = `${postUrl(board, post)}/comment`;
  const link = safeHref(post.url);

  return c.html(
    <Layout title={post.title} user={viewer} banner={`q/${board.slug} · ${board.name}`}>
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={viewer} />
            <BoardsBox current={board.slug} viewer={viewer} />
          </td>
          <td class="maincol">
            <div class="box">
              <div class="box-title-alt">
                <a href={`/d/${board.slug}`}>q/{board.slug}</a>
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
                        <span class="meta">[deleted by author]</span>
                      ) : (
                        <Linkified text={post.body} />
                      )}
                    </div>
                    <div class="thing-actions">
                      <b>
                        {post.commentCount} comment{post.commentCount === 1 ? "" : "s"}
                      </b>
                      {post.authorUserId === viewer.id && !post.deleted ? (
                        <form
                          method="post"
                          action={`/d/post/${post.id}/delete`}
                          class="inline-form"
                          data-confirm="Delete this post?"
                        >
                          {" · "}
                          <button class="btn-link" type="submit">
                            delete
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </div>
                </div>

                {!post.deleted ? (
                  <form method="post" action={action} class="comment-form">
                    <textarea
                      name="body"
                      rows={4}
                      required
                      maxlength={5000}
                      placeholder="What are your thoughts?"
                    />
                    <div class="btn-row">
                      <button class="btn" type="submit">
                        Comment
                      </button>
                    </div>
                  </form>
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
                    tree.map((node) => (
                      <CommentThread
                        node={node}
                        viewer={viewer}
                        action={action}
                        votes={commentVotes}
                        opId={post.authorUserId}
                        depth={0}
                      />
                    ))
                  ) : (
                    <p class="meta">No comments yet. Be the first!</p>
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
  const postId = Number(c.req.param("postId"));
  const slug = c.req.param("slug");
  const body = await c.req.parseBody();
  const text = String(body.body ?? "").trim();
  const parentId = Number(body.parentId ?? 0) || null;

  const [post] = await db
    .select()
    .from(discussionPosts)
    .where(eq(discussionPosts.id, postId))
    .limit(1);
  if (!post || post.deleted) return c.notFound();
  if (!text) return c.redirect(`/d/${slug}/${postId}`);

  let parent: DiscussionComment | undefined;
  if (parentId) {
    [parent] = await db
      .select()
      .from(discussionComments)
      .where(eq(discussionComments.id, parentId))
      .limit(1);
    if (!parent || parent.postId !== postId || parent.deleted) {
      return c.redirect(`/d/${slug}/${postId}`);
    }
  }

  const [comment] = await db
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

  if (parent) await awardReply(parent.authorUserId, user.id, "comment", parent.id);
  else await awardReply(post.authorUserId, user.id, "post", post.id);

  return c.redirect(`/d/${slug}/${postId}#c-${comment.id}`);
});

discussRoutes.post("/d/post/:id{[0-9]+}/delete", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const id = Number(c.req.param("id"));
  await db
    .update(discussionPosts)
    .set({ deleted: true })
    .where(and(eq(discussionPosts.id, id), eq(discussionPosts.authorUserId, gate.user.id)));
  return c.redirect(`/d/p/${id}`);
});

discussRoutes.post("/d/comment/:id{[0-9]+}/delete", async (c) => {
  const gate = needLogin(c);
  if (gate.redirect) return gate.redirect;
  const id = Number(c.req.param("id"));
  await db
    .update(discussionComments)
    .set({ deleted: true })
    .where(and(eq(discussionComments.id, id), eq(discussionComments.authorUserId, gate.user.id)));
  return c.redirect(`/d/c/${id}`);
});

async function submitForm(
  user: User,
  selected: string,
  error?: string,
  values: { title: string; body: string; url: string } = { title: "", body: "", url: "" }
) {
  const all = await db.select().from(boards).orderBy(boards.id);
  return (
    <Layout title="New Post" user={user} banner="Submit to Discussions">
      <table class="layout-table">
        <tr>
          <td class="sidebar">
            <LeftNav user={user} />
          </td>
          <td class="maincol">
            <Box title="[ New Post ]" alt>
              {error ? <p class="error">{error}</p> : null}
              <form method="post" action="/d/submit">
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
