# @curvy/zk-ceremony-cli

Isolated participant CLI for Curvy ZK phase-2 ceremonies.

## Install (prebuilt binary)

Every `v*` tag publishes single-file executables (built with `bun build --compile`) to
[GitHub Releases](https://github.com/0xCurvy/curvy-zk-ceremony-client-cli/releases):

| Platform | Asset |
| --- | --- |
| Linux x64 | `zk-ceremony-linux-x64.tar.gz` |
| macOS Intel | `zk-ceremony-darwin-x64.tar.gz` |
| macOS Apple Silicon | `zk-ceremony-darwin-arm64.tar.gz` |
| Windows x64 | `zk-ceremony-windows-x64.zip` |

A `SHA256SUMS` file is attached to each release. No Node.js runtime is required.

```bash
tar -xzf zk-ceremony-darwin-arm64.tar.gz
./zk-ceremony
```

To build a binary for your own machine locally (requires [Bun](https://bun.sh)):

```bash
bun install
npm run build:bin   # -> release/zk-ceremony (see scripts/build-bin.ts)
```

## Install (local)

```bash
npm install
npm run build
npm link
```

## Usage

Run with no arguments for an interactive menu:

```bash
zk-ceremony
```

You can also run individual commands (useful for scripts):

```bash
zk-ceremony config set \
  --server http://localhost:3000 \
  --api-key ck_...

zk-ceremony circuits
zk-ceremony apply <circuitId> [circuitId...]
zk-ceremony apply --all             # all open circuits not already joined
zk-ceremony artifacts <circuitId>
zk-ceremony artifacts <circuitId> --download-ptau
zk-ceremony ptau <circuitId>        # download this circuit's PTAU only
zk-ceremony status
zk-ceremony wait                    # Socket.io; contribute when called
```

## PTAU

Each circuit has its own public `ptauUrl` — **sizes often differ** (e.g. 2^14 vs 2^20). The CLI never assumes a single shared PTAU file.

- `artifacts` always records that circuit's URL under `<workDir>/<circuitId>/ptau.url.txt` and `ptau.json`
- `--download-ptau` / `ptau` fetch the file into a **shared cache** at `<workDir>/_cache/ptau/`, keyed by URL (same URL → reuse; different size → separate file)
- Phase-2 contribution (`wait`) only needs the current `.zkey` from the server; PTAU is optional on the participant side

Admin operations (create users, register circuits, start ceremonies, reports) are on the **server Admin API**, not this CLI.
