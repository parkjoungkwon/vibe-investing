import type { DatabaseSync } from "node:sqlite";
import { assertNever, type Channel, type ChannelType } from "./types.ts";

export function getChannel(db: DatabaseSync, channelId: number): Channel | undefined {
  return db
    .prepare("SELECT id, type, name, created_by, created_at FROM channels WHERE id = ?")
    .get(channelId) as Channel | undefined;
}

export function isMember(db: DatabaseSync, userId: number, channelId: number): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM channel_members WHERE channel_id = ? AND user_id = ?")
    .get(channelId, userId) as { ok: number } | undefined;
  return Boolean(row);
}

export function requireMembership(db: DatabaseSync, userId: number, channelId: number): Channel {
  const channel = getChannel(db, channelId);
  if (!channel) {
    const err = new Error("CHANNEL_NOT_FOUND");
    (err as Error & { status: number }).status = 404;
    throw err;
  }
  if (!isMember(db, userId, channelId)) {
    const err = new Error("FORBIDDEN");
    (err as Error & { status: number }).status = 403;
    throw err;
  }
  return channel;
}

export function canJoinUnaided(type: ChannelType): boolean {
  switch (type) {
    case "public":
      return true;
    case "private":
    case "dm":
      return false;
    default:
      return assertNever(type);
  }
}

export function visibleChannelIds(db: DatabaseSync, userId: number): number[] {
  const rows = db
    .prepare("SELECT channel_id FROM channel_members WHERE user_id = ?")
    .all(userId) as Array<{ channel_id: number }>;
  return rows.map((row) => row.channel_id);
}
