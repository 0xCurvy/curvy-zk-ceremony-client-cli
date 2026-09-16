import { confirm, input, password, select } from "@inquirer/prompts";
import {
  applyToAllOpenCircuits,
  applyToCircuit,
  downloadArtifacts,
  downloadCircuitPtau,
  getStatus,
  listCircuits,
  setConfig,
  waitAndContribute,
  type ApplyBatchResponse,
  type CircuitSummary,
} from "./commands.js";
import { loadConfig } from "./config.js";
import { ptauLabel } from "./ptau.js";

type MenuAction =
  | "config"
  | "circuits"
  | "apply"
  | "apply-all"
  | "artifacts"
  | "ptau"
  | "status"
  | "wait"
  | "exit";

function circuitLabel(c: CircuitSummary): string {
  const id = String(c.id ?? c.name ?? "?");
  const name = c.name && c.id != null ? ` — ${c.name}` : "";
  const status = c.status ? ` [${c.status}]` : "";
  const ptau = c.ptauUrl ? ` · ${ptauLabel(c.ptauUrl)}` : "";
  return `${id}${name}${status}${ptau}`;
}

function printApplyBatch(data: ApplyBatchResponse): void {
  const { summary, results } = data;
  if (summary.requested === 0 && summary.alreadyApplied > 0) {
    console.log(
      `Already applied to all ${summary.alreadyApplied} open circuit(s). Nothing new to join.`,
    );
    return;
  }
  if (summary.requested === 0) {
    console.log("No open circuits to apply to.");
    return;
  }
  console.log(
    `Applied: ${summary.created} new · already joined: ${summary.alreadyApplied} · failed: ${summary.failed}`,
  );
  for (const row of results) {
    if ("error" in row) {
      console.log(`  circuit ${row.circuitId}: error — ${row.error}`);
    } else if (row.created) {
      console.log(
        `  circuit ${row.circuitId}: joined (position ${row.position})`,
      );
    } else {
      console.log(
        `  circuit ${row.circuitId}: already applied (${row.status})`,
      );
    }
  }
}

async function pickCircuit(prompt: string): Promise<string | null> {
  let circuits: CircuitSummary[] = [];
  try {
    const data = await listCircuits();
    circuits = data.circuits ?? [];
  } catch {
    // Fall through to manual entry if listing fails
  }

  if (circuits.length === 0) {
    const circuitId = await input({
      message: `${prompt} (circuit id)`,
      validate: (v) => (v.trim() ? true : "Circuit id is required"),
    });
    return circuitId.trim();
  }

  const choice = await select({
    message: prompt,
    choices: [
      ...circuits.map((c) => ({
        name: circuitLabel(c),
        value: String(c.id ?? c.name),
      })),
      { name: "Enter circuit id manually…", value: "__manual__" },
      { name: "Cancel", value: "__cancel__" },
    ],
  });

  if (choice === "__cancel__") return null;
  if (choice === "__manual__") {
    const circuitId = await input({
      message: "Circuit id",
      validate: (v) => (v.trim() ? true : "Circuit id is required"),
    });
    return circuitId.trim();
  }
  return choice;
}

async function configure(): Promise<void> {
  let defaults = {
    serverUrl: "http://localhost:3000",
    apiKey: "",
    workDir: "",
  };
  try {
    defaults = { ...defaults, ...loadConfig() };
  } catch {
    // No existing config
  }

  const server = await input({
    message: "Ceremony server URL",
    default: defaults.serverUrl,
    validate: (v) => (v.trim() ? true : "Server URL is required"),
  });
  const apiKey = await password({
    message: defaults.apiKey
      ? "Participant API key (leave blank to keep current)"
      : "Participant API key",
    mask: "*",
    validate: (v) =>
      v.trim() || defaults.apiKey ? true : "API key is required",
  });
  const workDir = await input({
    message: "Local work directory (optional)",
    default: defaults.workDir || undefined,
  });

  const cfg = setConfig({
    server: server.trim(),
    apiKey: apiKey.trim() || defaults.apiKey,
    ...(workDir.trim() ? { workDir: workDir.trim() } : {}),
  });
  console.log("Saved config:", cfg);
}

export async function runInteractive(): Promise<void> {
  console.log("\nCurvy ZK Ceremony CLI\n");

  for (;;) {
    const action = await select<MenuAction>({
      message: "What would you like to do?",
      choices: [
        { name: "Configure CLI", value: "config" },
        { name: "List circuits", value: "circuits" },
        { name: "Apply to a circuit", value: "apply" },
        {
          name: "Apply to all open circuits (skip ones already joined)",
          value: "apply-all",
        },
        { name: "Download artifacts", value: "artifacts" },
        {
          name: "Download circuit PTAU (size varies per circuit)",
          value: "ptau",
        },
        { name: "Check queue status", value: "status" },
        { name: "Wait & contribute", value: "wait" },
        { name: "Exit", value: "exit" },
      ],
    });

    try {
      switch (action) {
        case "config":
          await configure();
          break;
        case "circuits": {
          const data = await listCircuits();
          for (const c of data.circuits ?? []) {
            console.log(circuitLabel(c));
            if (c.ptauUrl) console.log(`  ${c.ptauUrl}`);
          }
          if (!(data.circuits ?? []).length) {
            console.log(JSON.stringify(data, null, 2));
          }
          break;
        }
        case "apply": {
          const circuitId = await pickCircuit("Select a circuit to apply to");
          if (!circuitId) break;
          const data = await applyToCircuit(circuitId);
          console.log(JSON.stringify(data, null, 2));
          break;
        }
        case "apply-all": {
          const data = await applyToAllOpenCircuits();
          printApplyBatch(data);
          break;
        }
        case "artifacts": {
          const circuitId = await pickCircuit(
            "Select a circuit to download artifacts for",
          );
          if (!circuitId) break;
          const alsoPtau = await confirm({
            message:
              "Also download this circuit's PTAU? (each circuit may use a different size)",
            default: false,
          });
          await downloadArtifacts(circuitId, { downloadPtau: alsoPtau });
          break;
        }
        case "ptau": {
          const circuitId = await pickCircuit(
            "Select a circuit whose PTAU to download",
          );
          if (!circuitId) break;
          await downloadCircuitPtau(circuitId);
          break;
        }
        case "status": {
          const data = await getStatus();
          console.log(JSON.stringify(data, null, 2));
          break;
        }
        case "wait": {
          const name = await input({
            message: "Contribution name",
            default: "contributor",
          });
          const entropy = await input({
            message: "Entropy (leave blank for random)",
            default: "",
          });
          console.log(
            "Listening for your turn. Press Ctrl+C to abort.\n",
          );
          await waitAndContribute({
            name: name.trim() || "contributor",
            ...(entropy.trim() ? { entropy: entropy.trim() } : {}),
          });
          process.exit(0);
        }
        case "exit":
          console.log("Bye.");
          return;
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
    }

    console.log();
  }
}
