import type { Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import { sign } from "../auth/session.js";
import { publicOrigin } from "./url.js";
import type { User } from "../db/schema.js";

/**
 * A member's referral link, optionally addressed to a specific classmate who
 * hasn't joined yet (`?for=<id>.<sig>`). The signature stops anyone from
 * walking ids on the public join page to harvest the student list.
 */
export function inviteLink(
  c: Context,
  inviter: Pick<User, "referralCode">,
  target?: Pick<User, "id"> | null
): string {
  const base = `${publicOrigin(c)}/r/${inviter.referralCode ?? ""}`;
  if (!target) return base;
  return `${base}?for=${target.id}.${sign(`invite-for:${target.id}`).slice(0, 16)}`;
}

/** The target user id from a `for` param, or null if missing/forged. */
export function inviteTarget(param: string | undefined): number | null {
  if (!param) return null;
  const [idStr, sig] = param.split(".");
  const id = Number(idStr);
  if (!Number.isInteger(id) || id < 1 || !sig) return null;
  const expected = Buffer.from(sign(`invite-for:${id}`).slice(0, 16));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}

export function inviteMessage(inviterName: string, link: string, targetName?: string): string {
  const hi = targetName ? `Hi ${targetName.split(" ")[0]}! ` : "";
  return `${hi}${inviterName.split(" ")[0]} here — join me on theqairubook, the QAIRU student network (discussions, study materials, chat). Sign up with your @qairu.edu.kz email: ${link}`;
}
