// TEST-ONLY principals for service-level unit tests that are NOT about access control (30 Oct). Their lookup grants
// ownership / assignment of every request in the temporary test database, so feature tests keep testing features.
// Access control itself is tested with the real AuthStore lookup, real sessions and real cookies
// (tests/access.test.ts). Nothing in src/ creates or accepts these; production code has no such bypass.

import { DatabaseSync } from "node:sqlite";
import type { AccessLookup, Principal } from "../../src/server/access/policy.ts";

const everything = (ownerId: string | null, assigned: boolean): AccessLookup => ({
  ownerOf: () => ownerId,
  isAssignedApprover: () => assigned,
  scope: (_p, alias) => ({ sql: `${alias}.id IS NOT NULL`, params: [] }),
});

/** A buyer that owns every request of the test DB. */
export function testBuyer(id = "u_test-buyer"): Principal {
  return { kind: "BUYER", id, username: "test-buyer", displayName: "Test buyer", sessionId: null, access: everything(id, false) };
}

/** An approver assigned to every request of the test DB. */
export function testApprover(id = "u_test-approver"): Principal {
  return { kind: "APPROVER", id, username: "test-approver", displayName: "Test approver", sessionId: null, access: everything(null, true) };
}

/** HTTP-layer gate for handler tests that are not about sign-in: always this principal, CSRF accepted. */
export const testGate = (p: Principal = testBuyer()) => ({ resolve: () => p, csrfOk: () => true });

/** Scope for ProcurementStore.list in store tests that are not about access: every request of the test DB. */
export const ALL_REQUESTS = { sql: "r.id IS NOT NULL", params: [] as string[] };

/**
 * Account rows for the test principals in a test DB (the ownership foreign key needs them when a test creates a
 * request through the HTTP handler). The stored hash is unusable on purpose: nobody can sign in with these.
 */
export function addTestAccounts(path: string): void {
  const db = new DatabaseSync(path);
  try {
    for (const [id, username, role] of [
      ["u_test-buyer", "test-buyer", "BUYER"],
      ["u_test-approver", "test-approver", "APPROVER"],
    ]) {
      db.prepare("INSERT OR IGNORE INTO principals (id, username, role, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, 'scrypt$unusable', ?)").run(id, username, role, username, new Date().toISOString());
    }
  } finally {
    db.close();
  }
}

/**
 * A real GRANT row for the test approver on a request (31 Oct, v17): an approval records the grant it was made under,
 * read from approver_grants inside the approve transaction, so the stub lookup alone is no longer enough. Test DB only.
 */
export function grantTestApprover(path: string, requestId: string): void {
  addTestAccounts(path);
  const db = new DatabaseSync(path);
  try {
    db.prepare("INSERT INTO approver_grants (request_id, approver_id, action, actor_id, created_at) VALUES (?, 'u_test-approver', 'GRANT', 'u_test-buyer', ?)").run(requestId, new Date().toISOString());
  } finally {
    db.close();
  }
}
