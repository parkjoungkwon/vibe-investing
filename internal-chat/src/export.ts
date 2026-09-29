import fs from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import { writeAudit } from "./audit.ts";
import type { User } from "./types.ts";

function all(db: DatabaseSync, sql: string): unknown[] {
  return db.prepare(sql).all() as unknown[];
}

export function exportWorkspaceZip(db: DatabaseSync, config: Config, actor: User): Buffer {
  const payload = {
    exported_at: new Date().toISOString(),
    exported_by: { id: actor.id, email: actor.email },
    workspace: config.workspaceName,
    users: all(db, "SELECT id, email, display_name, role, created_at FROM users"),
    channels: all(db, "SELECT id, type, name, created_by, created_at FROM channels"),
    members: all(db, "SELECT channel_id, user_id, joined_at FROM channel_members"),
    messages: all(
      db,
      "SELECT id, channel_id, user_id, parent_id, body, created_at FROM messages",
    ),
    reactions: all(db, "SELECT message_id, user_id, emoji, created_at FROM reactions"),
    mentions: all(db, "SELECT message_id, user_id FROM mentions"),
    attachments: all(
      db,
      "SELECT id, message_id, original_name, stored_name, mime, size, created_at FROM attachments",
    ),
    audit_log: all(db, "SELECT id, actor_id, action, detail, created_at FROM audit_log"),
  };

  const files: Record<string, Uint8Array> = {
    "workspace.json": strToU8(JSON.stringify(payload, null, 2)),
  };
  const attachments = payload.attachments as Array<{ stored_name: string }>;
  for (const file of attachments) {
    const abs = path.join(config.filesDir, file.stored_name);
    if (fs.existsSync(abs)) {
      files[`files/${file.stored_name}`] = fs.readFileSync(abs);
    }
  }

  writeAudit(db, actor.id, "workspace.export", JSON.stringify({ format: "zip" }));
  return Buffer.from(zipSync(files, { level: 6 }));
}
