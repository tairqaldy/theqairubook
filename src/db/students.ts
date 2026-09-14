import { inArray, sql } from "drizzle-orm";
import { db } from "./index.js";
import { users } from "./schema.js";
import { allowedEmail } from "../auth/session.js";
import { makeReferralCode } from "../lib/social.js";

// The official QAIRU student list. Every listed student gets a pre-created
// account (no password, claimedAt null) that they activate on registration.

export type StudentRow = {
  email: string;
  name: string;
  nativeName?: string;
  /** Source line / item number, used in error reports instead of the data. */
  line?: number;
};

export type ImportResult = {
  created: number;
  updated: number;
  skippedActivated: number;
  invalid: string[];
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_RE = /[\u0000-\u001f]/;

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

type CleanRow = { email: string; name: string; nativeName: string | null };

export async function importStudents(rows: StudentRow[]): Promise<ImportResult> {
  const invalid: string[] = [];
  const byEmail = new Map<string, CleanRow>();

  rows.forEach((row, i) => {
    const ref = `line ${row?.line ?? i + 1}`;
    const email = typeof row?.email === "string" ? row.email.trim().toLowerCase() : "";
    const name = cleanText(row?.name);
    const nativeName = row?.nativeName === undefined ? null : cleanText(row.nativeName);
    if (
      !email ||
      email.length > 254 ||
      !EMAIL_RE.test(email) ||
      !allowedEmail(email) ||
      name.length < 2 ||
      name.length > 80 ||
      CONTROL_RE.test(name) ||
      (nativeName !== null && (nativeName.length > 120 || CONTROL_RE.test(nativeName)))
    ) {
      invalid.push(ref);
      return;
    }
    if (byEmail.has(email)) {
      invalid.push(`${ref} (duplicate)`);
      return;
    }
    byEmail.set(email, { email, name, nativeName });
  });

  const list = [...byEmail.values()];
  if (!list.length) return { created: 0, updated: 0, skippedActivated: 0, invalid };

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ email: users.email, claimedAt: users.claimedAt })
      .from(users)
      .where(inArray(users.email, list.map((r) => r.email)));
    const known = new Map(existing.map((u) => [u.email, u]));

    const fresh = list.filter((r) => !known.has(r.email));
    const unclaimed = list.filter((r) => {
      const u = known.get(r.email);
      return u !== undefined && u.claimedAt === null;
    });
    const skippedActivated = list.length - fresh.length - unclaimed.length;

    // Referral codes: unique within the batch and against the database.
    const codes = new Map<string, string>();
    let pending = fresh;
    for (let attempt = 0; pending.length && attempt < 5; attempt++) {
      const taken = new Set(codes.values());
      const proposed = new Map<string, string>();
      for (const r of pending) {
        let code = makeReferralCode(r.name);
        while (taken.has(code)) code = makeReferralCode(r.name);
        taken.add(code);
        proposed.set(r.email, code);
      }
      const clashes = await tx
        .select({ code: users.referralCode })
        .from(users)
        .where(inArray(users.referralCode, [...proposed.values()]));
      const clashing = new Set(clashes.map((c) => c.code));
      for (const [email, code] of proposed) {
        if (!clashing.has(code)) codes.set(email, code);
      }
      pending = pending.filter((r) => !codes.has(r.email));
    }

    let created = 0;
    for (let i = 0; i < fresh.length; i += 200) {
      const chunk = fresh.slice(i, i + 200);
      const inserted = await tx
        .insert(users)
        .values(
          chunk.map((r) => ({
            email: r.email,
            passwordHash: "",
            name: r.name,
            nativeName: r.nativeName ?? "",
            claimedAt: null,
            status: "Student",
            // Left null only if every attempt clashed; ensureSchema backfills it.
            referralCode: codes.get(r.email) ?? null,
          }))
        )
        .onConflictDoNothing()
        .returning({ id: users.id });
      created += inserted.length;
    }

    // One UPDATE for all unclaimed accounts; only rows that actually change count.
    // Only the name columns are written: moderation state an admin set on an
    // unclaimed account (claim_locked, suspended_at, session_version,
    // referred_by_user_id) is deliberately left exactly as it is.
    let updated = 0;
    if (unclaimed.length) {
      const values = sql.join(
        unclaimed.map((r) => sql`(${r.email}::text, ${r.name}::text, ${r.nativeName}::text)`),
        sql`, `
      );
      const changed = await tx.execute<{ id: number }>(sql`
        UPDATE users AS u
           SET name = v.name,
               native_name = coalesce(v.native_name, u.native_name),
               last_update = now()
          FROM (VALUES ${values}) AS v(email, name, native_name)
         WHERE u.email = v.email
           AND u.claimed_at IS NULL
           AND (u.name <> v.name OR u.native_name <> coalesce(v.native_name, u.native_name))
        RETURNING u.id`);
      updated = changed.length;
    }

    return { created, updated, skippedActivated, invalid };
  });
}

/** Splits one CSV/TSV line, honouring "quoted, fields". */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (ch === delimiter) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * Accepts a JSON array of {email, name, nativeName} or CSV/TSV lines
 * "email,name[,nativeName]" (either column order; the cell with "@" is the
 * email). A header line and blank lines are ignored. Errors reference line
 * numbers only, never the data itself.
 */
export function parseStudentList(text: string): { rows: StudentRow[]; errors: string[] } {
  const input = text.replace(/^﻿/, "").trim();
  const rows: StudentRow[] = [];
  const errors: string[] = [];
  if (!input) return { rows, errors: ["The list is empty."] };

  if (input.startsWith("[")) {
    let data: unknown;
    try {
      data = JSON.parse(input);
    } catch {
      return { rows, errors: ["Couldn't parse the JSON."] };
    }
    if (!Array.isArray(data)) return { rows, errors: ["JSON must be an array."] };
    data.forEach((item, i) => {
      const o = item as Record<string, unknown> | null;
      if (
        o &&
        typeof o === "object" &&
        typeof o.email === "string" &&
        typeof o.name === "string" &&
        (o.nativeName === undefined || o.nativeName === null || typeof o.nativeName === "string")
      ) {
        rows.push({
          email: o.email,
          name: o.name,
          nativeName: typeof o.nativeName === "string" ? o.nativeName : undefined,
          line: i + 1,
        });
      } else {
        errors.push(`item ${i + 1}`);
      }
    });
    return { rows, errors };
  }

  let sawContent = false;
  input.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const delimiter = line.includes("\t")
      ? "\t"
      : line.includes(";") && !line.includes(",")
        ? ";"
        : ",";
    const cells = splitLine(line, delimiter);
    const emailAt = cells.findIndex((cell) => cell.includes("@"));
    const first = !sawContent;
    sawContent = true;
    if (emailAt === -1) {
      if (!first) errors.push(`line ${i + 1}`); // the first such line is the header
      return;
    }
    const [name, nativeName] = cells.filter((_, j) => j !== emailAt);
    if (!name) {
      errors.push(`line ${i + 1}`);
      return;
    }
    rows.push({ email: cells[emailAt], name, nativeName: nativeName || undefined, line: i + 1 });
  });
  return { rows, errors };
}
