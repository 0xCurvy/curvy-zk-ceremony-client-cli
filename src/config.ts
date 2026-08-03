import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CliConfig {
  serverUrl: string;
  apiKey: string;
  workDir: string;
}

function configPath(): string {
  const dir = path.join(os.homedir(), ".curvy-zk-ceremony");
  return path.join(dir, "config.json");
}

export function loadConfig(): CliConfig {
  const p = configPath();
  if (!fs.existsSync(p)) {
    throw new Error(
      `No config found at ${p}. Run: zk-ceremony (interactive) or zk-ceremony config set --server <url> --api-key <key>`,
    );
  }
  return JSON.parse(fs.readFileSync(p, "utf8")) as CliConfig;
}

export function saveConfig(partial: Partial<CliConfig>): CliConfig {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const current = fs.existsSync(p)
    ? (JSON.parse(fs.readFileSync(p, "utf8")) as CliConfig)
    : {
        serverUrl: "http://localhost:3000",
        apiKey: "",
        workDir: path.join(os.homedir(), ".curvy-zk-ceremony", "work"),
      };
  const next = { ...current, ...partial };
  fs.writeFileSync(p, JSON.stringify(next, null, 2));
  return next;
}

export async function api<T>(
  method: string,
  route: string,
  opts: { body?: unknown; formData?: FormData; raw?: boolean } = {},
): Promise<T> {
  const cfg = loadConfig();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(`${cfg.serverUrl.replace(/\/$/, "")}${route}`, {
    method,
    headers,
    body,
  });

  if (opts.raw) {
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${method} ${route} failed: ${res.status} ${text}`);
    }
    return res as unknown as T;
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(
      `${method} ${route} failed: ${res.status} ${data.error || text}`,
    );
  }
  return data as T;
}
