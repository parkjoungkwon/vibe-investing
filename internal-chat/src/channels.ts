import type { DatabaseSync } from "node:sqlite";
import { writeAudit } from "./audit.ts";
import type { Channel, ChannelType, User } from "./types.ts";
import { assertNever } from "./types.ts";

export function listMemberChannels(db: DatabaseSync, userId: number) {
  return db
    .prepare(
      `SELECT c.id, c.type, c.name, c.created_by, c.created_at
       FROM channels c
       JOIN channel_members m ON m.channel_id = c.id
       WHERE m.user_id = ?
       ORDER BY CASE c.type WHEN 'dm' THEN 2 WHEN 'private' THEN 1 ELSE 0 END, c.name`,
    )
    .all(userId) as Channel[];
}

export function listJoinablePublic(db: DatabaseSync, userId: number) {
  return db
    .prepare(
      `SELECT c.id, c.type, c.name, c.created_by, c.created_at
       FROM channels c
       WHERE c.type = 'public'
         AND NOT EXISTS (
           SELECT 1 FROM channel_members m
           WHERE m.channel_id = c.id AND m.user_id = ?
         )
       ORDER BY c.name`,
    )
    .all(userId) as Channel[];
}

export function createChannel(
  db: DatabaseSync,
  actor: User,
  name: string,
  type: ChannelType,
): Channel {
  switch (type) {
    case "public":
    case "private":
      break;
    case "dm":
      throw Object.assign(new Error("DMs are created via /dms"), { status: 400 });
    default:
      return assertNever(type);
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw Object.assign(new Error("채널 이름이 필요합니다."), { status: 400 });
  }
  const info = db
    .prepare("INSERT INTO channels (type, name, created_by) VALUES (?, ?, ?)")
    .run(type, trimmed, actor.id);
  const channelId = Number(info.lastInsertRowid);
  db.prepare("INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)").run(
    channelId,
    actor.id,
  );
  writeAudit(
    db,
    actor.id,
    "channel.create",
    JSON.stringify({ channelId, type, name: trimmed }),
  );
  return db
    .prepare("SELECT id, type, name, created_by, created_at FROM channels WHERE id = ?")
    .get(channelId) as Channel;
}

export function addMember(
  db: DatabaseSync,
  actor: User,
  channelId: number,
  userId: number,
  reason: "invite" | "join",
): void {
  db.prepare(
    "INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)",
  ).run(channelId, userId);
  writeAudit(
    db,
    actor.id,
    reason === "invite" ? "membership.invite" : "membership.join",
    JSON.stringify({ channelId, userId }),
  );
}

export function removeMember(
  db: DatabaseSync,
  actor: User,
  channelId: number,
  userId: number,
): void {
  db.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?").run(
    channelId,
    userId,
  );
  writeAudit(
    db,
    actor.id,
    "membership.remove",
    JSON.stringify({ channelId, userId }),
  );
}

export function getOrCreateDm(db: DatabaseSync, actor: User, otherUserId: number): Channel {
  if (actor.id === otherUserId) {
    throw Object.assign(new Error("자기 자신과 쪽지를 열 수 없습니다."), { status: 400 });
  }
  const other = db.prepare("SELECT id, display_name FROM users WHERE id = ?").get(otherUserId) as
    | { id: number; display_name: string }
    | undefined;
  if (!other) {
    throw Object.assign(new Error("사용자를 찾을 수 없습니다."), { status: 404 });
  }
  const low = Math.min(actor.id, otherUserId);
  const high = Math.max(actor.id, otherUserId);
  const existing = db
    .prepare("SELECT channel_id FROM dm_pairs WHERE user_low = ? AND user_high = ?")
    .get(low, high) as { channel_id: number } | undefined;
  if (existing) {
    return db
      .prepare("SELECT id, type, name, created_by, created_at FROM channels WHERE id = ?")
      .get(existing.channel_id) as Channel;
  }
  const name = [actor.display_name, other.display_name].join(" · ");
  const info = db
    .prepare("INSERT INTO channels (type, name, created_by) VALUES ('dm', ?, ?)")
    .run(name, actor.id);
  const channelId = Number(info.lastInsertRowid);
  db.prepare("INSERT INTO dm_pairs (channel_id, user_low, user_high) VALUES (?, ?, ?)").run(
    channelId,
    low,
    high,
  );
  db.prepare("INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)").run(
    channelId,
    actor.id,
  );
  db.prepare("INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)").run(
    channelId,
    otherUserId,
  );
  writeAudit(db, actor.id, "dm.open", JSON.stringify({ channelId, with: otherUserId }));
  return db
    .prepare("SELECT id, type, name, created_by, created_at FROM channels WHERE id = ?")
    .get(channelId) as Channel;
}

export function ensureGeneralChannel(db: DatabaseSync): void {
  const existing = db
    .prepare("SELECT id FROM channels WHERE type = 'public' AND name = ?")
    .get("일반") as { id: number } | undefined;
  if (existing) return;
  db.prepare("INSERT INTO channels (type, name, created_by) VALUES ('public', '일반', NULL)").run();
}

export function autoJoinPublicGeneral(db: DatabaseSync, userId: number): void {
  const general = db
    .prepare("SELECT id FROM channels WHERE type = 'public' AND name = ?")
    .get("일반") as { id: number } | undefined;
  if (!general) return;
  db.prepare(
    "INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)",
  ).run(general.id, userId);
}
