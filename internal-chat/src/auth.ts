import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Request, Response, NextFunction } from "express";
import { isAdminEmail, isAllowlisted, type Config } from "./config.ts";
import type { User, UserRole } from "./types.ts";
import { writeAudit } from "./audit.ts";

export const SESSION_COOKIE = "hearth_session";
const SESSION_DAYS = 14;

export function getUserByEmail(db: DatabaseSync, email: string): User | undefined {
  return db
    .prepare("SELECT id, email, display_name, role, created_at FROM users WHERE email = ?")
    .get(email.toLowerCase()) as User | undefined;
}

export function getUserById(db: DatabaseSync, id: number): User | undefined {
  return db
    .prepare("SELECT id, email, display_name, role, created_at FROM users WHERE id = ?")
    .get(id) as User | undefined;
}

function roleForEmail(config: Config, email: string): UserRole {
  return isAdminEmail(config, email) ? "admin" : "member";
}

export function upsertStaffUser(
  db: DatabaseSync,
  config: Config,
  email: string,
  displayName: string,
): User {
  const normalized = email.trim().toLowerCase();
  const existing = getUserByEmail(db, normalized);
  const role = roleForEmail(config, normalized);
  if (existing) {
    db.prepare("UPDATE users SET display_name = ?, role = ? WHERE id = ?").run(
      displayName.trim() || existing.display_name,
      role,
      existing.id,
    );
    return getUserById(db, existing.id)!;
  }
  db.prepare("INSERT INTO users (email, display_name, role) VALUES (?, ?, ?)").run(
    normalized,
    displayName.trim() || normalized.split("@")[0],
    role,
  );
  return getUserByEmail(db, normalized)!;
}

export function createSession(db: DatabaseSync, userId: number): string {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    expires,
  );
  return token;
}

export function destroySession(db: DatabaseSync, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function userFromToken(db: DatabaseSync, token: string | undefined): User | undefined {
  if (!token) return undefined;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.role, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`,
    )
    .get(token) as User | undefined;
  return row;
}

export type AuthedRequest = Request & { user: User };

export function authMiddleware(db: DatabaseSync) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    const user = userFromToken(db, token);
    if (!user) {
      res.status(401).json({ error: "로그인이 필요합니다." });
      return;
    }
    (req as AuthedRequest).user = user;
    next();
  };
}

export function adminOnly(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthedRequest).user;
  if (!user || user.role !== "admin") {
    res.status(403).json({ error: "관리자만 사용할 수 있습니다." });
    return;
  }
  next();
}

export function loginStaff(
  db: DatabaseSync,
  config: Config,
  email: string,
  displayName: string,
): { user: User; token: string } {
  const normalized = email.trim().toLowerCase();
  if (!isAllowlisted(config, normalized)) {
    writeAudit(db, null, "auth.denied", JSON.stringify({ email: normalized }));
    const err = new Error("NOT_ALLOWLISTED");
    (err as Error & { status: number }).status = 403;
    throw err;
  }
  const user = upsertStaffUser(db, config, normalized, displayName);
  const token = createSession(db, user.id);
  writeAudit(db, user.id, "auth.login", JSON.stringify({ email: user.email }));
  return { user, token };
}
