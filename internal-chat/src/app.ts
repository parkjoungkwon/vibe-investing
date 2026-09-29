import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import { DatabaseSync } from "node:sqlite";
import { adminOnly, authMiddleware, loginStaff, destroySession, SESSION_COOKIE, type AuthedRequest } from "./auth.ts";
import { canJoinUnaided, requireMembership } from "./acl.ts";
import { writeAudit, listAudit } from "./audit.ts";
import {
  addMember,
  autoJoinPublicGeneral,
  createChannel,
  ensureGeneralChannel,
  getOrCreateDm,
  listJoinablePublic,
  listMemberChannels,
  removeMember,
} from "./channels.ts";
import type { Config } from "./config.ts";
import { exportWorkspaceZip } from "./export.ts";
import {
  attachFile,
  getAttachment,
  getMessage,
  insertMessage,
  listMessages,
  searchVisibleMessages,
  toggleReaction,
} from "./messages.ts";
import { RealtimeHub } from "./realtime.ts";
import type { ChannelType } from "./types.ts";

export type AppDeps = {
  db: DatabaseSync;
  config: Config;
  realtime: RealtimeHub;
};

function currentUser(req: Request) {
  return (req as unknown as AuthedRequest).user;
}

function httpError(err: unknown, res: Response): void {
  const status = (err as { status?: number }).status ?? 500;
  const message = err instanceof Error ? err.message : "오류";
  if (status >= 500) console.error(err);
  if (message === "NOT_ALLOWLISTED") {
    res.status(403).json({ error: "허용된 사내 계정이 아닙니다." });
    return;
  }
  if (message === "FORBIDDEN") {
    res.status(403).json({ error: "이 대화에 접근할 권한이 없습니다." });
    return;
  }
  if (message === "CHANNEL_NOT_FOUND") {
    res.status(404).json({ error: "채널을 찾을 수 없습니다." });
    return;
  }
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: message });
}

function parseChannelType(raw: unknown): ChannelType {
  if (raw === "public" || raw === "private") return raw;
  if (raw === "dm") {
    throw Object.assign(new Error("쪽지는 별도 화면에서 엽니다."), { status: 400 });
  }
  if (typeof raw === "string") {
    throw Object.assign(new Error("채널 종류가 올바르지 않습니다."), { status: 400 });
  }
  throw Object.assign(new Error("채널 종류가 필요합니다."), { status: 400 });
}

export function createApp(deps: AppDeps): express.Express {
  const { db, config, realtime } = deps;
  ensureGeneralChannel(db);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  app.use(express.static(publicDir));

  app.post("/api/auth/login", (req, res) => {
    try {
      const email = String(req.body?.email ?? "");
      const displayName = String(req.body?.displayName ?? "");
      const { user, token } = loginStaff(db, config, email, displayName);
      autoJoinPublicGeneral(db, user.id);
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 14 * 24 * 60 * 60 * 1000,
      });
      res.json({ user });
    } catch (err) {
      httpError(err, res);
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (token) destroySession(db, token);
    writeAudit(db, null, "auth.logout", "{}");
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  const refusePublicSignup = (_req: Request, res: Response): void => {
    res.status(404).json({ error: "공개 가입은 없습니다. 허용된 사내 계정만 입장합니다." });
  };
  app.all("/api/auth/signup", refusePublicSignup);
  app.all("/api/register", refusePublicSignup);

  const api = express.Router();
  api.use(authMiddleware(db));

  api.get("/me", (req, res) => {
    const user = currentUser(req);
    res.json({
      user,
      workspace: { name: config.workspaceName },
    });
  });

  api.get("/users", (req, res) => {
    const users = db
      .prepare("SELECT id, email, display_name, role, created_at FROM users ORDER BY display_name")
      .all();
    res.json({ users });
  });

  api.get("/channels", (req, res) => {
    const user = currentUser(req);
    res.json({
      channels: listMemberChannels(db, user.id),
      joinable: listJoinablePublic(db, user.id),
    });
  });

  api.post("/channels", (req, res) => {
    try {
      const user = currentUser(req);
      const type = parseChannelType(req.body?.type);
      const channel = createChannel(db, user, String(req.body?.name ?? ""), type);
      res.status(201).json({ channel });
    } catch (err) {
      httpError(err, res);
    }
  });

  api.post("/channels/:id/join", (req, res) => {
    try {
      const user = currentUser(req);
      const channelId = Number(req.params.id);
      const channel = db
        .prepare("SELECT id, type, name, created_by, created_at FROM channels WHERE id = ?")
        .get(channelId) as { id: number; type: ChannelType } | undefined;
      if (!channel) {
        res.status(404).json({ error: "채널을 찾을 수 없습니다." });
        return;
      }
      if (!canJoinUnaided(channel.type)) {
        res.status(403).json({ error: "초대 없이 들어갈 수 없는 대화입니다." });
        return;
      }
      addMember(db, user, channel.id, user.id, "join");
      res.json({ ok: true });
    } catch (err) {
      httpError(err, res);
    }
  });

  api.post("/channels/:id/members", (req, res) => {
    try {
      const user = currentUser(req);
      const channelId = Number(req.params.id);
      const channel = requireMembership(db, user.id, channelId);
      if (channel.type === "dm") {
        res.status(400).json({ error: "쪽지에는 멤버를 추가할 수 없습니다." });
        return;
      }
      const targetId = Number(req.body?.userId);
      if (!Number.isFinite(targetId)) {
        res.status(400).json({ error: "userId가 필요합니다." });
        return;
      }
      addMember(db, user, channelId, targetId, "invite");
      res.json({ ok: true });
    } catch (err) {
      httpError(err, res);
    }
  });

  api.delete("/channels/:id/members/:userId", (req, res) => {
    try {
      const user = currentUser(req);
      const channelId = Number(req.params.id);
      const channel = requireMembership(db, user.id, channelId);
      if (channel.type === "dm") {
        res.status(400).json({ error: "쪽지 멤버는 바꿀 수 없습니다." });
        return;
      }
      const targetId = Number(req.params.userId);
      if (user.role !== "admin" && user.id !== targetId) {
        res.status(403).json({ error: "자신을 나가거나 관리자만 멤버를 뺄 수 있습니다." });
        return;
      }
      removeMember(db, user, channelId, targetId);
      res.json({ ok: true });
    } catch (err) {
      httpError(err, res);
    }
  });

  api.get("/channels/:id/members", (req, res) => {
    try {
      const user = currentUser(req);
      const channelId = Number(req.params.id);
      requireMembership(db, user.id, channelId);
      const members = db
        .prepare(
          `SELECT u.id, u.email, u.display_name, u.role, m.joined_at
           FROM channel_members m
           JOIN users u ON u.id = m.user_id
           WHERE m.channel_id = ?
           ORDER BY u.display_name`,
        )
        .all(channelId);
      res.json({ members });
    } catch (err) {
      httpError(err, res);
    }
  });

  api.post("/dms", (req, res) => {
    try {
      const user = currentUser(req);
      const channel = getOrCreateDm(db, user, Number(req.body?.userId));
      res.json({ channel });
    } catch (err) {
      httpError(err, res);
    }
  });

  api.get("/channels/:id/messages", (req, res) => {
    try {
      const user = currentUser(req);
      const channelId = Number(req.params.id);
      requireMembership(db, user.id, channelId);
      const parentRaw = req.query.parentId;
      const parentId =
        parentRaw === undefined || parentRaw === "" ? null : Number(parentRaw);
      const messages = listMessages(db, user.id, channelId, parentId);
      res.json({ messages });
    } catch (err) {
      httpError(err, res);
    }
  });

  api.post("/channels/:id/messages", (req, res) => {
    try {
      const user = currentUser(req);
      const channelId = Number(req.params.id);
      requireMembership(db, user.id, channelId);
      const parentId =
        req.body?.parentId === undefined || req.body?.parentId === null
          ? null
          : Number(req.body.parentId);
      const message = insertMessage(db, user, channelId, String(req.body?.body ?? ""), parentId);
      realtime.emitToChannel(db, channelId, "message", {
        channelId,
        messageId: message.id,
        parentId: message.parent_id,
      });
      res.status(201).json({ message });
    } catch (err) {
      httpError(err, res);
    }
  });

  api.post("/messages/:id/reactions", (req, res) => {
    try {
      const user = currentUser(req);
      const message = getMessage(db, Number(req.params.id));
      if (!message) {
        res.status(404).json({ error: "메시지를 찾을 수 없습니다." });
        return;
      }
      requireMembership(db, user.id, message.channel_id);
      const result = toggleReaction(db, user.id, message.id, String(req.body?.emoji ?? ""));
      realtime.emitToChannel(db, message.channel_id, "reaction", {
        channelId: message.channel_id,
        messageId: message.id,
      });
      res.json(result);
    } catch (err) {
      httpError(err, res);
    }
  });

  api.post("/channels/:id/files", upload.single("file"), (req, res) => {
    try {
      const user = currentUser(req);
      const channelId = Number(req.params.id);
      requireMembership(db, user.id, channelId);
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "파일이 없습니다." });
        return;
      }
      const caption = String(req.body?.body ?? file.originalname);
      const parentId =
        req.body?.parentId === undefined || req.body?.parentId === ""
          ? null
          : Number(req.body.parentId);
      const message = insertMessage(db, user, channelId, caption, parentId);
      const stored = `${message.id}-${crypto.randomBytes(8).toString("hex")}${path.extname(file.originalname)}`;
      fs.mkdirSync(config.filesDir, { recursive: true });
      fs.writeFileSync(path.join(config.filesDir, stored), file.buffer);
      const attachment = attachFile(
        db,
        message.id,
        file.originalname,
        stored,
        file.mimetype || "application/octet-stream",
        file.size,
      );
      realtime.emitToChannel(db, channelId, "message", {
        channelId,
        messageId: message.id,
        parentId: message.parent_id,
      });
      res.status(201).json({ message, attachment });
    } catch (err) {
      httpError(err, res);
    }
  });

  api.get("/files/:id", (req, res) => {
    try {
      const user = currentUser(req);
      const attachment = getAttachment(db, Number(req.params.id));
      if (!attachment) {
        res.status(404).json({ error: "파일을 찾을 수 없습니다." });
        return;
      }
      const message = getMessage(db, attachment.message_id);
      if (!message) {
        res.status(404).json({ error: "파일을 찾을 수 없습니다." });
        return;
      }
      requireMembership(db, user.id, message.channel_id);
      const abs = path.join(config.filesDir, attachment.stored_name);
      if (!fs.existsSync(abs)) {
        res.status(404).json({ error: "파일이 디스크에 없습니다." });
        return;
      }
      res.setHeader("Content-Type", attachment.mime);
      res.setHeader(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`,
      );
      res.sendFile(path.resolve(abs));
    } catch (err) {
      httpError(err, res);
    }
  });

  api.get("/search", (req, res) => {
    try {
      const user = currentUser(req);
      const q = String(req.query.q ?? "");
      const results = searchVisibleMessages(db, user.id, q);
      res.json({ results });
    } catch (err) {
      httpError(err, res);
    }
  });

  api.get("/events", (req, res) => {
    const user = currentUser(req);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(`event: hello\ndata: ${JSON.stringify({ userId: user.id })}\n\n`);
    realtime.add(user.id, res);
  });

  api.get("/audit", adminOnly, (_req, res) => {
    res.json({ events: listAudit(db) });
  });

  api.get("/export", adminOnly, async (req, res) => {
    try {
      const user = currentUser(req);
      const buf = await exportWorkspaceZip(db, config, user);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="hearth-export.zip"; filename*=UTF-8''${encodeURIComponent(`hearth-${config.workspaceName}-export.zip`)}`,
      );
      res.send(buf);
    } catch (err) {
      httpError(err, res);
    }
  });

  app.use("/api", api);

  app.get("*", (_req, res, next) => {
    if (_req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(publicDir, "index.html"));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    httpError(err, res);
  });

  return app;
}
