import type { DatabaseSync } from "node:sqlite";
import type { Attachment, Message, User } from "./types.ts";

export type MessageView = Message & {
  author_email: string;
  author_name: string;
  reply_count: number;
  reactions: Array<{ emoji: string; count: number; mine: boolean }>;
  attachments: Attachment[];
  mention_user_ids: number[];
};

function parseMentions(db: DatabaseSync, body: string): number[] {
  const users = db.prepare("SELECT id, email, display_name FROM users").all() as Array<{
    id: number;
    email: string;
    display_name: string;
  }>;
  const ids = new Set<number>();
  const tokens = body.match(/@[^\s@]+/g) ?? [];
  for (const raw of tokens) {
    const token = raw.slice(1).toLowerCase();
    for (const user of users) {
      if (user.email.toLowerCase() === token || user.email.toLowerCase().startsWith(token)) {
        ids.add(user.id);
        continue;
      }
      if (user.display_name.replace(/\s/g, "").toLowerCase() === token.replace(/\s/g, "")) {
        ids.add(user.id);
      }
    }
  }
  return [...ids];
}

export function insertMessage(
  db: DatabaseSync,
  actor: User,
  channelId: number,
  body: string,
  parentId: number | null,
): Message {
  const trimmed = body.trim();
  if (!trimmed) {
    throw Object.assign(new Error("본문이 비어 있습니다."), { status: 400 });
  }
  if (parentId !== null) {
    const parent = db
      .prepare("SELECT id, channel_id FROM messages WHERE id = ?")
      .get(parentId) as { id: number; channel_id: number } | undefined;
    if (!parent || parent.channel_id !== channelId) {
      throw Object.assign(new Error("스레드를 찾을 수 없습니다."), { status: 400 });
    }
  }
  const info = db
    .prepare(
      "INSERT INTO messages (channel_id, user_id, parent_id, body) VALUES (?, ?, ?, ?)",
    )
    .run(channelId, actor.id, parentId, trimmed);
  const messageId = Number(info.lastInsertRowid);
  const mentionIds = parseMentions(db, trimmed);
  const mentionStmt = db.prepare("INSERT OR IGNORE INTO mentions (message_id, user_id) VALUES (?, ?)");
  for (const mentioned of mentionIds) {
    mentionStmt.run(messageId, mentioned);
  }
  return db
    .prepare(
      "SELECT id, channel_id, user_id, parent_id, body, created_at FROM messages WHERE id = ?",
    )
    .get(messageId) as Message;
}

export function attachFile(
  db: DatabaseSync,
  messageId: number,
  originalName: string,
  storedName: string,
  mime: string,
  size: number,
): Attachment {
  const info = db
    .prepare(
      `INSERT INTO attachments (message_id, original_name, stored_name, mime, size)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(messageId, originalName, storedName, mime, size);
  return db
    .prepare(
      `SELECT id, message_id, original_name, stored_name, mime, size, created_at
       FROM attachments WHERE id = ?`,
    )
    .get(Number(info.lastInsertRowid)) as Attachment;
}

function hydrateMessages(db: DatabaseSync, viewerId: number, rows: Message[]): MessageView[] {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(",");

  const authors = new Map<number, { email: string; display_name: string }>();
  for (const user of db.prepare("SELECT id, email, display_name FROM users").all() as Array<{
    id: number;
    email: string;
    display_name: string;
  }>) {
    authors.set(user.id, { email: user.email, display_name: user.display_name });
  }

  const replyRows = db
    .prepare(
      `SELECT parent_id AS id, COUNT(*) AS n FROM messages
       WHERE parent_id IN (${placeholders}) GROUP BY parent_id`,
    )
    .all(...ids) as Array<{ id: number; n: number }>;
  const replyMap = new Map(replyRows.map((row) => [row.id, row.n]));

  const reactionRows = db
    .prepare(
      `SELECT message_id, emoji, COUNT(*) AS n,
              SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine
       FROM reactions
       WHERE message_id IN (${placeholders})
       GROUP BY message_id, emoji`,
    )
    .all(viewerId, ...ids) as Array<{ message_id: number; emoji: string; n: number; mine: number }>;
  const reactionMap = new Map<number, Array<{ emoji: string; count: number; mine: boolean }>>();
  for (const row of reactionRows) {
    const list = reactionMap.get(row.message_id) ?? [];
    list.push({ emoji: row.emoji, count: row.n, mine: row.mine > 0 });
    reactionMap.set(row.message_id, list);
  }

  const files = db
    .prepare(
      `SELECT id, message_id, original_name, stored_name, mime, size, created_at
       FROM attachments WHERE message_id IN (${placeholders})`,
    )
    .all(...ids) as Attachment[];
  const fileMap = new Map<number, Attachment[]>();
  for (const file of files) {
    const list = fileMap.get(file.message_id) ?? [];
    list.push(file);
    fileMap.set(file.message_id, list);
  }

  const mentionRows = db
    .prepare(`SELECT message_id, user_id FROM mentions WHERE message_id IN (${placeholders})`)
    .all(...ids) as Array<{ message_id: number; user_id: number }>;
  const mentionMap = new Map<number, number[]>();
  for (const row of mentionRows) {
    const list = mentionMap.get(row.message_id) ?? [];
    list.push(row.user_id);
    mentionMap.set(row.message_id, list);
  }

  return rows.map((row) => {
    const author = authors.get(row.user_id);
    return {
      ...row,
      author_email: author?.email ?? "",
      author_name: author?.display_name ?? "알 수 없음",
      reply_count: replyMap.get(row.id) ?? 0,
      reactions: reactionMap.get(row.id) ?? [],
      attachments: fileMap.get(row.id) ?? [],
      mention_user_ids: mentionMap.get(row.id) ?? [],
    };
  });
}

export function listMessages(
  db: DatabaseSync,
  viewerId: number,
  channelId: number,
  parentId: number | null,
  limit = 200,
): MessageView[] {
  const rows = (
    parentId === null
      ? db
          .prepare(
            `SELECT id, channel_id, user_id, parent_id, body, created_at
             FROM messages
             WHERE channel_id = ? AND parent_id IS NULL
             ORDER BY id ASC
             LIMIT ?`,
          )
          .all(channelId, limit)
      : db
          .prepare(
            `SELECT id, channel_id, user_id, parent_id, body, created_at
             FROM messages
             WHERE channel_id = ? AND (id = ? OR parent_id = ?)
             ORDER BY id ASC
             LIMIT ?`,
          )
          .all(channelId, parentId, parentId, limit)
  ) as Message[];
  return hydrateMessages(db, viewerId, rows);
}

export function getMessage(db: DatabaseSync, messageId: number): Message | undefined {
  return db
    .prepare(
      "SELECT id, channel_id, user_id, parent_id, body, created_at FROM messages WHERE id = ?",
    )
    .get(messageId) as Message | undefined;
}

export function toggleReaction(
  db: DatabaseSync,
  userId: number,
  messageId: number,
  emoji: string,
): { added: boolean } {
  const trimmed = emoji.trim();
  if (!trimmed) {
    throw Object.assign(new Error("반응이 비어 있습니다."), { status: 400 });
  }
  const existing = db
    .prepare("SELECT 1 AS ok FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?")
    .get(messageId, userId, trimmed) as { ok: number } | undefined;
  if (existing) {
    db.prepare("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?").run(
      messageId,
      userId,
      trimmed,
    );
    return { added: false };
  }
  db.prepare("INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)").run(
    messageId,
    userId,
    trimmed,
  );
  return { added: true };
}

export function escapeLike(query: string): string {
  return query.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

export function searchVisibleMessages(
  db: DatabaseSync,
  viewerId: number,
  query: string,
  limit = 50,
): MessageView[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const like = `%${escapeLike(trimmed)}%`;
  const rows = db
    .prepare(
      `SELECT m.id, m.channel_id, m.user_id, m.parent_id, m.body, m.created_at
       FROM messages m
       JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ?
       WHERE m.body LIKE ? ESCAPE '\\'
       ORDER BY m.id DESC
       LIMIT ?`,
    )
    .all(viewerId, like, limit) as Message[];
  return hydrateMessages(db, viewerId, rows);
}

export function getAttachment(db: DatabaseSync, attachmentId: number): Attachment | undefined {
  return db
    .prepare(
      `SELECT id, message_id, original_name, stored_name, mime, size, created_at
       FROM attachments WHERE id = ?`,
    )
    .get(attachmentId) as Attachment | undefined;
}
