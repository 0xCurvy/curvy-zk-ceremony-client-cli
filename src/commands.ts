import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
    circuit_status?: string;
    verifying?: boolean;
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

    type TurnPayload = {
      circuitId: string | number;
      deadline?: string;
      zkeyUrl: string;
      artifactsUrl?: string;
      ptauUrl: string;
    };

    /** Circuits whose turn this process is working on (download → upload). */
    const activeTurns = new Set<number>();

    const runTurn = async (payload: TurnPayload, pickedUp: boolean) => {
      const circuitId = Number(payload.circuitId);
      // The your-turn event and the on-connect check can both announce the same
      // turn; only one of them may run it.
      if (activeTurns.has(circuitId)) return;
      activeTurns.add(circuitId);
      pending.add(circuitId);
      turnsInFlight += 1;
      console.log(
        pickedUp ? "Your turn (already called, picking it up)!" : "Your turn!",
        payload,
      );
      console.log(`This circuit uses PTAU ${ptauLabel(payload.ptauUrl)}`);
      try {
        await handleTurn(payload, opts.name, opts.entropy);
      } catch (err) {
        console.error("Contribution failed:", err);
      } finally {
        activeTurns.delete(circuitId);
        turnsInFlight -= 1;
        if (exitWhenIdle || turnsInFlight === 0) {
          await refreshAndMaybeFinish();
        }
      }
    };

    // The server announces a turn once, to whoever is connected at that moment.
    // A CLI started after it was called, or whose socket dropped around it,
    // would otherwise wait out the whole deadline — so every (re)connect checks
    // for a turn that is already ours. One the server is verifying is left alone.
    const pickUpCalledTurns = async () => {
      let rows: QueueRow[];
      try {
        rows = ((await getStatus()) as { queue: QueueRow[] }).queue ?? [];
      } catch (err) {
        console.warn(
          "Could not check for an open turn:",
          err instanceof Error ? err.message : err,
        );
        return;
      }
      for (const row of rows) {
        const circuitId = Number(row.circuit_id);
        if (
          row.status !== "called" ||
          row.verifying ||
          row.circuit_status !== "running" ||
          activeTurns.has(circuitId)
        ) {
          continue;
        }
        try {
          const manifest = await api<{ ptauUrl: string }>(
            "GET",
            `/circuits/${circuitId}/artifacts`,
          );
          void runTurn(
            {
              circuitId,
              zkeyUrl: `${cfg.serverUrl.replace(/\/$/, "")}/circuits/${circuitId}/current-zkey`,
              ptauUrl: manifest.ptauUrl,
            },
            true,
          );
        } catch (err) {
          console.warn(
            `Could not pick up the turn for ${circuitId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    };

    socket.on("connect", () => {
      if (!announcedConnect) {
        announcedConnect = true;
        console.log("Connected. Waiting for your turn...");
      } else {
        console.log("Reconnected. Still waiting for your turn...");
      }
      void pickUpCalledTurns();
    });

    socket.on("connect_error", (err) => {
      console.warn(`Socket reconnecting (${err.message})…`);
    });

    socket.on("contribution:your-turn", (payload: TurnPayload) => {
      void runTurn(payload, false);
    });

    socket.on(
      "contribution:timeout",
      (payload: {
        circuitId: string | number;
        reason?: string;
        requeued?: boolean;
      }) => {
        if (payload.requeued) {
          console.warn(
            `Timed out / skipped for ${payload.circuitId} — requeued; waiting for another turn...`,
          );
        } else {
          console.warn(
            `Timed out / skipped for ${payload.circuitId} (no further turn)`,
          );
        }
        void refreshAndMaybeFinish();
      },
    );

    // The server acknowledges an upload right away and verifies it in the
    // background (minutes for a large circuit); the verdict arrives here.
    socket.on("contribution:accepted", (payload: { circuitId: string | number }) => {
      console.log("Contribution verified and accepted for", payload.circuitId);
      void refreshAndMaybeFinish();
    });

    socket.on(
      "contribution:rejected",
      (payload: { circuitId: string | number; reason: string }) => {
        if (payload.reason === "stale") {
          console.warn(
            `Upload for ${payload.circuitId} was verified after that turn had ended — discarded`,
          );
        } else {
          console.error(
            `Contribution for ${payload.circuitId} failed verification (no further turn)`,
          );
        }
        void refreshAndMaybeFinish();
      },
    );

    socket.on(
      "contribution:error",
      async (payload: { circuitId: string | number; message: string }) => {
        const circuitId = Number(payload.circuitId);
        console.warn(
          `Server could not verify the upload for ${circuitId} (${payload.message}); uploading again...`,
        );
        turnsInFlight += 1;
        try {
          await uploadContribution(String(circuitId));
        } catch (err) {
          console.error("Re-upload failed:", err);
        } finally {
          turnsInFlight -= 1;
          if (exitWhenIdle || turnsInFlight === 0) {
            await refreshAndMaybeFinish();
          }
        }
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

  await uploadContribution(circuitId);
}

/** A transfer that moves no bytes for this long is treated as dead. */
const UPLOAD_STALL_MS = 10 * 60_000;

/**
 * POST one file as multipart/form-data, streamed from disk.
 *
 * Not fetch(): Node's fetch (undici) gives up if response headers have not
 * arrived 300 s after the request started, and that clock includes sending the
 * body — a zkey of a few hundred MB on a slow uplink never finishes uploading.
 * Here only a stall fails the request, however long the upload takes.
 */
function postFile(
  route: string,
  filePath: string,
): Promise<{ status: number; body: string }> {
  const cfg = loadConfig();
  const url = new URL(`${cfg.serverUrl.replace(/\/$/, "")}${route}`);
  const boundary = `----zk-ceremony-${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${path.basename(filePath)}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const size = fs.statSync(filePath).size;
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": head.length + size + tail.length,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(UPLOAD_STALL_MS, () =>
      req.destroy(new Error(`upload stalled for ${UPLOAD_STALL_MS / 60_000} min`)),
    );

    // One growing line: "0.........10.........20 ... 100", a dot per percent.
    // Bytes are counted as they are read; the pipe's backpressure keeps that
    // within a buffer of what has actually gone out on the socket.
    let sent = 0;
    let shown = 0;
    let lineOpen = true;
    const closeLine = () => {
      if (lineOpen) process.stdout.write("\n");
      lineOpen = false;
    };
    process.stdout.write(
      `Uploading contribution (${(size / 1e6).toFixed(size < 10e6 ? 1 : 0)} MB): 0`,
    );
    req.once("close", closeLine);

    const file = fs.createReadStream(filePath);
    file.on("data", (chunk) => {
      sent += chunk.length;
      const pct = size > 0 ? Math.floor((sent / size) * 100) : 100;
      let out = "";
      while (shown < pct) {
        shown += 1;
        out += shown % 10 === 0 ? String(shown) : ".";
      }
      if (out) process.stdout.write(out);
    });
    file.on("error", (err) => req.destroy(err));
    file.on("end", () => {
      closeLine();
      req.end(tail);
    });
    req.write(head);
    file.pipe(req, { end: false });
  });
}

async function uploadContribution(circuitId: string): Promise<void> {
  const cfg = loadConfig();
  const outputZkey = path.join(cfg.workDir, circuitId, "contributed.zkey");
  const route = `/circuits/${circuitId}/contribute`;

  const { status, body } = await postFile(route, outputZkey);
  const result = (body ? JSON.parse(body) : {}) as {
    status?: string;
    error?: string;
  };
  if (status < 200 || status >= 300) {
    throw new Error(`POST ${route} failed: ${status} ${result.error || body}`);
  }
  if (result.status === "verifying") {
    console.log(
      `Upload received for ${circuitId}; the server is verifying it (your deadline is paused)...`,
    );
  } else {
    console.log("Contribution submitted for", circuitId, result);
  }
}
