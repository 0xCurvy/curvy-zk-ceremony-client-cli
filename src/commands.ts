import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { io } from "socket.io-client";
import { api, loadConfig, saveConfig, type CliConfig } from "./config.js";
import {
  ensurePtauCached,
  ptauLabel,
  writeCircuitPtauNote,
} from "./ptau.js";

const require = createRequire(import.meta.url);
const snarkjs = require("snarkjs") as {
  zKey: {
    contribute: (
      input: string,
      output: string,
      name: string,
      entropy: string,
    ) => Promise<unknown>;
  };
};

export interface CircuitSummary {
  id?: string | number;
  name?: string;
  status?: string;
  ptauUrl?: string;
  [key: string]: unknown;
}

export function setConfig(opts: {
  server: string;
  apiKey: string;
  workDir?: string;
}): CliConfig {
  return saveConfig({
    serverUrl: opts.server,
    apiKey: opts.apiKey,
    ...(opts.workDir ? { workDir: opts.workDir } : {}),
  });
}

export async function listCircuits(): Promise<{ circuits: CircuitSummary[] }> {
  return api<{ circuits: CircuitSummary[] }>("GET", "/circuits");
}

export async function applyToCircuit(circuitId: string): Promise<unknown> {
  return api("POST", `/circuits/${circuitId}/apply`);
}

export async function getStatus(): Promise<unknown> {
  return api("GET", "/me/queue");
}

export async function downloadArtifacts(
  circuitId: string,
  opts: { downloadPtau?: boolean } = {},
): Promise<void> {
  const cfg = loadConfig();
  const dir = path.join(cfg.workDir, circuitId);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = await api<{
    ptauUrl: string;
    artifacts: { file: string; url: string }[];
    note: string;
  }>("GET", `/circuits/${circuitId}/artifacts`);

  console.log(manifest.note);
  console.log(
    `Circuit PTAU (${ptauLabel(manifest.ptauUrl)}):`,
    manifest.ptauUrl,
  );

  let localPtau: string | undefined;
  if (opts.downloadPtau) {
    localPtau = await ensurePtauCached(manifest.ptauUrl);
  }
  writeCircuitPtauNote(dir, manifest.ptauUrl, localPtau);

  for (const art of manifest.artifacts) {
    const res = await api<Response>("GET", new URL(art.url).pathname, {
      raw: true,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = path.join(dir, path.basename(art.file));
    fs.writeFileSync(dest, buf);
    console.log("Downloaded", dest);
  }
}

/** Fetch this circuit's public PTAU into the shared size/URL cache. */
export async function downloadCircuitPtau(circuitId: string): Promise<string> {
  const cfg = loadConfig();
  const dir = path.join(cfg.workDir, circuitId);
  const manifest = await api<{ ptauUrl: string }>(
    "GET",
    `/circuits/${circuitId}/artifacts`,
  );
  const local = await ensurePtauCached(manifest.ptauUrl);
  writeCircuitPtauNote(dir, manifest.ptauUrl, local);
  return local;
}

export async function waitAndContribute(opts: {
  name: string;
  entropy?: string;
}): Promise<void> {
  const cfg = loadConfig();
  fs.mkdirSync(cfg.workDir, { recursive: true });

  console.log(`Connecting to ${cfg.serverUrl} ...`);
  const socket = io(cfg.serverUrl, {
    auth: { token: cfg.apiKey },
    transports: ["websocket"],
  });

  socket.on("connect", () => {
    console.log("Connected. Waiting for your turn...");
  });

  socket.on("connect_error", (err) => {
    console.error("Socket error:", err.message);
  });

  socket.on(
    "contribution:your-turn",
    async (payload: {
      circuitId: string | number;
      deadline: string;
      zkeyUrl: string;
      artifactsUrl: string;
      ptauUrl: string;
    }) => {
      console.log("Your turn!", payload);
      console.log(
        `This circuit uses PTAU ${ptauLabel(payload.ptauUrl)}`,
      );
      try {
        await handleTurn(payload, opts.name, opts.entropy);
        console.log("Contribution submitted for", payload.circuitId);
      } catch (err) {
        console.error("Contribution failed:", err);
      }
    },
  );

  socket.on(
    "contribution:timeout",
    (payload: { circuitId: string | number }) => {
      console.warn("Timed out / skipped for", payload.circuitId);
    },
  );

  socket.on("ceremony:complete", (payload: { circuitId: string | number }) => {
    console.log("Ceremony complete:", payload.circuitId);
  });
}

async function handleTurn(
  payload: {
    circuitId: string | number;
    zkeyUrl: string;
    ptauUrl: string;
  },
  name: string,
  entropyFlag?: string,
): Promise<void> {
  const cfg = loadConfig();
  const circuitId = String(payload.circuitId);
  const dir = path.join(cfg.workDir, circuitId);
  fs.mkdirSync(dir, { recursive: true });

  // Record this circuit's own PTAU URL (sizes differ per circuit).
  // Phase-2 zkey contribute does not need the PTAU file locally.
  writeCircuitPtauNote(dir, payload.ptauUrl);

  const zkeyRes = await api<Response>(
    "GET",
    new URL(payload.zkeyUrl).pathname,
    { raw: true },
  );
  const inputZkey = path.join(dir, "current.zkey");
  fs.writeFileSync(inputZkey, Buffer.from(await zkeyRes.arrayBuffer()));

  const outputZkey = path.join(dir, "contributed.zkey");
  const entropy =
    entropyFlag ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${process.pid}`;

  console.log("Running snarkjs zkey contribute...");
  await snarkjs.zKey.contribute(inputZkey, outputZkey, name, entropy);

  const form = new FormData();
  const blob = new Blob([fs.readFileSync(outputZkey)]);
  form.append("file", blob, "contributed.zkey");

  const result = await api("POST", `/circuits/${circuitId}/contribute`, {
    formData: form,
  });
  console.log(result);
}
