# @curvy/zk-ceremony-cli

Isolated participant CLI for Curvy ZK phase-2 ceremonies.

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
zk-ceremony apply <circuitId>
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
