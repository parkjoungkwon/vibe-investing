import type { DatabaseSync } from "node:sqlite";
import type { AuditRow } from "./types.ts";

export function writeAudit(
  db: DatabaseSync,
  actorId: number | null,
  action: string,
  detail: string,
): void {
  db.prepare("INSERT INTO audit_log (actor_id, action, detail) VALUES (?, ?, ?)").run(
    actorId,
    action,
    detail,
  );
}

export function listAudit(db: DatabaseSync, limit = 200): AuditRow[] {
  return db
    .prepare(
      `SELECT id, actor_id, action, detail, created_at
       FROM audit_log
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(limit) as AuditRow[];
}
