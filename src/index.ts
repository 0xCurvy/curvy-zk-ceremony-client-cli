#!/usr/bin/env node
import { Command } from "commander";
import {
  applyToAllOpenCircuits,
  applyToCircuit,
  applyToCircuits,
  downloadArtifacts,
  downloadCircuitPtau,
  getStatus,
  listCircuits,
  setConfig,
  waitAndContribute,
} from "./commands.js";
import { runInteractive } from "./interactive.js";

const program = new Command();
program
  .name("zk-ceremony")
  .description("Participant CLI for Curvy ZK phase-2 ceremonies")
  .version("0.1.1")
  .action(async () => {
    await runInteractive();
  });

const configCmd = program.command("config").description("CLI configuration");

configCmd
  .command("set")
  .requiredOption("--server <url>", "Ceremony server base URL")
  .requiredOption("--api-key <key>", "Participant API key")
  .option("--work-dir <dir>", "Local working directory for artifacts")
  .action((opts: { server: string; apiKey: string; workDir?: string }) => {
    const cfg = setConfig(opts);
    console.log("Saved config:", cfg);
  });

program
  .command("circuits")
  .description("List open/running circuits")
  .action(async () => {
    const data = await listCircuits();
    console.log(JSON.stringify(data, null, 2));
  });

program
  .command("apply")
  .argument("[circuitIds...]", "One or more circuit ids")
  .option(
    "--all",
    "Apply to every open/running circuit not already joined",
  )
  .description(
    "Apply to circuit queue(s). Pass ids, or use --all for every open circuit you have not joined yet.",
  )
  .action(async (circuitIds: string[], opts: { all?: boolean }) => {
    if (opts.all) {
      const data = await applyToAllOpenCircuits();
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    if (!circuitIds.length) {
      throw new Error("Provide circuit id(s) or use --all");
    }
    const data =
      circuitIds.length === 1
        ? await applyToCircuit(circuitIds[0]!)
        : await applyToCircuits(circuitIds);
    console.log(JSON.stringify(data, null, 2));
  });

program
  .command("status")
  .description("Show your queue positions")
  .action(async () => {
    const data = await getStatus();
    console.log(JSON.stringify(data, null, 2));
  });

program
  .command("artifacts")
  .argument("<circuitId>", "Circuit id")
  .description(
    "Download compiled artifacts; record this circuit's PTAU URL (sizes differ per circuit)",
  )
  .option(
    "--download-ptau",
    "Also download this circuit's public PTAU into the shared cache",
  )
  .action(
    async (circuitId: string, opts: { downloadPtau?: boolean }) => {
      await downloadArtifacts(circuitId, {
        downloadPtau: Boolean(opts.downloadPtau),
      });
    },
  );

program
  .command("ptau")
  .argument("<circuitId>", "Circuit id")
  .description(
    "Download this circuit's public PTAU (cached by URL; sizes may differ)",
  )
  .action(async (circuitId: string) => {
    await downloadCircuitPtau(circuitId);
  });

program
  .command("wait")
  .description("Connect via Socket.io and contribute when called")
  .option("--name <name>", "Contribution name", "contributor")
  .option("--entropy <entropy>", "Entropy string (random if omitted)")
  .action(async (opts: { name: string; entropy?: string }) => {
    await waitAndContribute(opts);
    process.exit(0);
  });

program
  .command("interactive")
  .description("Launch the interactive menu")
  .action(async () => {
    await runInteractive();
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
