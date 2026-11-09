// Diagnostic (2 Nov night): open one page in headless Edge with a saved e2e session of a database COPY and print
// console errors, exceptions and navigations for a few seconds. Writes nothing.
//   E2E_DB=<copy> node scripts/e2e/console-probe.mjs <url>
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2eDb, signInBrowser } from "./lib/e2e-auth.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DB = e2eDb();
const url = process.argv[2];
const PORT = 9800 + Math.floor(Math.random() * 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "tradeproof-probe-"));
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
  await signInBrowser(PORT, BASE, JSON.parse(readFileSync(`${DB}.e2e-session.json`, "utf8")));
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let seq = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") console.log("EXCEPTION", JSON.stringify(m.params.exceptionDetails).slice(0, 1500));
    if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) console.log("CONSOLE", m.params.type, m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 1500));
    if (m.method === "Page.frameNavigated" && !m.params.frame.parentId) console.log("NAVIGATED", m.params.frame.url.slice(0, 120));
  };
  const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++seq, method, params }));
  send("Page.enable");
  send("Runtime.enable");
  send("Page.navigate", { url });
  await sleep(8000);
  ws.close();
} finally {
  edge.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // profile may still be held briefly
  }
}
