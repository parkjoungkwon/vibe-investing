import path from "node:path";

export type Config = {
  port: number;
  sessionSecret: string;
  workspaceName: string;
  dataDir: string;
  filesDir: string;
  dbPath: string;
  allowlist: string[];
  adminEmails: string[];
};

function splitEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(overrides.dataDir ?? process.env.DATA_DIR ?? "./data");
  const allowlist = overrides.allowlist ?? splitEmails(process.env.ALLOWLIST_EMAILS);
  const adminEmails = overrides.adminEmails ?? splitEmails(process.env.ADMIN_EMAILS);
  return {
    port: overrides.port ?? Number(process.env.PORT ?? 3847),
    sessionSecret: overrides.sessionSecret ?? process.env.SESSION_SECRET ?? "hearth-dev-secret",
    workspaceName: overrides.workspaceName ?? process.env.WORKSPACE_NAME ?? "리서치실",
    dataDir,
    filesDir: path.join(dataDir, "files"),
    dbPath: overrides.dbPath ?? path.join(dataDir, "hearth.sqlite"),
    allowlist,
    adminEmails,
  };
}

export function isAllowlisted(config: Config, email: string): boolean {
  return config.allowlist.includes(email.trim().toLowerCase());
}

export function isAdminEmail(config: Config, email: string): boolean {
  return config.adminEmails.includes(email.trim().toLowerCase());
}
