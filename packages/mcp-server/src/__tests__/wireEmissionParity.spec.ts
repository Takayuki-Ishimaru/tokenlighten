/**
 * wireEmissionParity.spec.ts — GUIDE ↔ WIRE EMISSION PARITY (P0a §6.1/§6.5).
 *
 * guideSchemaParity.spec.ts proves the canonical agent guide and the tool
 * SCHEMA use the same vocabulary. It cannot prove the SERVER actually puts
 * those fields on the wire, and that gap shipped: the guide told agents to act
 * on `semantic_closure.state` and `capability_gaps[].next_call`, while the
 * default projection (TL_LEAN_CONTRACT defaults to true) emitted neither —
 * every lean phase shape dropped both. An agent following the canonical guide
 * was looking for fields the default configuration never sent.
 *
 * This spec closes that class: for each response field the guide instructs the
 * agent to ACT on, assert a DEFAULT-CONFIG emission path exists. It must fail
 * if someone re-introduces stripping.
 *
 * D10 (2026-08-14): TL_LEAN_CONTRACT is permanent-on and its reader is deleted,
 * so "the default projection" is now the ONLY projection. The former
 * lean-vs-full comparisons are replaced by an inertness pin: setting the flag
 * to its old rollback value must not change the wire.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskExecutionContract } from "@tokenlighten/types";

import { callTool } from "../server.js";
import { projectLeanExecutionContract } from "../util/leanExecutionContract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const GUIDE_TEMPLATES = [
  path.join(REPO_ROOT, "packages", "agents-md", "templates", "AGENTS.md.tmpl"),
  path.join(REPO_ROOT, "packages", "agents-md", "templates", "AGENTS.md.jp.tmpl"),
];

const roots: string[] = [];
const savedLeanFlag = process.env["TL_LEAN_CONTRACT"];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (savedLeanFlag === undefined) delete process.env["TL_LEAN_CONTRACT"];
  else process.env["TL_LEAN_CONTRACT"] = savedLeanFlag;
});

function workspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-wire-${tag}-`)));
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"wire-parity","type":"module"}\n');
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "order.ts"),
    "export class QuoteOrchestrator {\n  transition(state: string) { return state.trim(); }\n}\n",
  );
  fs.writeFileSync(
    path.join(root, "src", "ledger.ts"),
    "export function postLedgerEntry(amount: number) {\n  return amount * 2;\n}\n",
  );
  return root;
}

function body(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

/** Contract fixture carrying BOTH decision signals, one per phase shape. */
function contractWith(
  phase: TaskExecutionContract["typestate"]["phase"],
  overrides: Partial<TaskExecutionContract> = {},
): TaskExecutionContract {
  return {
    version: 1,
    state: phase === "prepared" ? "ready" : "needs-followup",
    readiness: phase === "prepared" ? "answer-ready" : "needs-followup",
    discovery_complete: phase === "prepared",
    next_action: phase === "prepared" ? "answer" : "followup",
    max_additional_discovery_calls: 1,
    reason: "wire parity fixture",
    typestate: {
      phase,
      ...(phase === "prepared" ? { certificate_id: "cert-parity" } : {}),
      allowed_actions: phase === "prepared" ? ["answer", "challenge"] : ["read", "search"],
      challenge_required_for: [],
    },
    semantic_closure: {
      version: 1,
      state: phase === "prepared" || phase === "done" ? "closed" : "open",
      closure_id: "closure-parity",
      obligations_total: 2,
      obligations_proved: phase === "prepared" ? 2 : 1,
      unresolved: phase === "prepared" ? [] : ["surface-content"],
    },
    capability_gaps: [{
      kind: "missing-evidence",
      recoverable: true,
      reason: "the behavior body for postLedgerEntry has not been served yet",
      next_call: { tool: "search_files", arguments: { action: "find", query: "postLedgerEntry" } },
    }],
    ...overrides,
  } as TaskExecutionContract;
}

describe("wire-emission parity — guide-referenced fields reach the default wire", () => {
  it("the canonical guide really does instruct agents to act on these fields", () => {
    // Premise guard: if a future guide edit stops referencing a field, this
    // spec's emission assertions below stop meaning anything — fail here with
    // the reason rather than silently testing a dead contract.
    // protocol v1 §3.4 E4 rows 4-9 moved both signals: the stop signal into
    // `decision.kind` and the gaps onto `decision.gaps`. Guide v67 follows
    // them, so the premise is asserted at the addresses the guide now names —
    // `semantic_closure`/`capability_gaps` no longer appear in either guide
    // BECAUSE they no longer appear on the wire, which is the thing this file
    // exists to keep true in both directions.
    for (const template of GUIDE_TEMPLATES) {
      const text = fs.readFileSync(template, "utf8");
      expect(text, `${template} no longer references decision.kind`).toContain("decision.kind");
      expect(text, `${template} no longer references the gaps carried by a discover decision`).toContain("`gaps`");
      expect(text, `${template} still references the deleted semantic_closure`).not.toContain("semantic_closure");
      expect(text, `${template} still references the deleted capability_gaps`).not.toContain("capability_gaps");
    }
  });

  it("D10: the lean projection is unconditional — TL_LEAN_CONTRACT is inert", async () => {
    // The flag is permanent-on and its reader is deleted (D10, 2026-08-14).
    // Setting the former rollback value must NOT resurrect the full contract:
    // that is precisely the "protocol whose shape changes with an env var"
    // the freeze exists to forbid.
    process.env["TL_LEAN_CONTRACT"] = "0";
    const wire = body(await callTool("read_file", {
      mode: "task_pack",
      query: "Explain QuoteOrchestrator transition behavior",
      symbol: "QuoteOrchestrator",
      taskProfile: "answer",
      cwd: workspace("inert"),
    }));
    // C2-3, A.5.1: `read.task_pack` is `{task, profile, evidence, decision,
    // plan?, limit?}` — there is NO `execution_contract` member at all. §2.2:
    // the contract "dissolved into `decision` + `plan`". The D10 property this
    // test exists for gets STRONGER, not weaker: the flag cannot resurrect a
    // shape the member does not have.
    expect(wire, `execution_contract reached the wire with TL_LEAN_CONTRACT=0: ${JSON.stringify(wire)}`)
      .not.toHaveProperty("execution_contract");
    for (const dropped of [
      "version", "state", "readiness", "typestate", "readiness_certificate",
      "call_budget", "evidence_model", "workspace_state", "next_action",
      // protocol v1 §3.4 E4 rows 4-9: the execution-contract re-encodings of
      // the single decision. Five of them were already 0/233 on the wire; the
      // deletion is what makes that structural instead of incidental.
      "discovery_complete", "semantic_closure", "max_additional_discovery_calls",
      "next_call", "capability_gaps",
    ]) {
      expect(wire, `${dropped} reached the wire with TL_LEAN_CONTRACT=0`)
        .not.toHaveProperty(dropped);
    }
    // The parity property itself: the decision the contract used to project is
    // still on the wire, once, at its single authority.
    expect(wire["decision"], JSON.stringify(wire)).toBeDefined();
  }, 30_000);

  it.each(["discovery", "awaiting-input", "prepared", "done"] as const)(
    "the lean %s projection carries semantic_closure and an actionable capability_gaps[].next_call",
    (phase) => {
      const lean = projectLeanExecutionContract(contractWith(phase)) as unknown as Record<string, unknown>;
      expect(lean["semantic_closure"], `${phase} dropped semantic_closure`).toEqual({
        state: phase === "prepared" || phase === "done" ? "closed" : "open",
      });
      const gaps = lean["capability_gaps"] as Array<Record<string, unknown>> | undefined;
      expect(gaps, `${phase} dropped capability_gaps`).toBeDefined();
      expect(gaps![0]!["next_call"], `${phase} gap has no actionable next_call`).toEqual({
        tool: "search_files",
        arguments: { action: "find", query: "postLedgerEntry" },
      });
    },
  );

  it("gives a gap with no next_call of its own the contract's bounded call rather than dropping it", () => {
    const contract = contractWith("discovery", {
      next_call: { tool: "read_file", arguments: { handle: "h-fallback", range: "1-40" } },
      capability_gaps: [{
        kind: "missing-evidence",
        recoverable: true,
        reason: "no per-gap call was derived for this obligation",
      }],
    });
    const lean = projectLeanExecutionContract(contract) as unknown as Record<string, unknown>;
    const gaps = lean["capability_gaps"] as Array<Record<string, unknown>>;
    expect(gaps[0]!["next_call"]).toEqual({ tool: "read_file", arguments: { handle: "h-fallback", range: "1-40" } });
  });

  it("emits nothing extra when the full contract carries neither signal", () => {
    const bare = contractWith("discovery", {
      next_call: { tool: "read_file", arguments: { handle: "h1" } },
    });
    delete (bare as { semantic_closure?: unknown }).semantic_closure;
    delete (bare as { capability_gaps?: unknown }).capability_gaps;
    const lean = projectLeanExecutionContract(bare) as unknown as Record<string, unknown>;
    expect(lean).not.toHaveProperty("semantic_closure");
    expect(lean).not.toHaveProperty("capability_gaps");
  });

  it("a REAL default-config prepared pack ships the closed stop signal the guide keys off", async () => {
    // protocol v1 §3.4 E4 row 8: `execution_contract.semantic_closure` is
    // DELETED from the wire and its information survives in `decision.kind`.
    // The parity property is unchanged — "the server actually puts the stop
    // signal on the wire" — but the field it is asserted against moved, which
    // is exactly what this spec is for: it must fail if the signal disappears
    // without a replacement, and pass when the replacement is real.
    delete process.env["TL_LEAN_CONTRACT"];
    const wire = body(await callTool("read_file", {
      mode: "task_pack",
      query: "Explain QuoteOrchestrator transition behavior",
      symbol: "QuoteOrchestrator",
      taskProfile: "answer",
      cwd: workspace("prepared"),
    }));
    // C2-3, A.5.1: the whole `execution_contract` is gone from the member, not
    // just its `semantic_closure` re-encoding.
    expect(wire, JSON.stringify(wire)).not.toHaveProperty("execution_contract");
    expect(wire).not.toHaveProperty("semantic_closure");
    // … and the single authority carries it. A `prepared` phase is a terminal
    // verdict, so the decision is one of the two `act` members or `done` —
    // never `discover`, which is what "stops" means.
    const decision = wire["decision"] as Record<string, unknown> | undefined;
    expect(decision, JSON.stringify(wire)).toBeDefined();
    expect(["act.answer", "act.edit", "done"], JSON.stringify(wire)).toContain(decision!["kind"]);
    // §2.1: a `next` on an act/done response is unrepresentable.
    expect(decision).not.toHaveProperty("next");
  }, 30_000);

  it("every response carries the protocol envelope the freeze announces (D1/D4)", async () => {
    // §1.2: "a payload without `v` is not a protocol-v1 payload". This is the
    // emission-parity form of that sentence — the announcement is worthless if
    // the responses do not carry it.
    // Each case gets its OWN fresh workspace rather than sharing one `root`.
    // 2026-08-21 (W1-A/W2-B answer-shaped auto-binding): "Explain X
    // behavior" now certifies straight to `act.answer` on the first call
    // (previously it did not reach a terminal decision this quickly), which
    // arms the long-standing prepared fence (session.ts
    // preparedDiscoveryReceipt, dedicated coverage in
    // executionTypestate.spec.ts/preparedReceiptHonesty.spec.ts) for the
    // REST of that session — by design, "an unrelated read mid-task is
    // still usually a mistake" and is fenced into a `decision-unchanged`
    // receipt rather than served fresh. A shared `root` therefore makes the
    // slice/skeleton cases below assert the fence's receipt instead of the
    // envelope shape this test exists to check; a fresh cwd per case keeps
    // them independent, as the file each of them targets (never served by
    // the pack above) was always meant to be.
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ mode: "task_pack", query: "Explain QuoteOrchestrator transition behavior", cwd: workspace("envelope-pack") }, "read.task_pack"],
      [{ mode: "slice", path: "src/ledger.ts", range: "1-2", cwd: workspace("envelope-slice") }, "read.text"],
      [{ mode: "skeleton", path: "src/ledger.ts", cwd: workspace("envelope-map") }, "read.map"],
    ];
    for (const [args, kind] of cases) {
      const wire = body(await callTool("read_file", args));
      expect(wire["v"], JSON.stringify(args)).toBe(1);
      expect(wire["kind"], JSON.stringify(args)).toBe(kind);
      // D6: body `ok` is deleted; `kind` is the outcome.
      expect(wire, JSON.stringify(args)).not.toHaveProperty("ok");
    }
    const tree = body(await callTool("search_files", { action: "tree", cwd: workspace("envelope-tree") }));
    expect(tree["v"]).toBe(1);
    expect(tree["kind"]).toBe("search.tree");
  }, 30_000);

  it("a REAL default-config pack never strips a signal its full contract carries", async () => {
    // D10 (2026-08-14): the full contract can no longer be obtained from the
    // wire — it is in-process state only. The parity property is therefore
    // asserted where it now lives: the emitted lean contract must carry the
    // decision signals the projection is required to preserve, on a real pack.
    const query = "wire up postLedgerEntry into the QuoteOrchestrator transition path";
    const lean = body(await callTool("read_file", {
      mode: "task_pack",
      query,
      taskProfile: "generic",
      cwd: workspace("lean"),
    }));
    // protocol v1: both decision signals moved off `execution_contract` — the
    // closure into `decision.kind` (§3.4 E4 row 8) and the gaps onto
    // `decision.discover.gaps` (A.2.7: "and nowhere else"). C2-3 then deleted
    // the container itself (A.5.1 has no such member). The parity property
    // survives both moves and is asserted at the new address.
    expect(lean, JSON.stringify(lean)).not.toHaveProperty("execution_contract");
    expect(lean, JSON.stringify(lean)).not.toHaveProperty("semantic_closure");
    expect(lean, JSON.stringify(lean)).not.toHaveProperty("capability_gaps");

    const decision = lean["decision"] as Record<string, unknown> | undefined;
    expect(decision, JSON.stringify(lean)).toBeDefined();
    expect(
      ["discover", "await_input", "act.answer", "act.edit", "done"],
      JSON.stringify(lean),
    ).toContain(decision!["kind"]);

    // §4.4: a gap is SEMANTIC — "none of them is fixed by asking for more
    // bytes" — so v1's `CapabilityGap` deliberately carries no call. What must
    // hold is that every emitted code is one the closed enum names.
    const gaps = decision!["gaps"] as Array<Record<string, unknown>> | undefined;
    for (const gap of gaps ?? []) {
      expect(["missing-evidence", "ambiguous-target", "workspace-changed"], JSON.stringify(lean))
        .toContain(gap["code"]);
      expect(gap, JSON.stringify(lean)).not.toHaveProperty("next_call");
    }
  }, 30_000);
});
