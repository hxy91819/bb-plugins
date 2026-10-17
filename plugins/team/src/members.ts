import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  initializeInput,
  memberSchema,
  memberId,
  pageInput,
  profileInput,
} from "./contracts.js";
import { z } from "zod";
export const migrations = [
  "CREATE TABLE members (member_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, avatar_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE team (singleton INTEGER PRIMARY KEY CHECK(singleton=1), admin_member_id TEXT NOT NULL REFERENCES members(member_id))",
  "CREATE INDEX members_name_id ON members(display_name, member_id)",
  "CREATE TABLE scope (singleton INTEGER PRIMARY KEY CHECK(singleton=1), server_id TEXT NOT NULL)",
  "UPDATE members SET display_name='Admin', avatar_id='admin' WHERE member_id=(SELECT admin_member_id FROM team WHERE singleton=1)",
];
const columns =
  "member_id AS memberId, display_name AS displayName, avatar_id AS avatarId, created_at AS createdAt, updated_at AS updatedAt";
export function createMemberService(
  db: Database.Database,
  avatars: readonly { id: string }[],
  changed: () => void,
) {
  db.pragma("foreign_keys = ON");
  db.prepare(
    "INSERT OR IGNORE INTO scope(singleton,server_id) VALUES(1,?)",
  ).run(randomUUID());
  const serverScope = z
    .object({ server_id: z.string().uuid() })
    .parse(
      db.prepare("SELECT server_id FROM scope WHERE singleton=1").get(),
    ).server_id;
  const admin = () => {
    const row = db
      .prepare("SELECT admin_member_id FROM team WHERE singleton=1")
      .get();
    return row
      ? z.object({ admin_member_id: memberId }).parse(row).admin_member_id
      : null;
  };
  const profile = (input: unknown) => {
    const value = profileInput.parse(input);
    if (
      value.avatarId === "admin" ||
      !avatars.some((a) => a.id === value.avatarId)
    )
      throw Error("invalid_avatar");
    return value;
  };
  const get = (id: string) => {
    memberId.parse(id);
    const row = db
      .prepare(`SELECT ${columns} FROM members WHERE member_id=?`)
      .get(id);
    return row ? memberSchema.parse(row) : null;
  };
  const insert = (input: unknown) => {
    const value = profile(input),
      id = randomUUID(),
      now = Date.now();
    db.prepare("INSERT INTO members VALUES(?,?,?,?,?)").run(
      id,
      value.displayName,
      value.avatarId,
      now,
      now,
    );
    return memberSchema.parse({
      memberId: id,
      ...value,
      createdAt: now,
      updatedAt: now,
    });
  };
  const initialize = (input: unknown) => {
    initializeInput.parse(input);
    const result = db
      .transaction(() => {
        const id = admin();
        if (id)
          return { status: "already_initialized" as const, adminMemberId: id };
        const now = Date.now();
        const member = {
          memberId: randomUUID(),
          displayName: "Admin",
          avatarId: "admin",
          createdAt: now,
          updatedAt: now,
        };
        db.prepare("INSERT INTO members VALUES(?,?,?,?,?)").run(
          member.memberId,
          member.displayName,
          member.avatarId,
          now,
          now,
        );
        db.prepare("INSERT INTO team VALUES(1,?)").run(member.memberId);
        return { status: "initialized" as const, member };
      })
      .immediate();
    if (result.status === "initialized") changed();
    return result;
  };
  const list = (input: unknown) => {
    const { search, limit, cursor } = pageInput.parse(input);
    const escaped = search.replace(/[\\%_]/g, "\\$&");
    const rows = db
      .prepare(
        `SELECT ${columns} FROM members WHERE (? IS NULL OR member_id>?) AND display_name LIKE ? ESCAPE '\\' ORDER BY member_id LIMIT ?`,
      )
      .all(cursor, cursor, `%${escaped}%`, limit + 1)
      .map((row) => memberSchema.parse(row));
    return {
      members: rows.slice(0, limit),
      nextCursor: rows.length > limit ? rows[limit - 1]!.memberId : null,
    };
  };
  const resolve = (input: {
    name: string;
    limit: number;
    cursor: string | null;
  }) => {
    const { name, limit, cursor } = z
      .object({
        name: z.string().trim().min(1).max(80),
        limit: z.number().int().min(1).max(100),
        cursor: memberId.nullable(),
      })
      .parse(input);
    const rows = db
      .prepare(
        `SELECT ${columns} FROM members WHERE display_name=? AND (? IS NULL OR member_id>?) ORDER BY member_id LIMIT ?`,
      )
      .all(name, cursor, cursor, limit + 1)
      .map((row) => memberSchema.parse(row));
    const total = z
      .object({ count: z.number() })
      .parse(
        db
          .prepare("SELECT COUNT(*) AS count FROM members WHERE display_name=?")
          .get(name),
      ).count;
    return {
      status:
        total === 0
          ? ("not_found" as const)
          : total === 1
            ? ("unique" as const)
            : ("ambiguous" as const),
      members: rows.slice(0, limit),
      nextCursor: rows.length > limit ? rows[limit - 1]!.memberId : null,
    };
  };
  const create = (input: {
    actorMemberId: string;
    displayName: string;
    avatarId: string;
  }) => {
    memberId.parse(input.actorMemberId);
    if (input.actorMemberId !== admin()) throw Error("admin_required");
    const member = insert({
      displayName: input.displayName,
      avatarId: input.avatarId,
    });
    changed();
    return member;
  };
  const updateSelf = (input: {
    memberId: string;
    displayName: string;
    avatarId: string;
  }) => {
    if (!get(input.memberId)) throw Error("member_not_found");
    if (input.memberId === admin()) throw Error("admin_profile_fixed");
    const value = profile({
      displayName: input.displayName,
      avatarId: input.avatarId,
    });
    db.prepare(
      "UPDATE members SET display_name=?,avatar_id=?,updated_at=? WHERE member_id=?",
    ).run(value.displayName, value.avatarId, Date.now(), input.memberId);
    const member = get(input.memberId)!;
    changed();
    return member;
  };
  return {
    serverScope,
    admin,
    initialize,
    list,
    resolve,
    get,
    batch: (ids: string[]) => {
      const values = z.array(memberId).max(200).parse(ids);
      if (!values.length) return [];
      return db
        .prepare(
          `SELECT ${columns} FROM members WHERE member_id IN (${values.map(() => "?").join(",")})`,
        )
        .all(...values)
        .map((row) => memberSchema.parse(row));
    },
    create,
    updateSelf,
    validate: (id: string | null) => {
      const member = id === null ? null : get(id);
      return { valid: id === null || member !== null, member };
    },
  };
}
