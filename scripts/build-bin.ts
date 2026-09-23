// Compiles the CLI into a single-file executable with Bun.
//
//   bun scripts/build-bin.ts [--target bun-linux-x64] [--outfile release/zk-ceremony]
//
// Why not plain `bun build --compile`: the CLI flag cannot alias a package,
// and `web-worker` must be swapped for Bun's native Worker (see
// web-worker-bun-shim.js) or snarkjs cannot contribute under Bun.
import { parseArgs } from "node:util";
import path from "node:path";

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    outfile: { type: "string", default: "release/zk-ceremony" },
    entry: { type: "string", default: "src/index.ts" },
  },
});

const root = path.resolve(import.meta.dir, "..");
const shim = path.join(root, "scripts", "web-worker-bun-shim.js");

const result = await Bun.build({
  entrypoints: [path.resolve(root, values.entry!)],
  minify: true,
  compile: {
    outfile: path.resolve(root, values.outfile!),
    ...(values.target ? { target: values.target as any } : {}),
  },
  plugins: [
    {
      name: "web-worker -> Bun native Worker",
      setup(build) {
        build.onResolve({ filter: /^web-worker$/ }, () => ({ path: shim }));
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const out of result.outputs) {
  const size = Bun.file(out.path).size;
  console.log(`compiled ${out.path} (${(size / 1e6).toFixed(1)} MB)`);
}
