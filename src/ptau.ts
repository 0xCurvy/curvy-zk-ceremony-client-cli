import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadConfig } from "./config.js";

/** Human-readable label for a public PTAU URL (power / filename). */
export function ptauLabel(ptauUrl: string): string {
  const base = ptauUrl.split("/").pop()?.split("?")[0] || "powers.ptau";
  // powersOfTau28_hez_final_14.ptau → 2^14
  const numbered = base.match(/(?:final_)?(\d+)\.ptau$/i);
  if (numbered) {
    return `2^${numbered[1]} (${base})`;
  }
  // powersOfTau28_hez_final.ptau → filename only
  return base;
}

function cacheFilename(ptauUrl: string): string {
  const hash = createHash("sha256").update(ptauUrl).digest("hex").slice(0, 16);
  const base = ptauUrl.split("/").pop()?.split("?")[0] || "powers.ptau";
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${hash}-${safe}`;
}

export function ptauCacheDir(): string {
  const cfg = loadConfig();
  return path.join(cfg.workDir, "_cache", "ptau");
}

export function ptauCachePath(ptauUrl: string): string {
  return path.join(ptauCacheDir(), cacheFilename(ptauUrl));
}

/**
 * Download a circuit's public PTAU into a shared cache keyed by URL.
 * Circuits that share a URL reuse one file; different sizes stay separate.
 */
export async function ensurePtauCached(ptauUrl: string): Promise<string> {
  const dest = ptauCachePath(ptauUrl);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`PTAU already cached (${ptauLabel(ptauUrl)}):`, dest);
    return dest;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  console.log(`Downloading PTAU ${ptauLabel(ptauUrl)} …`);
  console.log(ptauUrl);

  const res = await fetch(ptauUrl);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download PTAU: HTTP ${res.status} from ${ptauUrl}`);
  }

  const tmp = `${dest}.partial`;
  try {
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      fs.createWriteStream(tmp),
    );
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }

  const sizeMb = (fs.statSync(dest).size / (1024 * 1024)).toFixed(1);
  console.log(`Cached PTAU (${sizeMb} MiB):`, dest);
  return dest;
}

/** Record this circuit's PTAU URL (+ optional local cache path) under its work dir. */
export function writeCircuitPtauNote(
  circuitDir: string,
  ptauUrl: string,
  localPath?: string,
): void {
  fs.mkdirSync(circuitDir, { recursive: true });
  fs.writeFileSync(path.join(circuitDir, "ptau.url.txt"), `${ptauUrl}\n`);
  const meta = {
    ptauUrl,
    label: ptauLabel(ptauUrl),
    ...(localPath ? { localPath } : {}),
  };
  fs.writeFileSync(
    path.join(circuitDir, "ptau.json"),
    `${JSON.stringify(meta, null, 2)}\n`,
  );
}
