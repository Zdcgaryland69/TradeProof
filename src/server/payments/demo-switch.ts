// Switch for the 21 Oct anonymous Sandbox demo page and APIs (30 Oct: off).

/**
 * The 21 Oct Sandbox demo (anonymous, not tied to any procurement or account) is switched OFF since sign-in exists
 * (30 Oct, docs/access-control.md): its page and APIs answer 404 for everyone. Its USD 1.00 record stays in the
 * database unchanged. Approval payments (owner-only, approval-bound) replace it.
 */
export function sandboxDemoEnabled(): boolean {
  return false;
}
