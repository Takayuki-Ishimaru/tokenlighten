import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildTaskPack,
  concernAnchorTokens,
  resetPackDedupeCache,
  resetRoleInventoryCache,
} from "../tools/readCodeTaskPack.js";
import { callTool } from "../server.js";
import { handleTable } from "../util/handles.js";
import { resetAll as resetAllSessions } from "../util/session.js";

const workspaces: string[] = [];

function writeFile(workspace: string, relPath: string, content: string): void {
  const absolute = path.join(workspace, relPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, "utf8");
}

interface FixtureNames {
  sourceFile: string;
  sourceSymbol: string;
  consumerFile: string;
  consumerSymbol: string;
}

function makeWorkspace(
  tag: string,
  names: FixtureNames,
  withDecoy = false,
  serverAccessible = false,
): string {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(
    serverAccessible ? os.homedir() : os.tmpdir(),
    `.tl-evidence-${tag}-`,
  )));
  workspaces.push(workspace);
  writeFile(workspace, "package.json", JSON.stringify({ name: tag, type: "module" }) + "\n");
  writeFile(
    workspace,
    `app/core/${names.sourceFile}.ts`,
    `export function ${names.sourceSymbol}(): boolean {\n  return true;\n}\n`,
  );
  writeFile(
    workspace,
    `app/transport/${names.consumerFile}.ts`,
    [
      `import { ${names.sourceSymbol} } from "../core/${names.sourceFile}.js";`,
      `export function ${names.consumerSymbol}(): boolean {`,
      `  const value = ${names.sourceSymbol}();`,
      "  return value;",
      "}",
      "",
    ].join("\n"),
  );
  if (withDecoy) {
    writeFile(
      workspace,
      `app/decoys/${names.sourceFile}.ts`,
      `export function ${names.sourceSymbol}(): boolean {\n  return false;\n}\n`,
    );
  }
  return workspace;
}

interface UnlinkedFixtureNames {
  project: string;
  sourceFile: string;
  sourceSymbol: string;
  adapterFile: string;
  adapterSymbol: string;
  consumerFile: string;
  consumerSymbol: string;
}

function makeUnlinkedWorkspace(
  tag: string,
  names: UnlinkedFixtureNames,
  options: {
    sameNameDecoy?: boolean;
    commentDecoy?: boolean;
    consumerCallsAdapter?: boolean;
    consumerCallsSource?: boolean;
    consumerImportsSource?: boolean;
    directories?: { source: string; adapter: string; consumer: string };
  } = {},
): string {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-evidence-unlinked-${tag}-`)));
  const directories = options.directories ?? {
    source: "estimator",
    adapter: "adapter",
    consumer: "telemetry",
  };
  workspaces.push(workspace);
  writeFile(workspace, "package.json", JSON.stringify({ name: names.project, type: "module" }) + "\n");
  writeFile(
    workspace,
    `src/${directories.source}/${names.sourceFile}.ts`,
    `export function ${names.sourceSymbol}(input = true): boolean {\n  return input;\n}\n`,
  );
  writeFile(
    workspace,
    `src/${directories.source}/${names.sourceFile}.d.ts`,
    `export declare function ${names.sourceSymbol}(input?: boolean): boolean;\n`,
  );
  writeFile(
    workspace,
    `src/${directories.adapter}/${names.adapterFile}.ts`,
    [
      `export function ${names.adapterSymbol}(input: { healthy: boolean }) {`,
      "  return { healthBit: input.healthy ? 1 : 0 };",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    workspace,
    `src/${directories.consumer}/${names.consumerFile}.ts`,
    [
      ...(options.consumerImportsSource
        ? [`import { ${names.sourceSymbol} } from "../${directories.source}/${names.sourceFile}.js";`]
        : []),
      `import { ${names.adapterSymbol} } from "../${directories.adapter}/${names.adapterFile}.js";`,
      `export function ${names.consumerSymbol}(sourceHealth: boolean) {`,
      ...(options.consumerCallsSource ? [`  const sampled = ${names.sourceSymbol}();`] : []),
      options.consumerCallsAdapter === false
        ? "  const encoded = { healthBit: 1 };"
        : `  const encoded = ${names.adapterSymbol}({ healthy: true });`,
      "  return { encoded };",
      "}",
      "",
    ].join("\n"),
  );
  if (options.sameNameDecoy) {
    writeFile(
      workspace,
      `src/decoys/${names.sourceFile}.ts`,
      `export function ${names.sourceSymbol}(): boolean {\n  return false;\n}\n`,
    );
  }
  if (options.commentDecoy) {
    writeFile(
      workspace,
      "src/decoys/comment_only.ts",
      `/* ${names.sourceSymbol} ${names.adapterSymbol} ${names.consumerSymbol} */\nexport const unrelatedNoise = 1;\n`,
    );
  }
  return workspace;
}

function unlinkedQuery(names: UnlinkedFixtureNames): string {
  return `Wire ${names.sourceSymbol} health into ${names.consumerSymbol} using the existing ${names.adapterSymbol} adapter; replace the hard-coded healthy value so false clears the output health bit.`;
}

function structuralSignature(result: Awaited<ReturnType<typeof buildTaskPack>>) {
  return {
    profile: result.profile_binding?.selected,
    bindingSource: result.profile_binding?.source,
    wiringStatus: result.wiring?.status,
    relationKinds: [...new Set(
      result.wiring?.evidence_graph?.relations.map((relation) => relation.kind) ?? [],
    )].sort(),
    obligationKinds: result.execution_contract?.readiness_certificate?.obligations
      .map((obligation) => obligation.kind)
      .filter((kind) => kind.startsWith("wiring-"))
      .sort(),
  };
}

// D10 (2026-08-14): TL_EVIDENCE_RELATIONS is permanent-on; nothing to arm.
beforeEach(() => {
  handleTable.reset();
  resetAllSessions();
  resetPackDedupeCache();
  resetRoleInventoryCache();
});

afterEach(() => {
  delete process.env["TL_EVIDENCE_RELATIONS"];
  for (const workspace of workspaces.splice(0)) {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

describe("task_pack — repository-grounded evidence relations", () => {
  it("does not inject domain acronyms or benchmark translation aliases", () => {
    expect(concernAnchorTokens("制御 saturation の戻りを修正")).not.toContain("pid");
    expect(concernAnchorTokens("Quad-X yaw ミキサの向きを修正")).not.toContain("mixer");
    expect(concernAnchorTokens("センサー health telemetry estimator")).toEqual([
      "health",
      "telemetry",
      "estimator",
    ]);
  });

  it("preserves the graph and obligations after every project/file/symbol rename", async () => {
    const originalNames: FixtureNames = {
      sourceFile: "signal_source",
      sourceSymbol: "sampleSignal",
      consumerFile: "packet_sender",
      consumerSymbol: "transmitPacket",
    };
    const renamedNames: FixtureNames = {
      sourceFile: "pulse_reader",
      sourceSymbol: "collectPulse",
      consumerFile: "envelope_sender",
      consumerSymbol: "emitEnvelope",
    };
    const original = makeWorkspace("original-project", originalNames);
    const renamed = makeWorkspace("renamed-project", renamedNames);
    for (const workspace of [original, renamed]) {
      writeFile(
        workspace,
        "app/adapter/signal_adapter.ts",
        "export function encodeSignal(input: boolean): number { return input ? 1 : 0; }\n",
      );
    }

    const originalResult = await buildTaskPack({
      query: "Fix transmitPacket when sampleSignal returns the wrong boolean",
    }, original);
    const renamedResult = await buildTaskPack({
      query: "Fix emitEnvelope when collectPulse returns the wrong boolean",
    }, renamed);

    expect(structuralSignature(originalResult)).toEqual(structuralSignature(renamedResult));
    expect(originalResult.profile_binding).toMatchObject({ selected: "wiring", source: "evidence" });
    expect(structuralSignature(originalResult).relationKinds).toEqual([
      "defines",
      "direct_calls",
      "imports",
      "references",
    ]);
    expect(originalResult.wiring?.connections[0]?.evidence_ids?.length).toBeGreaterThan(0);
    const graphObligations = originalResult.execution_contract?.readiness_certificate?.obligations
      .filter((obligation) => obligation.kind.startsWith("wiring-")) ?? [];
    expect(graphObligations.some((obligation) => obligation.kind === "wiring-link")).toBe(true);
    expect(graphObligations.every((obligation) => (obligation.evidence_ids?.length ?? 0) > 0)).toBe(true);
    const obligationActions = (result: Awaited<ReturnType<typeof buildTaskPack>>) =>
      result.change_contract?.obligations
        .map((obligation) => `${obligation.kind}:${obligation.action}`)
        .sort();
    expect(obligationActions(renamedResult)).toEqual(obligationActions(originalResult));
    expect(originalResult.surfaces.some((surface) => surface.path.includes("/adapter/"))).toBe(false);
    expect(renamedResult.surfaces.some((surface) => surface.path.includes("/adapter/"))).toBe(false);
  }, 30000);

  it("does not require the caller to choose taskProfile=wiring", async () => {
    const names: FixtureNames = {
      sourceFile: "signal_source",
      sourceSymbol: "sampleSignal",
      consumerFile: "packet_sender",
      consumerSymbol: "transmitPacket",
    };
    const inferredWorkspace = makeWorkspace("profile-inferred", names);
    const explicitWorkspace = makeWorkspace("profile-explicit", names);
    const query = "Fix transmitPacket when sampleSignal returns the wrong boolean";

    const inferred = await buildTaskPack({ query }, inferredWorkspace);
    const explicit = await buildTaskPack({ query, taskProfile: "wiring" }, explicitWorkspace);

    expect(structuralSignature(inferred)).toMatchObject({
      profile: "wiring",
      bindingSource: "evidence",
      wiringStatus: "ready",
    });
    expect(structuralSignature(inferred).relationKinds).toEqual(structuralSignature(explicit).relationKinds);
    expect(structuralSignature(inferred).obligationKinds).toEqual(structuralSignature(explicit).obligationKinds);
  }, 30000);

  it("D10: TL_EVIDENCE_RELATIONS is inert — evidence binding is unconditional", async () => {
    // Was "keeps one rollback flag for paired legacy/evidence measurement".
    // D10 (2026-08-14) made evidence relations permanent-on and deleted the
    // legacy arm, so the rollback value must produce the evidence result.
    const names: FixtureNames = {
      sourceFile: "signal_source",
      sourceSymbol: "sampleSignal",
      consumerFile: "packet_sender",
      consumerSymbol: "transmitPacket",
    };
    const rollbackWorkspace = makeWorkspace("relations-off", names);
    const defaultWorkspace = makeWorkspace("relations-on", names);
    const query = "Fix transmitPacket when sampleSignal returns the wrong boolean";

    process.env["TL_EVIDENCE_RELATIONS"] = "0";
    const rollback = await buildTaskPack({ query }, rollbackWorkspace);
    delete process.env["TL_EVIDENCE_RELATIONS"];
    const byDefault = await buildTaskPack({ query }, defaultWorkspace);

    for (const [label, pack] of [["rollback", rollback], ["default", byDefault]] as const) {
      expect(pack.profile_binding, label).toMatchObject({ selected: "wiring", source: "evidence" });
      expect(pack.wiring?.status, label).toBe("ready");
    }
  }, 30000);

  it("is invariant to query paraphrase and condition order", async () => {
    const names: FixtureNames = {
      sourceFile: "signal_source",
      sourceSymbol: "sampleSignal",
      consumerFile: "packet_sender",
      consumerSymbol: "transmitPacket",
    };
    const forwardWorkspace = makeWorkspace("query-forward", names);
    const reorderedWorkspace = makeWorkspace("query-reordered", names);

    const forward = await buildTaskPack({
      query: "Fix transmitPacket when sampleSignal returns the wrong boolean",
    }, forwardWorkspace);
    const reordered = await buildTaskPack({
      query: "When sampleSignal returns the wrong boolean, fix transmitPacket",
    }, reorderedWorkspace);

    expect(structuralSignature(reordered)).toEqual(structuralSignature(forward));
  }, 30000);

  it("uses the consumer import instead of an unrelated same-name source", async () => {
    const names: FixtureNames = {
      sourceFile: "signal_source",
      sourceSymbol: "sampleSignal",
      consumerFile: "packet_sender",
      consumerSymbol: "transmitPacket",
    };
    const query = "Fix transmitPacket when sampleSignal returns the wrong boolean";
    const baseline = await buildTaskPack({ query }, makeWorkspace("same-name-baseline", names));
    const workspace = makeWorkspace("same-name-decoy", names, true, true);
    const response = await callTool("read_file", {
      mode: "task_pack",
      query,
      cwd: workspace,
    });
    const result = JSON.parse(response.content[0]!.text) as Record<string, any>;
    // A.5.1: `wiring` and `change_contract` are PLAN_MEMBERS and ride under
    // `plan`, not at the top level, on the projected read.task_pack wire.
    const plan = result["plan"] as Record<string, any> | undefined;
    const connection = plan?.["wiring"]?.connections?.[0];
    const surfaces = result["evidence"] as Array<Record<string, any>>;
    const reviewPaths = plan?.["wiring"]?.review_frontier
      ?.map((handle: string) => surfaces.find((surface) => surface.handle === handle)?.path) ?? [];

    expect(connection?.source?.path).toBe("app/core/signal_source.ts");
    expect(connection?.destination?.path).toBe("app/transport/packet_sender.ts");
    expect(plan?.["wiring"]?.evidence_graph?.relations
      ?.some((relation: Record<string, any>) => relation.kind === "imports")).toBe(true);
    expect(surfaces.some((surface) => surface.path.startsWith("app/decoys/"))).toBe(false);
    expect(reviewPaths).toEqual(["app/core/signal_source.ts"]);
    expect(plan?.["change_contract"]?.obligations
      ?.map((obligation: Record<string, any>) => `${obligation.kind}:${obligation.action}`)
      .sort()).toEqual(
        baseline.change_contract?.obligations
          .map((obligation) => `${obligation.kind}:${obligation.action}`)
          .sort(),
      );
  }, 30000);

  it("emits imports only for the concrete module target when a same-name decoy exists", async () => {
    const names: UnlinkedFixtureNames = {
      project: "signal-flight",
      sourceFile: "signal_source",
      sourceSymbol: "sampleSignal",
      adapterFile: "signal_adapter",
      adapterSymbol: "encodeSignal",
      consumerFile: "packet_sender",
      consumerSymbol: "transmitPacket",
    };
    const workspace = makeUnlinkedWorkspace("same-name-import-relation", names, {
      sameNameDecoy: true,
      consumerCallsSource: true,
      consumerImportsSource: true,
    });
    const response = await callTool("read_file", {
      mode: "task_pack",
      query: unlinkedQuery(names),
      paths: ["src"],
      taskProfile: "wiring",
      cwd: workspace,
    });
    const result = JSON.parse(response.content[0]!.text) as Record<string, any>;
    const plan = result["plan"] as Record<string, any> | undefined;
    const connection = plan?.["wiring"]?.connections?.[0];
    const graph = plan?.["wiring"]?.evidence_graph;
    const nodes = new Map<string, Record<string, any>>(
      (graph?.nodes ?? []).map((node: Record<string, any>) => [node.id, node] as const),
    );
    const importPairs = (graph?.relations ?? [])
      .filter((relation: Record<string, any>) => relation.kind === "imports")
      .map((relation: Record<string, any>) => ({
        from: nodes.get(relation.from)?.path,
        to: nodes.get(relation.to)?.path,
      }));

    // execution_contract is deleted from the read.task_pack wire (A.5.1); the
    // "ready to act" fact it carried via `phase:"prepared"` is now
    // `decision.kind === "act.edit"` (A.3): a bounded, certified edit
    // frontier, not a bare answer — this is a wiring insertion.
    expect((result["decision"] as { kind?: string } | undefined)?.kind).toBe("act.edit");
    expect(connection?.source?.path).toBe("src/estimator/signal_source.ts");
    expect(connection?.destination?.path).toBe("src/telemetry/packet_sender.ts");
    expect(importPairs).toEqual(expect.arrayContaining([
      {
        from: "src/telemetry/packet_sender.ts",
        to: "src/estimator/signal_source.ts",
      },
      {
        from: "src/telemetry/packet_sender.ts",
        to: "src/adapter/signal_adapter.ts",
      },
    ]));
    expect(importPairs.some(({ from, to }: { from?: string; to?: string }) =>
      from?.includes("/decoys/") || to?.includes("/decoys/"))).toBe(false);
    expect([...nodes.values()].some((node: Record<string, any>) =>
      node.path?.includes("/decoys/"))).toBe(false);
  }, 30000);

  it("serves an exact new-connection task_pack with a callable insertion handle and disjoint frontiers", async () => {
    const names: UnlinkedFixtureNames = {
      project: "signal-flight",
      sourceFile: "signal_source",
      sourceSymbol: "sampleSignal",
      adapterFile: "signal_adapter",
      adapterSymbol: "encodeSignal",
      consumerFile: "packet_sender",
      consumerSymbol: "transmitPacket",
    };
    const workspace = makeUnlinkedWorkspace("exact-call", names);
    const response = await callTool("read_file", {
      mode: "task_pack",
      query: unlinkedQuery(names),
      paths: ["src"],
      taskProfile: "wiring",
      cwd: workspace,
    });
    const result = JSON.parse(response.content[0]!.text) as Record<string, any>;
    const plan = result["plan"] as Record<string, any> | undefined;
    const connection = plan?.["wiring"]?.connections?.[0];
    const surfaces = result["evidence"] as Array<Record<string, any>>;
    const adapter = surfaces.find((surface) => surface.path === "src/adapter/signal_adapter.ts");
    // execution_contract is deleted from the read.task_pack wire (A.5.1); the
    // "ready to act" fact it carried via `phase:"prepared"` is now
    // `decision.kind === "act.edit"` (A.3).
    const decision = result["decision"] as { kind?: string } | undefined;

    expect(decision?.kind).toBe("act.edit");
    expect(connection?.source?.path).toBe("src/estimator/signal_source.ts");
    expect(connection?.destination?.path).toBe("src/telemetry/packet_sender.ts");
    expect(connection?.destination?.token).toBe(names.consumerSymbol);
    expect(connection?.insertion_handle).toBe(connection?.destination?.handle);
    const consumerNode = plan?.["wiring"]?.evidence_graph?.nodes?.find(
      (node: Record<string, any>) =>
        node.kind === "symbol"
        && node.handle === connection?.destination?.handle,
    );
    expect(consumerNode?.symbol).toBe(names.consumerSymbol);
    expect(handleTable.get(connection?.insertion_handle)).toMatchObject({
      path: "src/telemetry/packet_sender.ts",
    });
    expect(plan?.["wiring"]?.edit_frontier).toEqual([connection?.destination?.handle]);
    expect(plan?.["wiring"]?.review_frontier).toEqual(expect.arrayContaining([
      connection?.source?.handle,
      adapter?.handle,
    ]));
    expect(plan?.["wiring"]?.review_frontier).not.toContain(connection?.destination?.handle);
  }, 30000);

  it("keeps a new-connection pack invariant after project/file/symbol rename", async () => {
    const originalNames: UnlinkedFixtureNames = {
      project: "signal-flight",
      sourceFile: "signal_source",
      sourceSymbol: "sampleSignal",
      adapterFile: "signal_adapter",
      adapterSymbol: "encodeSignal",
      consumerFile: "packet_sender",
      consumerSymbol: "transmitPacket",
    };
    const renamedNames: UnlinkedFixtureNames = {
      project: "renamed-pulse-project",
      sourceFile: "pulse_reader",
      sourceSymbol: "collectPulse",
      adapterFile: "pulse_bridge",
      adapterSymbol: "mapPulse",
      consumerFile: "envelope_emitter",
      consumerSymbol: "emitEnvelope",
    };
    const original = await buildTaskPack({
      query: unlinkedQuery(originalNames),
      paths: ["src"],
      taskProfile: "wiring",
    }, makeUnlinkedWorkspace("new-connection-original", originalNames));
    const renamed = await buildTaskPack({
      query: unlinkedQuery(renamedNames),
      paths: ["src"],
      taskProfile: "wiring",
    }, makeUnlinkedWorkspace("new-connection-renamed", renamedNames));
    const signature = (result: Awaited<ReturnType<typeof buildTaskPack>>) => ({
      status: result.wiring?.status,
      phase: result.execution_contract?.typestate.phase,
      obligationKinds: result.execution_contract?.readiness_certificate?.obligations
        .filter((obligation) => obligation.kind.startsWith("wiring-"))
        .map((obligation) => `${obligation.kind}:${obligation.status}`)
        .sort(),
      relationKinds: [...new Set(
        result.wiring?.evidence_graph?.relations.map((relation) => relation.kind) ?? [],
      )].sort(),
      editCount: result.wiring?.edit_frontier.length,
      reviewCount: result.wiring?.review_frontier.length,
      actionFrontierMatchesEdit: result.execution_contract?.readiness_certificate?.action_frontier
        .every((handle) => result.wiring?.edit_frontier.includes(handle)),
      maxAdditionalCalls: result.change_contract?.max_additional_tl_calls,
      routeMaxAdditionalCalls: result.route?.max_additional_tl_calls,
      insertionIsConsumer: result.wiring?.connections[0]?.insertion_handle
        === result.wiring?.connections[0]?.destination?.handle,
      frontiersDisjoint: result.wiring?.edit_frontier.every(
        (handle) => !result.wiring?.review_frontier.includes(handle),
      ),
    });

    expect(signature(renamed)).toEqual(signature(original));
    expect(signature(original)).toMatchObject({
      status: "ready",
      phase: "prepared",
      editCount: 1,
      reviewCount: 2,
      actionFrontierMatchesEdit: true,
      maxAdditionalCalls: 0,
      routeMaxAdditionalCalls: 0,
      insertionIsConsumer: true,
      frontiersDisjoint: true,
    });
  }, 30000);

  it("keeps a new connection prepared after query reorder, profile omission, and neutral directories", async () => {
    const names: UnlinkedFixtureNames = {
      project: "signal-flight",
      sourceFile: "signal_source",
      sourceSymbol: "sampleSignal",
      adapterFile: "signal_adapter",
      adapterSymbol: "encodeSignal",
      consumerFile: "packet_sender",
      consumerSymbol: "transmitPacket",
    };
    const baseline = await buildTaskPack({
      query: unlinkedQuery(names),
      paths: ["src"],
      taskProfile: "wiring",
    }, makeUnlinkedWorkspace("metamorphic-baseline", names));
    const transformed = await buildTaskPack({
      query: `Using ${names.adapterSymbol}, replace the hard-coded healthy input in ${names.consumerSymbol} with the value from ${names.sourceSymbol}; when the value is false, the output health bit must clear.`,
      paths: ["src"],
    }, makeUnlinkedWorkspace("metamorphic-transformed", names, {
      directories: {
        source: "unit_a",
        adapter: "unit_b",
        consumer: "unit_c",
      },
    }));
    const connection = transformed.wiring?.connections[0];
    const surfaces = new Map(
      transformed.surfaces.map((surface) => [surface.handle, surface]),
    );
    const reviewPaths = transformed.wiring?.review_frontier
      .map((handle) => surfaces.get(handle)?.path) ?? [];
    const obligationActions = (result: Awaited<ReturnType<typeof buildTaskPack>>) =>
      result.change_contract?.obligations
        .map((obligation) => `${obligation.kind}:${obligation.action}`)
        .sort();

    expect(transformed.profile_binding).toMatchObject({
      selected: "wiring",
      source: "evidence",
    });
    expect(transformed.execution_contract?.typestate.phase).toBe("prepared");
    expect(transformed.route).toMatchObject({
      action: "edit_from_handles",
      max_additional_tl_calls: 0,
    });
    expect(transformed.change_contract?.max_additional_tl_calls).toBe(0);
    expect(transformed.route?.max_additional_tl_calls)
      .toBe(baseline.route?.max_additional_tl_calls);
    expect(transformed.change_contract?.max_additional_tl_calls)
      .toBe(baseline.change_contract?.max_additional_tl_calls);
    expect(connection?.source?.path).toBe("src/unit_a/signal_source.ts");
    expect(connection?.destination?.path).toBe("src/unit_c/packet_sender.ts");
    expect(connection?.insertion_handle).toBe(connection?.destination?.handle);
    expect(connection?.evidence).toContain("callable-insertion-site");
    expect(transformed.wiring?.edit_frontier).toEqual([
      connection?.destination?.handle,
    ]);
    expect(transformed.execution_contract?.readiness_certificate?.action_frontier)
      .toEqual(transformed.wiring?.edit_frontier);
    const relationKinds = new Set(
      transformed.wiring?.evidence_graph?.relations.map((relation) => relation.kind) ?? [],
    );
    expect(relationKinds.has("imports")).toBe(true);
    expect(relationKinds.has("direct_calls")).toBe(true);
    const graphRelations = new Map(
      transformed.wiring?.evidence_graph?.relations.map((relation) => [relation.id, relation]) ?? [],
    );
    for (const obligation of transformed.execution_contract?.readiness_certificate?.obligations
      .filter((item) => item.kind === "wiring-link" || item.kind === "wiring-insertion") ?? []) {
      expect(obligation.evidence_ids?.length).toBeGreaterThan(0);
      expect(obligation.evidence_ids?.some((id) => graphRelations.get(id)?.kind === "defines")).toBe(false);
    }
    expect(reviewPaths).toEqual(expect.arrayContaining([
      "src/unit_a/signal_source.ts",
      "src/unit_b/signal_adapter.ts",
    ]));
    expect(reviewPaths).not.toContain("src/unit_c/packet_sender.ts");
    expect(obligationActions(transformed)).toEqual(obligationActions(baseline));
  }, 30000);

  it("does not prepare without an edit-grade consumer call argument", async () => {
    const names: UnlinkedFixtureNames = {
      project: "signal-flight",
      sourceFile: "signal_source",
      sourceSymbol: "sampleSignal",
      adapterFile: "signal_adapter",
      adapterSymbol: "encodeSignal",
      consumerFile: "packet_sender",
      consumerSymbol: "transmitPacket",
    };
    const result = await buildTaskPack({
      query: unlinkedQuery(names),
      paths: ["src"],
      taskProfile: "wiring",
    }, makeUnlinkedWorkspace("missing-insertion", names, {
      consumerCallsAdapter: false,
    }));
    const connection = result.wiring?.connections[0];

    expect(result.wiring?.status).toBe("needs-followup");
    expect(result.wiring?.missing).toContain("insertion");
    expect(connection?.insertion_handle).toBeUndefined();
    expect(result.wiring?.edit_frontier).toEqual([]);
    expect(result.execution_contract?.typestate.phase).not.toBe("prepared");
  }, 30000);

  it("does not prepare when an unlinked same-name producer is ambiguous", async () => {
    const names: UnlinkedFixtureNames = {
      project: "signal-flight",
      sourceFile: "signal_source",
      sourceSymbol: "sampleSignal",
      adapterFile: "signal_adapter",
      adapterSymbol: "encodeSignal",
      consumerFile: "packet_sender",
      consumerSymbol: "transmitPacket",
    };
    const result = await buildTaskPack({
      query: unlinkedQuery(names),
      paths: ["src"],
      taskProfile: "wiring",
    }, makeUnlinkedWorkspace("ambiguous-source", names, { sameNameDecoy: true }));

    expect(result.wiring?.status).toBe("needs-followup");
    expect(result.wiring?.missing).toContain("source");
    expect(result.execution_contract?.typestate.phase).not.toBe("prepared");
    expect(result.wiring?.connections[0]?.source).toBeUndefined();
  }, 30000);

  it("ignores query words that occur only in a comment decoy", async () => {
    const names: UnlinkedFixtureNames = {
      project: "signal-flight",
      sourceFile: "signal_source",
      sourceSymbol: "sampleSignal",
      adapterFile: "signal_adapter",
      adapterSymbol: "encodeSignal",
      consumerFile: "packet_sender",
      consumerSymbol: "transmitPacket",
    };
    const query = unlinkedQuery(names);
    const baseline = await buildTaskPack({
      query,
      paths: ["src"],
      taskProfile: "wiring",
    }, makeUnlinkedWorkspace("comment-baseline", names));
    const workspace = makeUnlinkedWorkspace("comment-decoy", names, { commentDecoy: true });
    const response = await callTool("read_file", {
      mode: "task_pack",
      query,
      paths: ["src"],
      taskProfile: "wiring",
      cwd: workspace,
    });
    const result = JSON.parse(response.content[0]!.text) as Record<string, any>;
    // A.5.1: `wiring` and `change_contract` are PLAN_MEMBERS and ride under
    // `plan`, not at the top level, on the projected read.task_pack wire.
    const plan = result["plan"] as Record<string, any> | undefined;
    const connection = plan?.["wiring"]?.connections?.[0];
    const resultSurfaces = result["evidence"] as Array<Record<string, any>>;
    const surfaces = new Map(resultSurfaces.map((surface) => [surface.handle, surface]));
    const reviewPaths = plan?.["wiring"]?.review_frontier
      ?.map((handle: string) => surfaces.get(handle)?.path) ?? [];

    // execution_contract is deleted from the read.task_pack wire (A.5.1); the
    // "ready to act" fact it carried via `phase:"prepared"` is now
    // `decision.kind === "act.edit"` (A.3).
    expect((result["decision"] as { kind?: string } | undefined)?.kind).toBe("act.edit");
    expect(connection?.source?.path).toBe("src/estimator/signal_source.ts");
    expect(connection?.destination?.path).toBe("src/telemetry/packet_sender.ts");
    expect(reviewPaths.some((reviewPath: string | undefined) => reviewPath?.includes("src/decoys/"))).toBe(false);
    expect(plan?.["wiring"]?.review_frontier).not.toContain(connection?.destination?.handle);
    expect(resultSurfaces.some((surface) => surface.path.startsWith("src/decoys/"))).toBe(false);
    expect(plan?.["change_contract"]?.obligations
      ?.map((obligation: Record<string, any>) => `${obligation.kind}:${obligation.action}`)
      .sort()).toEqual(
        baseline.change_contract?.obligations
          .map((obligation) => `${obligation.kind}:${obligation.action}`)
          .sort(),
      );
  }, 30000);

  it("keeps measured JavaScript wiring metamorphs prepared with stable semantic frontiers", async () => {
    interface MeasuredNames {
      project: string;
      sourceSymbol: string;
      adapterSymbol: string;
      consumerSymbol: string;
      bitName: string;
      directories: { source: string; adapter: string; consumer: string };
      files: { source: string; adapter: string; consumer: string };
    }

    const makeMeasuredWorkspace = (tag: string, names: MeasuredNames, commentDecoy = false): string => {
      const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-evidence-measured-${tag}-`)));
      workspaces.push(workspace);
      writeFile(workspace, "package.json", JSON.stringify({ name: names.project, type: "module" }) + "\n");
      writeFile(
        workspace,
        `src/${names.directories.source}/${names.files.source}.js`,
        `export function ${names.sourceSymbol}() {\n  return false;\n}\n`,
      );
      writeFile(
        workspace,
        `src/${names.directories.adapter}/${names.files.adapter}.js`,
        [
          `export function ${names.adapterSymbol}(value) {`,
          `  return { ${names.bitName}: value ? 1 : 0 };`,
          "}",
          "",
        ].join("\n"),
      );
      writeFile(
        workspace,
        `src/${names.directories.consumer}/${names.files.consumer}.js`,
        [
          `import { ${names.sourceSymbol} } from "../${names.directories.source}/${names.files.source}.js";`,
          `import { ${names.adapterSymbol} } from "../${names.directories.adapter}/${names.files.adapter}.js";`,
          `export function ${names.consumerSymbol}() {`,
          `  return ${names.adapterSymbol}(true);`,
          "}",
          "",
        ].join("\n"),
      );
      if (commentDecoy) {
        writeFile(
          workspace,
          "src/archive/notes.js",
          [
            `// Connect ${names.sourceSymbol} to outbound status telemetry through ${names.adapterSymbol} inside ${names.consumerSymbol}.`,
            `// A false estimator health must clear ${names.bitName}; this file is only historical prose.`,
            'export const historicalNote = "no runtime connection";',
            "",
          ].join("\n"),
        );
      }
      return workspace;
    };

    const original: MeasuredNames = {
      project: "telemetry-link",
      sourceSymbol: "readEstimatorHealth",
      adapterSymbol: "encodeStatus",
      consumerSymbol: "transmitStatus",
      bitName: "healthBit",
      directories: { source: "estimator", adapter: "protocol", consumer: "telemetry" },
      files: { source: "health-source", adapter: "status-adapter", consumer: "status-transmitter" },
    };
    const renamed: MeasuredNames = {
      project: "uplink-guard",
      sourceSymbol: "pollGuardFlag",
      adapterSymbol: "mapGuardFlag",
      consumerSymbol: "publishFrame",
      bitName: "guardBit",
      directories: { source: "sensor", adapter: "format", consumer: "uplink" },
      files: { source: "flag-poller", adapter: "frame-encoder", consumer: "frame-publisher" },
    };
    const neutral: MeasuredNames = {
      ...original,
      project: "neutral-layout",
      directories: { source: "a", adapter: "b", consumer: "c" },
      files: { source: "source", adapter: "adapter", consumer: "consumer" },
    };
    const originalQuery = "Connect readEstimatorHealth to outbound status telemetry: replace the hard-coded healthy value passed through encodeStatus inside transmitStatus so a false estimator health clears healthBit.";
    const cases = [
      { name: "original", names: original, query: originalQuery, commentDecoy: false },
      {
        name: "rename",
        names: renamed,
        query: "Wire pollGuardFlag into publishFrame: replace the constant passed to mapGuardFlag so a false polled flag produces guardBit 0.",
        commentDecoy: false,
      },
      { name: "neutral", names: neutral, query: originalQuery, commentDecoy: false },
      { name: "comment", names: original, query: originalQuery, commentDecoy: true },
    ];

    const results: Record<string, Awaited<ReturnType<typeof buildTaskPack>>> = {};
    for (const testCase of cases) {
      results[testCase.name] = await buildTaskPack({
        query: testCase.query,
        paths: ["src"],
        taskProfile: "wiring",
      }, makeMeasuredWorkspace(testCase.name, testCase.names, testCase.commentDecoy));
    }
    const baselineActions = results["original"]!.change_contract?.obligations
      .map((obligation) => `${obligation.kind}:${obligation.action}`)
      .sort();

    for (const testCase of cases) {
      const result = results[testCase.name]!;
      const connection = result.wiring?.connections[0];
      const surfaces = new Map(result.surfaces.map((surface) => [surface.handle, surface]));
      const reviewPaths = result.wiring?.review_frontier
        .map((handle) => surfaces.get(handle)?.path)
        .filter((candidate): candidate is string => candidate !== undefined) ?? [];
      const adapterPath = `src/${testCase.names.directories.adapter}/${testCase.names.files.adapter}.js`;

      expect(result.execution_contract?.typestate.phase, testCase.name).toBe("prepared");
      expect(result.route).toMatchObject({ action: "edit_from_handles", max_additional_tl_calls: 0 });
      expect(result.next).toBeUndefined();
      expect(result.continuation).toBeUndefined();
      expect(connection?.source?.path).toBe(
        `src/${testCase.names.directories.source}/${testCase.names.files.source}.js`,
      );
      expect(connection?.destination?.path).toBe(
        `src/${testCase.names.directories.consumer}/${testCase.names.files.consumer}.js`,
      );
      expect(connection?.insertion_handle).toBe(connection?.destination?.handle);
      expect(result.wiring?.edit_frontier).toEqual([connection?.destination?.handle]);
      expect(reviewPaths.filter((candidate) => candidate === adapterPath)).toHaveLength(1);
      expect(result.surfaces.filter((surface) => surface.path === adapterPath)).toHaveLength(1);
      const obligationActions = result.change_contract?.obligations
        .map((obligation) => `${obligation.kind}:${obligation.action}`)
        .sort();
      expect({ case: testCase.name, obligationActions }).toEqual({
        case: testCase.name,
        obligationActions: baselineActions,
      });
    }
    expect(results["comment"]!.surfaces.some((surface) => surface.path === "src/archive/notes.js")).toBe(false);
  }, 30000);
});
