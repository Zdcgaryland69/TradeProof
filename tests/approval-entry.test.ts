// Approval entry on the Quotes page (31 Oct): the link always names the selected version and an explicit run, never
// another version; without a usable run there is no preview link, only the reasons; roles decide the wording only
// (the approval page and the server decide who may approve).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { approvalEntry, type EntryChoices, type EntryRun } from "../src/lib/approval-entry.ts";

const ids = { requestId: "pr_00000000-0000-4000-8000-000000000001", seriesId: "qs_s", versionId: "qv_v2" };
const run = (id: string, startedAt: string, refusal: string | null = null): EntryRun => ({ id, mode: "MOCK", model: "m", startedAt, refusal });
const choices = (runs: EntryRun[], over: Partial<EntryChoices["version"]> = {}, base: EntryChoices["base"] = null): EntryChoices => ({
  version: { id: "qv_v2", versionNumber: 2, latestVersionNumber: 3, contentKind: "FULL_QUOTE", ...over },
  runs,
  base,
});
const query = (href: string) => Object.fromEntries(new URL(href, "http://x").searchParams);

describe("approval entry on the Quotes page", () => {
  test("names the selected version and the newest usable run; does not switch to the latest version", () => {
    const e = approvalEntry(ids, choices([run("qx_new", "2026-10-31T02:00:00Z", "LEGACY_RULES"), run("qx_ok", "2026-10-31T01:00:00Z"), run("qx_old", "2026-10-30T01:00:00Z")]), "APPROVER", null);
    assert.equal(e.kind, "PREVIEW");
    if (e.kind !== "PREVIEW") return;
    assert.deepEqual(query(e.href), { series: "qs_s", version: "qv_v2", run: "qx_ok" });
    assert.equal(e.run.id, "qx_ok");
    assert.deepEqual(e.otherRuns.map((r) => r.id), ["qx_old"]);
    assert.deepEqual([e.versionNumber, e.latestVersionNumber], [2, 3]);
  });

  test("a run the viewer picked is used only if it is a usable run of this version", () => {
    const c = choices([run("qx_a", "2026-10-31T02:00:00Z"), run("qx_b", "2026-10-31T01:00:00Z"), run("qx_bad", "2026-10-30T01:00:00Z", "RUN_NOT_FINISHED")]);
    const picked = approvalEntry(ids, c, "OWNER", true, "qx_b");
    assert.equal(picked.kind === "PREVIEW" && query(picked.href).run, "qx_b");
    for (const other of ["qx_bad", "qx_of_another_version"]) {
      const e = approvalEntry(ids, c, "OWNER", true, other);
      assert.equal(e.kind === "PREVIEW" && query(e.href).run, "qx_a", other);
    }
  });

  test("no usable run → no preview link; every stored run is listed with its reason; history link names no run", () => {
    const e = approvalEntry(ids, choices([run("qx_1", "2026-10-31T01:00:00Z", "LEGACY_RULES"), run("qx_2", "2026-10-30T01:00:00Z", "RUN_NOT_FINISHED")]), "OWNER", true);
    assert.equal(e.kind, "NO_USABLE_RUN");
    if (e.kind !== "NO_USABLE_RUN") return;
    assert.deepEqual(e.refused, [
      { runId: "qx_1", refusal: "LEGACY_RULES" },
      { runId: "qx_2", refusal: "RUN_NOT_FINISHED" },
    ]);
    assert.deepEqual(query(e.historyHref), { series: "qs_s", version: "qv_v2" });
    assert.ok(!("href" in e));
    const none = approvalEntry(ids, choices([]), "APPROVER", null);
    assert.equal(none.kind === "NO_USABLE_RUN" && none.refused.length, 0);
  });

  test("supplement: base run named when usable; otherwise flagged as missing, never hidden", () => {
    const sup = { contentKind: "SUPPLEMENT" };
    const withBase = approvalEntry(ids, choices([run("qx_s", "2026-10-31T01:00:00Z")], sup, { versionId: "qv_v1", versionNumber: 1, runs: [run("qx_b1", "2026-10-30T01:00:00Z", "BASE_IS_SUPPLEMENT"), run("qx_b2", "2026-10-29T01:00:00Z")] }), "APPROVER", null);
    assert.ok(withBase.kind === "PREVIEW");
    if (withBase.kind !== "PREVIEW") return;
    assert.deepEqual(query(withBase.href), { series: "qs_s", version: "qv_v2", run: "qx_s", baseRun: "qx_b2" });
    assert.equal(withBase.baseMissing, false);
    const noBase = approvalEntry(ids, choices([run("qx_s", "2026-10-31T01:00:00Z")], sup, { versionId: "qv_v1", versionNumber: 1, runs: [run("qx_b1", "2026-10-30T01:00:00Z", "LEGACY_RULES")] }), "OWNER", true);
    assert.ok(noBase.kind === "PREVIEW" && noBase.baseMissing && noBase.baseVersionNumber === 1 && !("baseRun" in query(noBase.href)));
    const full = approvalEntry(ids, choices([run("qx_f", "2026-10-31T01:00:00Z")]), "OWNER", true);
    assert.ok(full.kind === "PREVIEW" && !full.baseMissing && full.baseRun === null);
  });

  test("role and approver assignment are carried, not decided here; choices of another version are refused", () => {
    const c = choices([run("qx_a", "2026-10-31T01:00:00Z")]);
    const owner = approvalEntry(ids, c, "OWNER", false);
    assert.deepEqual([owner.role, owner.approverAssigned], ["OWNER", false]);
    const approver = approvalEntry(ids, c, "APPROVER", null);
    assert.deepEqual([approver.role, approver.approverAssigned], ["APPROVER", null]);
    assert.throws(() => approvalEntry({ ...ids, versionId: "qv_v3" }, c, "OWNER", true), /another quote version/);
  });
});
