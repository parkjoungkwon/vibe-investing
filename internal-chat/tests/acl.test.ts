import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db.ts";
import { RealtimeHub } from "../src/realtime.ts";

const ALLOW = ["ada@hearth.local", "beom@hearth.local", "cy@hearth.local", "admin@hearth.local"];

function makeApp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hearth-"));
  const config = loadConfig({
    dataDir: tmp,
    dbPath: ":memory:",
    allowlist: ALLOW,
    adminEmails: ["admin@hearth.local"],
    workspaceName: "테스트실",
  });
  const db = openDatabase(":memory:");
  const app = createApp({ db, config, realtime: new RealtimeHub() });
  return { app, db, tmp };
}

async function login(app: ReturnType<typeof createApp>, email: string, displayName: string) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ email, displayName });
  expect(res.status).toBe(200);
  return { agent, user: res.body.user };
}

describe("Hearth ACL", () => {
  let app: ReturnType<typeof createApp>;
  let tmp: string;

  beforeEach(() => {
    const made = makeApp();
    app = made.app;
    tmp = made.tmp;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses emails that are not on the company allowlist", async () => {
    const res = await request(app).post("/api/auth/login").send({
      email: "stranger@example.com",
      displayName: "외부인",
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/허용된 사내 계정/);
  });

  it("does not expose a public signup route", async () => {
    const res = await request(app).post("/api/auth/signup").send({
      email: "ada@hearth.local",
    });
    expect(res.status).toBe(404);
  });

  it("keeps private channels and DMs out of another user's reads and search", async () => {
    const ada = await login(app, "ada@hearth.local", "이다은");
    const beom = await login(app, "beom@hearth.local", "김범");
    const cy = await login(app, "cy@hearth.local", "최윤");

    const privateCh = await beom.agent.post("/api/channels").send({
      name: "임원만",
      type: "private",
    });
    expect(privateCh.status).toBe(201);
    const privateId = privateCh.body.channel.id as number;

    await beom.agent.post(`/api/channels/${privateId}/members`).send({
      userId: cy.user.id,
    });

    const secretBody = "비공개핵SECRET_PRIVATE_TOKEN";
    await beom.agent.post(`/api/channels/${privateId}/messages`).send({
      body: secretBody,
    });

    const dm = await beom.agent.post("/api/dms").send({ userId: cy.user.id });
    expect(dm.status).toBe(200);
    const dmId = dm.body.channel.id as number;
    const dmBody = "쪽지핵SECRET_DM_TOKEN";
    await beom.agent.post(`/api/channels/${dmId}/messages`).send({ body: dmBody });

    const adaList = await ada.agent.get("/api/channels");
    const ids = adaList.body.channels.map((c: { id: number }) => c.id);
    expect(ids).not.toContain(privateId);
    expect(ids).not.toContain(dmId);
    expect(adaList.body.joinable.map((c: { id: number }) => c.id)).not.toContain(privateId);

    const adaPrivateRead = await ada.agent.get(`/api/channels/${privateId}/messages`);
    expect(adaPrivateRead.status).toBe(403);

    const adaDmRead = await ada.agent.get(`/api/channels/${dmId}/messages`);
    expect(adaDmRead.status).toBe(403);

    const adaJoin = await ada.agent.post(`/api/channels/${privateId}/join`);
    expect(adaJoin.status).toBe(403);

    const searchPrivate = await ada.agent.get("/api/search").query({ q: "SECRET_PRIVATE_TOKEN" });
    expect(searchPrivate.status).toBe(200);
    expect(searchPrivate.body.results).toHaveLength(0);

    const searchDm = await ada.agent.get("/api/search").query({ q: "SECRET_DM_TOKEN" });
    expect(searchDm.status).toBe(200);
    expect(searchDm.body.results).toHaveLength(0);

    const beomSearch = await beom.agent.get("/api/search").query({ q: "SECRET_PRIVATE_TOKEN" });
    expect(beomSearch.body.results.length).toBeGreaterThan(0);
    expect(beomSearch.body.results[0].body).toContain("SECRET_PRIVATE_TOKEN");

    const cySearchDm = await cy.agent.get("/api/search").query({ q: "SECRET_DM_TOKEN" });
    expect(cySearchDm.body.results.length).toBeGreaterThan(0);
  });

  it("lets a user search a public channel only after they are a member", async () => {
    const ada = await login(app, "ada@hearth.local", "이다은");
    const beom = await login(app, "beom@hearth.local", "김범");

    const created = await beom.agent.post("/api/channels").send({
      name: "리서치",
      type: "public",
    });
    const channelId = created.body.channel.id as number;
    await beom.agent.post(`/api/channels/${channelId}/messages`).send({
      body: "공개핵SECRET_PUBLIC_TOKEN",
    });

    const before = await ada.agent.get("/api/search").query({ q: "SECRET_PUBLIC_TOKEN" });
    expect(before.body.results).toHaveLength(0);

    const join = await ada.agent.post(`/api/channels/${channelId}/join`);
    expect(join.status).toBe(200);

    const after = await ada.agent.get("/api/search").query({ q: "SECRET_PUBLIC_TOKEN" });
    expect(after.body.results.length).toBeGreaterThan(0);
  });

  it("does not serve attachments from channels the caller is not in", async () => {
    const ada = await login(app, "ada@hearth.local", "이다은");
    const beom = await login(app, "beom@hearth.local", "김범");
    const privateCh = await beom.agent.post("/api/channels").send({
      name: "첨부잠금",
      type: "private",
    });
    const channelId = privateCh.body.channel.id as number;
    const upload = await beom.agent
      .post(`/api/channels/${channelId}/files`)
      .attach("file", Buffer.from("classified"), { filename: "secret.txt", contentType: "text/plain" })
      .field("body", "첨부 한 장");
    expect(upload.status).toBe(201);
    const fileId = upload.body.attachment.id as number;

    const stolen = await ada.agent.get(`/api/files/${fileId}`);
    expect(stolen.status).toBe(403);
  });

  it("allows only admins to export and to read the audit log", async () => {
    const ada = await login(app, "ada@hearth.local", "이다은");
    const admin = await login(app, "admin@hearth.local", "관리자");

    expect((await ada.agent.get("/api/export")).status).toBe(403);
    expect((await ada.agent.get("/api/audit")).status).toBe(403);

    const zip = await admin.agent.get("/api/export");
    expect(zip.status).toBe(200);
    expect(zip.headers["content-type"]).toMatch(/zip/);

    const audit = await admin.agent.get("/api/audit");
    expect(audit.status).toBe(200);
    const actions = audit.body.events.map((e: { action: string }) => e.action);
    expect(actions).toContain("workspace.export");
    expect(actions).toContain("auth.login");
  });
});
