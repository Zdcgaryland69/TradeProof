// Object-level access checks: the one place every read or write of a request's data (including the AI input context,
// approvals and payments) asks "may this principal see / change / approve / pay this request?".
//
// 30 Oct (schema v15, docs/access-control.md): every principal is a SIGNED-IN account resolved on the server from its
// session — a BUYER or an APPROVER. There is no anonymous or "local developer" principal any more: a request without a
// valid session is refused before it reaches these functions. Owner decisions (30 Oct):
// - a buyer sees and changes only the requests it owns (ownership is set when it creates a request, or by the local
//   operator seed; never by a client), assigns / revokes approvers on them, pays them, may revoke their approvals,
//   and can never approve;
// - an approver sees only requests currently assigned to it, may approve / revoke approvals there, and changes
//   nothing else (no edits, quotes, reviews, replies, payments).
// Callers pass the principal and the request id; the lookup reads ownership and grants from the database.

export type Role = "BUYER" | "APPROVER";

/** Server-side lookup behind the checks (AuthStore). Never built from client input. */
export interface AccessLookup {
  ownerOf(requestId: string): string | null;
  isAssignedApprover(requestId: string, approverId: string): boolean;
  scope(principal: Principal, alias: string): { sql: string; params: string[] };
}

export interface Principal {
  kind: Role;
  id: string;
  username: string;
  displayName: string;
  /** The session this principal was resolved from (null only for operator scripts that act as an account). */
  sessionId: string | null;
  access: AccessLookup;
}

const isOwner = (p: Principal, requestId: string) => p.kind === "BUYER" && p.access.ownerOf(requestId) === p.id;
const isAssigned = (p: Principal, requestId: string) => p.kind === "APPROVER" && p.access.isAssignedApprover(requestId, p.id);

/** May `principal` read this request and everything derived from it? Not allowed and not existing look the same. */
export function canReadRequest(principal: Principal, requestId: string): boolean {
  return isOwner(principal, requestId) || isAssigned(principal, requestId);
}

/**
 * SQL condition limiting a query to the requests `principal` may read, for lists and search. Callers join
 * `procurement_requests` as `alias` and AND this condition BEFORE matching, counting or LIMIT (design §6.2).
 */
export function requestScope(principal: Principal, alias: string): { sql: string; params: string[] } {
  return principal.access.scope(principal, alias);
}

/** May `principal` change this request's data (request, quotes, extraction runs and reviews, drafts, replies, classifications)? Owner only. */
export function canWriteRequest(principal: Principal, requestId: string): boolean {
  return isOwner(principal, requestId);
}

/** May `principal` create a new request (and become its owner)? */
export function canCreateRequest(principal: Principal): boolean {
  return principal.kind === "BUYER";
}

/** Assign or revoke an approver on this request. Owner only. */
export function canAssignApprover(principal: Principal, requestId: string): boolean {
  return isOwner(principal, requestId);
}

/** Approve this request's quote conditions: only an approver currently assigned to it (never the buyer). */
export function canApproveRequest(principal: Principal, requestId: string): boolean {
  return isAssigned(principal, requestId);
}

/** Start, create the PayPal order for, capture or reconcile an approval's payment: only the owning buyer. */
export function canPayRequest(principal: Principal, requestId: string): boolean {
  return isOwner(principal, requestId);
}

/** Revoke an approval (it can only stop further payment; not a refund): the owning buyer or the assigned approver. */
export function canRevokeApproval(principal: Principal, requestId: string): boolean {
  return isOwner(principal, requestId) || isAssigned(principal, requestId);
}

export interface Actor {
  kind: "LOCAL_DEV" | "BUYER" | "APPROVER";
  id: string | null;
  authenticated: boolean;
  /** Shown with every approval; never taken from the browser. */
  label: string;
}

/** Who acts now, from the trusted session. */
export function actorOf(principal: Principal): Actor {
  return { kind: principal.kind, id: principal.id, authenticated: true, label: `${principal.displayName} (${principal.kind === "BUYER" ? "buyer" : "approver"}, signed in)` };
}

/** Label of an actor as stored on an older record (approvals before 30 Oct were made by the unauthenticated local developer). */
export function storedActorLabel(kind: string, id: string | null, displayName?: string | null): string {
  if (kind === "LOCAL_DEV") return "Local developer (not signed in) — before sign-in existed; no separation of duties";
  return `${displayName ?? id ?? "unknown account"} (${kind === "BUYER" ? "buyer" : "approver"}, signed in)`;
}
