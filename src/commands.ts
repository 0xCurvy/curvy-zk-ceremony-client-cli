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

export type ApplyResult = {
  circuitId: number;
  userId: number;
  position: number;
  status: string;
  created: boolean;
  alreadyApplied: boolean;
};

export type ApplyBatchResponse = {
  results: Array<ApplyResult | { circuitId: number | string; error: string }>;
  summary: {
    requested: number;
    created: number;
    alreadyApplied: number;
    failed: number;
  };
};

export async function applyToCircuits(
  circuitIds: Array<string | number>,
): Promise<ApplyBatchResponse> {
  const ids = [...new Set(circuitIds.map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length === 0) {
    throw new Error("At least one circuit id is required");
  }
  return api<ApplyBatchResponse>("POST", "/circuits/apply", {
    body: { circuitIds: ids },
  });
}

export async function applyToCircuit(
  circuitId: string | number,
): Promise<ApplyResult> {
  const batch = await applyToCircuits([circuitId]);
  const first = batch.results[0];
  if (!first) {
    throw new Error("Empty apply response");
  }
  if ("error" in first) {
    throw new Error(first.error);
  }
  return first;
}

/** Apply to every open/running circuit the user has not already joined. */
export async function applyToAllOpenCircuits(): Promise<ApplyBatchResponse> {
  const [{ circuits }, status] = await Promise.all([
    listCircuits(),
    getStatus() as Promise<{
      queue: Array<{ circuit_id: number | string }>;
    }>,
  ]);

  const already = new Set(
    (status.queue ?? []).map((q) => Number(q.circuit_id)),
  );
  const targets = (circuits ?? [])
    .map((c) => Number(c.id))
    .filter((id) => Number.isFinite(id) && !already.has(id));

  if (targets.length === 0) {
    return {
      results: [],
      summary: {
        requested: 0,
        created: 0,
        alreadyApplied: (circuits ?? []).length,
        failed: 0,
      },
    };
  }

  return applyToCircuits(targets);
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

  type QueueRow = {
    circuit_id: number | string;
    status: string;
  };

  const loadPendingCircuitIds = async (): Promise<Set<number>> => {
    const status = (await getStatus()) as { queue: QueueRow[] };
    const pending = new Set<number>();
    for (const row of status.queue ?? []) {
      if (row.status === "waiting" || row.status === "called") {
        pending.add(Number(row.circuit_id));
      }
    }
    return pending;
  };

  let pending = await loadPendingCircuitIds();
  if (pending.size === 0) {
    console.log("All contributions complete.");
    return;
  }

  console.log(
    `Subscribed to ${pending.size} circuit(s): ${[...pending].join(", ")}`,
  );
  console.log(`Connecting to ${cfg.serverUrl} ...`);

  let announcedConnect = false;
  let finished = false;
  let turnsInFlight = 0;
  let exitWhenIdle = false;

  await new Promise<void>((resolve) => {
    const socket = io(cfg.serverUrl, {
      auth: { token: cfg.apiKey },
      transports: ["websocket", "polling"],
      reconnection: true,
    });

    const finish = (message: string) => {
      if (finished) return;
      finished = true;
      console.log(message);
      socket.removeAllListeners();
      socket.disconnect();
      resolve();
    };

    const refreshAndMaybeFinish = async () => {
      if (finished) return;
      if (turnsInFlight > 0) {
        exitWhenIdle = true;
        return;
      }
      try {
        pending = await loadPendingCircuitIds();
      } catch (err) {
        console.warn(
          "Could not refresh queue status:",
          err instanceof Error ? err.message : err,
        );
        return;
      }
      if (pending.size === 0) {
        finish("All contributions complete.");
      }
    };

    socket.on("connect", () => {
      if (!announcedConnect) {
        announcedConnect = true;
        console.log("Connected. Waiting for your turn...");
      } else {
        console.log("Reconnected. Still waiting for your turn...");
      }
    });

    socket.on("connect_error", (err) => {
      console.warn(`Socket reconnecting (${err.message})…`);
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
        const circuitId = Number(payload.circuitId);
        pending.add(circuitId);
        turnsInFlight += 1;
        console.log("Your turn!", payload);
        console.log(`This circuit uses PTAU ${ptauLabel(payload.ptauUrl)}`);
        try {
          await handleTurn(payload, opts.name, opts.entropy);
          console.log("Contribution submitted for", circuitId);
        } catch (err) {
          console.error("Contribution failed:", err);
        } finally {
          turnsInFlight -= 1;
          if (exitWhenIdle || turnsInFlight === 0) {
            await refreshAndMaybeFinish();
          }
        }
      },
    );

    socket.on(
      "contribution:timeout",
      (payload: { circuitId: string | number }) => {
        console.warn("Timed out / skipped for", payload.circuitId);
        void refreshAndMaybeFinish();
      },
    );

    socket.on("ceremony:complete", (payload: { circuitId: string | number }) => {
      console.log("Ceremony complete:", payload.circuitId);
      void refreshAndMaybeFinish();
    });

    process.once("SIGINT", () => {
      finish("Interrupted.");
    });
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
