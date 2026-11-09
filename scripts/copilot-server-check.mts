// Checks what a RUNNING dev server actually resolves (2 Nov, later), through the app's real sign-in — on a COPY only.
// Creates one throwaway [TEST] buyer in the copy (random password, memory only) and one [TEST] record it owns (MOCK
// replay run), then asks the server: Copilot mode (basis GET — no model call), extraction mode (extraction list GET),
// approval payments (a payment step POST must be refused 409 PAYMENTS_NOT_ENABLED before anything is read or written).
// Signs out at the end. Prints states only.
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/copilot-server-check.mts --db <copy the server uses>
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { AuthService } from "../src/server/auth/service.ts";
import { AuthStore } from "../src/server/auth/store.ts";
import { reviewAll, seedCase } from "../tests/helpers/approval-fixtures.ts";
import { openWorld } from "./copilot-world.mts";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const i = process.argv.indexOf("--db");
const db = resolve(i >= 0 ? (process.argv[i + 1] ?? "") : "");
if (i < 0 || db.toLowerCase() === resolve("data", "sandbox-payments.sqlite").toLowerCase()) throw new Error("--db must name the COPY the server runs on");

const store = new AuthStore(db);
const auth = new AuthService(store);
const tag = randomBytes(3).toString("hex");
const username = `config-check-${tag}`;
const password = randomBytes(18).toString("base64url");
await auth.createAccount(username, "BUYER", `[TEST] config check ${tag}`, password);
const me = auth.principalOfAccount(username)!;
const w = openWorld(db);
const s = await seedCase(w, "A", `config check ${tag}`, { principal: me, ownerId: me.id, ownerSource: "OPERATOR_SEED" });
reviewAll(w, s, { principal: me });
w.close();
store.close();

const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify({ username, password }) });
if (res.status !== 200) throw new Error(`login HTTP ${res.status}`);
const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
const cookie = cookies.join("; ");
const csrf = decodeURIComponent((cookies.find((c) => c.startsWith("tp_csrf=")) ?? "").slice(8));
const get = (p: string) => fetch(`${BASE}${p}`, { headers: { Cookie: cookie } });
const post = (p: string) => fetch(`${BASE}${p}`, { method: "POST", headers: { Cookie: cookie, Origin: BASE, "X-TradeProof-CSRF": csrf, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: "{}" });

const basis = (await (await get(`/api/procurements/${s.request.id}/copilot/basis?series=${s.seriesId}&version=${s.versionId}`)).json()) as { mode?: { kind: string; reason: string | null } };
const ex = (await (await get(`/api/procurements/${s.request.id}/quotes/${s.seriesId}/versions/${s.versionId}/extractions`)).json()) as { config?: { state: string; mode?: string; provider?: string } };
const pay = await post(`/api/procurements/${s.request.id}/approvals/ap_00000000-0000-4000-8000-000000000000/payment`);
const payBody = (await pay.json()) as { code?: string };
await post(`/api/auth/logout`);
console.log(
  JSON.stringify(
    {
      copilotMode: basis.mode,
      extraction: ex.config ? `${ex.config.state} ${ex.config.mode ?? ""} ${ex.config.provider ?? ""}`.trim() : "?",
      approvalPaymentStep: `${pay.status} ${payBody.code}`,
      checkAccount: username,
      checkRecord: s.request.id,
    },
    null,
    1,
  ),
);
