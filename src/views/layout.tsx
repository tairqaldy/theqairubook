import type { FC, Child } from "hono/jsx";
import type { User } from "../db/schema.js";

export function Layout(props: {
  title: string;
  user: User | null;
  banner?: string;
  children: Child;
}) {
  const { title, user, banner, children } = props;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} | theqairubook</title>
        <link rel="stylesheet" href="/static/style.css" />
      </head>
      <body>
        <div class="page-wrap">
          <div class="topbar">
            <div class="logo-row">
              <div class="logo">
                <a href={user ? "/home" : "/"}>[ theqairubook ]</a>
              </div>
            </div>
            <div class="menu-row">
              {user ? (
                <>
                  <a href="/home">home</a>
                  <a href="/search">search</a>
                  <a href="/social-net">social net</a>
                  <a href="/invite">invite</a>
                  <a href="/faq">faq</a>
                  <a href="/logout">logout</a>
                </>
              ) : (
                <>
                  <a href="/login">login</a>
                  <a href="/register">register</a>
                  <a href="/about">about</a>
                  <a href="/faq">faq</a>
                </>
              )}
            </div>
          </div>
          {banner ? <div class="welcome-banner">{banner}</div> : null}
          <div class="content">{children}</div>
          <div class="footer">
            a QAIRU student production ·{" "}
            <a href="/about">about</a> · <a href="/faq">faq</a> ·{" "}
            <a href="/terms">terms</a>
            <br />
            Qazaq AI Research University · пр. Мәңгілік Ел 55/1, Astana
          </div>
        </div>
      </body>
    </html>
  );
}

export const LeftNav: FC<{ user: User }> = ({ user }) => (
  <div class="left-nav">
    <div class="box" style="margin-bottom:10px">
      <div class="box-title-alt">[ {user.name.split(" ")[0]} ]</div>
      <div class="box-body">
        <a href={`/profile/${user.id}`}>My Profile</a>
        <a href="/edit-profile">Edit My Profile</a>
        <a href="/friends">My Friends</a>
        <a href="/messages">My Messages</a>
        <a href="/pokes">Pokes</a>
        <a href="/account">My Account</a>
        <a href="/privacy">Privacy</a>
      </div>
    </div>
  </div>
);

export const Box: FC<{ title: string; alt?: boolean; children: Child }> = ({
  title,
  alt,
  children,
}) => (
  <div class="box">
    <div class={alt ? "box-title-alt" : "box-title"}>{title}</div>
    <div class="box-body">{children}</div>
  </div>
);

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function defaultPhoto(user: User): string {
  return user.photoPath ? `/uploads/${user.photoPath}` : "";
}
