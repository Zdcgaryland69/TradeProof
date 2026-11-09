// One thread of the concurrency test: opens its own connection, waits at a shared barrier, then races
// the other threads for a reservation on the same SQLite file. With `openAfterBarrier` the connection is
// opened only after the barrier, so the threads also race while opening (connection setup / PRAGMAs).
// Errors are not caught here: they reach the test as a worker error.
import { parentPort, workerData } from "node:worker_threads";
import type { BudgetConfig } from "../../src/server/budget/config.ts";
import { BudgetStore } from "../../src/server/budget/store.ts";

const { path, key, config, shared, inputTokensBound, openAfterBarrier } = workerData as {
  path: string;
  key: string;
  config: BudgetConfig;
  shared: SharedArrayBuffer;
  inputTokensBound: number;
  openAfterBarrier?: boolean;
};
const flag = new Int32Array(shared);
let store = openAfterBarrier ? null : new BudgetStore(path);
parentPort!.postMessage("ready");
Atomics.wait(flag, 0, 0);
store ??= new BudgetStore(path);
const r = store.reserve(config, { requestKey: key, extractionId: null, attempt: 1, inputTokensBound, outputTokensBound: 1000 });
store.close();
parentPort!.postMessage(r.status === "REFUSED" ? `REFUSED:${r.code}` : r.status);
