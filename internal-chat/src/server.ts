import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { ensureDirs, openDatabase } from "./db.ts";
import { RealtimeHub } from "./realtime.ts";

function loadDotEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.resolve(here, "../.env"));
loadDotEnv(path.resolve(here, "../.env.example"));

const config = loadConfig();
if (config.allowlist.length === 0) {
  console.error("ALLOWLIST_EMAILS is empty. Copy .env.example to .env.");
  process.exit(1);
}

ensureDirs(config);
const db = openDatabase(config.dbPath);
const app = createApp({ db, config, realtime: new RealtimeHub() });

app.listen(config.port, () => {
  console.log(`Hearth (사내 채널) http://127.0.0.1:${config.port}`);
  console.log(`workspace: ${config.workspaceName}`);
  console.log(`allowlist: ${config.allowlist.join(", ")}`);
});
