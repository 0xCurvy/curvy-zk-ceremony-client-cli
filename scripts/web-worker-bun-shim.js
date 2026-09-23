// Replaces the `web-worker` npm package inside the Bun single-file executable.
//
// ffjavascript (used by snarkjs) spawns its thread pool through `web-worker`,
// whose Node implementation installs a fake `self.dispatchEvent` inside each
// worker. Bun workers already have the native one and reject the fake events,
// so the workers never answer, curve initialisation hangs forever, and the
// suspended contribute() frame gets garbage-collected along with its open
// zkey FileHandle (Bun then throws ERR_INVALID_STATE). Bun's global Worker
// accepts the same data: URL ffjavascript builds, so hand that over instead.
export default globalThis.Worker;
