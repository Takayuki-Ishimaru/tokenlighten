/**
 * editItemAddressSchema.spec.ts -- 2026-10-22 (codex-copilot-proxy cohorts
 * r16/r17, tasks T07 and T09).
 *
 * Every tl_edit_file `edits[]` item names its own file: dispatch refuses an
 * item that carries neither `path` nor `handle` (the batch pre-pass
 * `edits-item-missing-target`, and the act.edit fence's address correction).
 * The one exception is a lone `intent.kind:"rename"` item, a workspace-wide
 * rename that dispatch applies with no address (renameSymbol's `path` is
 * optional). The advertised per-item `oneOf`, however, listed
 * `{required:["search","replace"]}` as a complete branch, and 4 of the 8 Codex
 * edit trials sent exactly that first and paid 1-4 refusals each. server.ts
 * CANONICAL_EDIT_ITEM now carries an item-level
 * `anyOf:[{required:["path"]},{required:["handle"]},{required:["intent"]}]`, a
 * SIBLING of the `oneOf` (never a `oneOf`: an item may carry both,
 * `allowPathFallback`; never inside a branch: Codex lowers a branch that
 * carries its own `anyOf` to a type-less node), and the portable description
 * says "Each item: its own path ...".
 *
 * This file pins, against the ADVERTISED schemas (what each host receives from
 * `tools/list`, under the validators the hosts use):
 *   1. the keyword's exact shape and placement on every surface that keeps the
 *      item schema, and its absence on the VS Code / Copilot CLI minimal
 *      surfaces, which stay byte-identical;
 *   2. the eight address-less search/replace calls of r16/r17, VERBATIM, are
 *      invalid at `/edits/<i>` with keyword `anyOf` (Copilot Chat's Ajv
 *      settings, and the repo's Ajv 2020 conformance gate);
 *   3. every accepted item form and call rider is still valid, including an
 *      item carrying both `path` and `handle` and the address-less rename;
 *   4. the change adds no type-less composition node for Codex's schema
 *      lowering (codex-rs/tools/src/json_schema.rs `sanitize_json_schema`);
 *   5. the server's own validation and refusals are untouched: the request-shape
 *      validators never evaluate `required`/`anyOf`, and dispatch still answers
 *      an address-less call with its own `edits-item-missing-target` (never an
 *      earlier `invalid-input`);
 *   6. against a spawned server: the address-less rename the schema admits is
 *      applied, and the other intent kinds the schema also admits are answered
 *      `intent-requires-handle` by dispatch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { advertisedTools, callTool, dispatchPropertiesForTest, resetCapturedClientIdForTest } from "../server.js";
import { findInvalidValues, requestShapeRefusal } from "../validation/requestShape.js";
import { killServerGroup } from "./helpers/killServerGroup.js";
import { pooledSpawn } from "./helpers/serverPool.js";
import { TSX_NODE_ARGS } from "./helpers/tsxNode.js";

type Tool = { name: string; description: string; inputSchema: Record<string, any> };

const ENV_KEYS = ["TL_PORTABLE_TOOLS", "TL_LEAN_SCHEMA", "TL_TURN_ECONOMY", "TL_LEAN_CALLS", "TL_MINIMAL_TOOLS"] as const;
type SurfaceEnv = Readonly<Record<(typeof ENV_KEYS)[number], string | undefined>>;
const HOST_DEFAULTS: SurfaceEnv = {
  TL_PORTABLE_TOOLS: undefined, TL_LEAN_SCHEMA: undefined, TL_TURN_ECONOMY: undefined, TL_LEAN_CALLS: undefined, TL_MINIMAL_TOOLS: undefined,
};

interface Surface {
  label: string;
  client: string | undefined;
  env: SurfaceEnv;
  /** Copilot Chat's draft-07 Ajv can compile the surface (the un-leaned TL_LEAN_SCHEMA=0 schema carries `dependentRequired`, which it refuses). */
  copilotAjv: boolean;
}

/** Every surface that keeps the per-item schema, and therefore the new keyword. */
const SURFACES_WITH_KEYWORD: readonly Surface[] = [
  { label: "portable: Codex CLI (codex-mcp-client), the host default", client: "codex-mcp-client", env: HOST_DEFAULTS, copilotAjv: true },
  { label: "portable: Claude Code, the host default", client: "claude-code", env: HOST_DEFAULTS, copilotAjv: true },
  { label: "portable: Copilot CLI, the host default", client: "copilot-cli", env: HOST_DEFAULTS, copilotAjv: true },
  { label: "default lean schema, unknown client", client: undefined, env: { ...HOST_DEFAULTS, TL_PORTABLE_TOOLS: "0" }, copilotAjv: true },
  { label: "full schema (TL_LEAN_SCHEMA=0), unknown client", client: undefined, env: { ...HOST_DEFAULTS, TL_PORTABLE_TOOLS: "0", TL_LEAN_SCHEMA: "0" }, copilotAjv: false },
  { label: "Copilot CLI with TL_PORTABLE_TOOLS=0", client: "copilot-cli", env: { ...HOST_DEFAULTS, TL_PORTABLE_TOOLS: "0" }, copilotAjv: true },
  { label: "VS Code without TL_TURN_ECONOMY", client: "Visual Studio Code", env: { ...HOST_DEFAULTS, TL_PORTABLE_TOOLS: "0" }, copilotAjv: true },
];
const PORTABLE: Surface = SURFACES_WITH_KEYWORD[0]!;

/**
 * The VS Code / Copilot CLI minimal surfaces cut the item `oneOf` since the
 * Copilot retest r4 and cut the new `anyOf` with it. "Byte-identical" is
 * pinned by length and sha256 of `JSON.stringify(tools/list)` as measured on
 * the built server BEFORE the keyword was added (2026-10-22), updated for
 * B9's explicit object types (2026-10-28): +64 / +256 / +64 bytes. Re-pin these
 * together with leanSchemaAllClients.spec.ts's byte sizes on an intentional
 * change to those surfaces, never to absorb the keyword.
 */
const LEAN_SURFACES: ReadonlyArray<Surface & { bytes: number; sha256: string }> = [
  {
    label: "VS Code + TL_TURN_ECONOMY=1 (minimal tier)", client: "Visual Studio Code", copilotAjv: true,
    env: { ...HOST_DEFAULTS, TL_PORTABLE_TOOLS: "0", TL_TURN_ECONOMY: "1" },
    bytes: 2706, sha256: "a9b675858b7c10695fae3f5f29e0a87cb2f06ea13bac70c2f332eac8b1eff8e7",
  },
  {
    label: "VS Code + TL_TURN_ECONOMY=1, TL_MINIMAL_TOOLS=0 (r4 tier)", client: "Visual Studio Code", copilotAjv: true,
    env: { ...HOST_DEFAULTS, TL_PORTABLE_TOOLS: "0", TL_TURN_ECONOMY: "1", TL_MINIMAL_TOOLS: "0" },
    bytes: 6374, sha256: "82fdd6590b9f681082a6429834f57a4f19a925c8fd541681a4112ef6c3105681",
  },
  {
    label: "Copilot CLI minimal (TL_LEAN_CALLS=1, TL_MINIMAL_TOOLS=1)", client: "copilot-cli", copilotAjv: true,
    env: { ...HOST_DEFAULTS, TL_PORTABLE_TOOLS: "0", TL_LEAN_CALLS: "1", TL_MINIMAL_TOOLS: "1" },
    bytes: 2398, sha256: "4483608265d58729f99410c48858ca318c889f6fc89ad24649c983679486c535",
  },
];

function advertise(surface: Pick<Surface, "client" | "env">): Tool[] {
  for (const key of ENV_KEYS) vi.stubEnv(key, surface.env[key]);
  try {
    return structuredClone(advertisedTools(surface.client, "/workspace")) as unknown as Tool[];
  } finally {
    vi.unstubAllEnvs();
  }
}
const editTool = (tools: readonly Tool[]): Tool => tools.find((tool) => tool.name === "tl_edit_file")!;
const itemSchema = (tools: readonly Tool[]): Record<string, any> => editTool(tools).inputSchema["properties"]["edits"]["items"];

afterEach(() => {
  vi.unstubAllEnvs();
  resetCapturedClientIdForTest();
});

/** The two validators the repo's specs use for host acceptance (portableAdvertisement.spec.ts), plus an all-errors variant for exact error listings. */
const COPILOT_CHAT_AJV = (allErrors: boolean) => new Ajv({ coerceTypes: true, allErrors, logger: false });
const AJV_2020 = (allErrors: boolean) => new Ajv2020({ strict: false, allErrors, logger: false });
function validatorsFor(surface: Surface, allErrors: boolean): Array<{ label: string; validate: ValidateFunction }> {
  const schema = editTool(advertise(surface)).inputSchema as AnySchema;
  return [
    ...(surface.copilotAjv ? [{ label: "Copilot Chat Ajv (draft-07, coerceTypes)", validate: COPILOT_CHAT_AJV(allErrors).compile(structuredClone(schema)) }] : []),
    { label: "Ajv 2020 (strict:false)", validate: AJV_2020(allErrors).compile(structuredClone(schema)) },
  ];
}
const anyOfPaths = (errors: ErrorObject[] | null | undefined): string[] =>
  (errors ?? []).filter((error) => error.keyword === "anyOf").map((error) => error.instancePath);

// ---------------------------------------------------------------------------
// The eight address-less tl_edit_file calls of the codex-copilot-proxy r16/r17
// cohorts (evidence-remediation-r16 / -r17, `*-tl-*.events.jsonl`, the
// `mcp_tool_call` `arguments`), VERBATIM. Four of the eight Codex edit trials
// (r16 T07 tl-0, T07 tl-1, T09 tl-0; r17 T07 tl-1) sent one of them first; the
// server refused each at dispatch (execution-typestate / edits-item-missing-target),
// and only the trials that then put a `path` on every item were applied.
// ---------------------------------------------------------------------------
const R16_T07_TL0_EDITS_SEARCH_OBJECT = [
  {
    "search": {
      "path": "pkg/balance/compute.go",
      "search": "\t// posting.Side(DebitSide) is the universal sign convention used for Apply\n\t// regardless of the account's NormalSide — Apply itself flips internally.\n\tnormalSide := posting.Side(account.DebitNormal)"
    },
    "replace": "\t// Net is positive in the account type's normal direction.\n\tnormalSide := posting.Side(acct.Type.NormalSide())"
  },
  {
    "search": {
      "path": "pkg/balance/compute.go",
      "search": "\tb.Net, err = b.Debit.Sub(b.Credit)"
    },
    "replace": "\tif normalSide == posting.DebitSide {\n\t\tb.Net, err = b.Debit.Sub(b.Credit)\n\t} else {\n\t\tb.Net, err = b.Credit.Sub(b.Debit)\n\t}"
  }
];
const R16_T07_TL0_EDITS = [
  {
    "search": "\t// posting.Side(DebitSide) is the universal sign convention used for Apply\n\t// regardless of the account's NormalSide — Apply itself flips internally.\n\tnormalSide := posting.Side(account.DebitNormal)",
    "replace": "\t// Net is positive in the account type's normal direction.\n\tnormalSide := posting.Side(acct.Type.NormalSide())"
  },
  {
    "search": "\tb.Net, err = b.Debit.Sub(b.Credit)",
    "replace": "\tif normalSide == posting.DebitSide {\n\t\tb.Net, err = b.Debit.Sub(b.Credit)\n\t} else {\n\t\tb.Net, err = b.Credit.Sub(b.Debit)\n\t}"
  }
];
const R16_T07_TL1_EDITS = [
  {
    "search": "\t// posting.Side(DebitSide) is the universal sign convention used for Apply\n\t// regardless of the account's NormalSide — Apply itself flips internally.\n\tnormalSide := posting.Side(account.DebitNormal)\n",
    "replace": "\t// Account type determines which posting side increases its balance.\n\tnormalSide := posting.Side(acct.Type.NormalSide())\n"
  },
  {
    "search": "\tvar err error\n\tb.Net, err = b.Debit.Sub(b.Credit)\n\tif err != nil {\n\t\treturn Balance{}, fmt.Errorf(\"compute net for account %s: %w\", acct.ID, err)\n\t}\n\n",
    "replace": ""
  }
];
const R16_T09_TL0_EDITS = [
  {
    "search": "  HIGH: 'HIGH',\n  URGENT: 'URGENT',",
    "replace": "  HIGH: 'HIGH',\n  URGENT: 'URGENT',\n  CRITICAL: 'CRITICAL',"
  },
  {
    "search": "  [IssuePriority.URGENT]: { label: 'Urgent', icon: '⚡', className: 'badge--priority-urgent' },",
    "replace": "  [IssuePriority.URGENT]: { label: 'Urgent', icon: '⚡', className: 'badge--priority-urgent' },\n  [IssuePriority.CRITICAL]: { label: 'Critical', icon: '‼', className: 'badge--priority-critical' },"
  },
  {
    "search": "      URGENT: 0,",
    "replace": "      URGENT: 0,\n      CRITICAL: 0,"
  },
  {
    "search": "  --color-priority-urgent: var(--color-red-500);",
    "replace": "  --color-priority-urgent: var(--color-red-500);\n  --color-priority-critical: #7f1d1d;"
  }
];
const R17_T07_TL1_EDITS = [
  {
    "search": "\t// posting.Side(DebitSide) is the universal sign convention used for Apply\n\t// regardless of the account's NormalSide — Apply itself flips internally.\n\tnormalSide := posting.Side(account.DebitNormal)",
    "replace": "\t// Apply uses the account type's normal side to determine Net's sign.\n\tnormalSide := posting.Side(acct.Type.NormalSide())"
  }
];

const LOGGED_ADDRESSLESS_CALLS: ReadonlyArray<{ id: string; args: Record<string, unknown>; badItems: number[]; searchIsObject?: true }> = [
  {
    id: "r16 T07 tl-0 item_4 (search is {path, search})",
    badItems: [0, 1],
    searchIsObject: true,
    args: { cwd: "/private/tmp/tl-codex-copilot-remediation-r16-20261022/T07/tl-0/ws", task: {"handle":"tlh_s1_3HCqEWsGZj-s_-FKT-z22PHn-OWvTEMdwHw"}, edits: R16_T07_TL0_EDITS_SEARCH_OBJECT },
  },
  {
    id: "r16 T07 tl-0 item_5",
    badItems: [0, 1],
    args: { cwd: "/private/tmp/tl-codex-copilot-remediation-r16-20261022/T07/tl-0/ws", task: {"handle":"tlh_s1_3HCqEWsGZj-s_-FKT-z22PHn-OWvTEMdwHw"}, edits: R16_T07_TL0_EDITS },
  },
  {
    id: "r16 T07 tl-0 item_7 (+ task.challenge)",
    badItems: [0, 1],
    args: { cwd: "/private/tmp/tl-codex-copilot-remediation-r16-20261022/T07/tl-0/ws", task: {"handle":"tlh_s1_3HCqEWsGZj-s_-FKT-z22PHn-OWvTEMdwHw","challenge":{"certificate_id":"ready-e16684159ba40302-33c60140fcb9bf6f","decision":"act.edit","target":"pkg/balance/compute.go","reason":"Implement account-type-normal Net calculation; existing evidence gives both required code sites."}}, edits: R16_T07_TL0_EDITS },
  },
  {
    id: "r16 T07 tl-0 item_8 (+ task.challenge)",
    badItems: [0, 1],
    args: { cwd: "/private/tmp/tl-codex-copilot-remediation-r16-20261022/T07/tl-0/ws", task: {"handle":"tlh_s1_3HCqEWsGZj-s_-FKT-z22PHn-OWvTEMdwHw","challenge":{"certificate_id":"ready-e16684159ba40302-33c60140fcb9bf6f","expected_action_change":"act.edit"}}, edits: R16_T07_TL0_EDITS },
  },
  {
    id: "r16 T07 tl-1 item_3",
    badItems: [0, 1],
    args: { cwd: "/private/tmp/tl-codex-copilot-remediation-r16-20261022/T07/tl-1/ws", task: {"handle":"tlh_s1_AWYhY-beHrxw_l_LCBQ9ntYX9PGBEPWapyA"}, edits: R16_T07_TL1_EDITS },
  },
  {
    id: "r16 T09 tl-0 item_4 (four items)",
    badItems: [0, 1, 2, 3],
    args: { cwd: "/private/tmp/tl-codex-copilot-remediation-r16-20261022/T09/tl-0/ws", task: {"handle":"tlh_s1_6akjKfO43q_7_8H9NEjyOEWuU_udbpvqiNQ"}, edits: R16_T09_TL0_EDITS },
  },
  {
    id: "r16 T09 tl-0 item_5 (+ task.challenge)",
    badItems: [0, 1, 2, 3],
    args: { cwd: "/private/tmp/tl-codex-copilot-remediation-r16-20261022/T09/tl-0/ws", task: {"handle":"tlh_s1_6akjKfO43q_7_8H9NEjyOEWuU_udbpvqiNQ","challenge":{"certificate_id":"ready-1fc3c2323abd7d86-f1ab2774b7c1591b"}}, edits: R16_T09_TL0_EDITS },
  },
  {
    id: "r17 T07 tl-1 item_3 (one item)",
    badItems: [0],
    args: { cwd: "/private/tmp/tl-codex-copilot-remediation-r17-20261022/T07/tl-1/ws", task: {"handle":"tlh_s1_vi5qLAKAAdU3_c3vOH-_Iq_ZsSVI_adpGmg"}, edits: R17_T07_TL1_EDITS },
  },
];

/** Address-less shapes that were never logged but that the item-level keyword must cover too (a keyword inside the search/replace branch would miss every one of them). */
const CONSTRUCTED_ADDRESSLESS_CALLS: ReadonlyArray<{ id: string; args: Record<string, unknown>; badItems: number[] }> = [
  { id: "mixed batch: the second item has no address", badItems: [1], args: { cwd: "/w", edits: [{ path: "a.go", search: "a", replace: "b" }, { search: "c", replace: "d" }] } },
  { id: "search/replace + precondition, no address", badItems: [0], args: { cwd: "/w", edits: [{ search: "a", replace: "b", precondition: "unique-match" }] } },
  { id: "range/content, no address", badItems: [0], args: { cwd: "/w", edits: [{ range: "1-2", content: "x\n" }] } },
  { id: "create/content, no address", badItems: [0], args: { cwd: "/w", edits: [{ create: true, content: "x\n" }] } },
  { id: "create/from, no address", badItems: [0], args: { cwd: "/w", edits: [{ create: true, from: "src.ts" }] } },
  { id: "whole-file content, no address", badItems: [0], args: { cwd: "/w", edits: [{ content: "x\n" }] } },
  { id: "search/replace with allowPathFallback only, no address", badItems: [0], args: { cwd: "/w", edits: [{ search: "a", replace: "b", allowPathFallback: false }] } },
];

/** Every accepted item form (capabilityReachability.spec.ts' census, the r16/r17 applied calls) and call rider. All stay valid. */
const CONTROLS: ReadonlyArray<{ id: string; args: Record<string, unknown> }> = [
  { id: "{path, search, replace} (r16 T07 tl-1 item_6, r17 applied calls)", args: { cwd: "/w", edits: [{ path: "pkg/balance/compute.go", search: "a", replace: "b" }, { path: "pkg/balance/compute.go", search: "c", replace: "" }] } },
  { id: "{path, search, replace, precondition} x4 (r16 T09 tl-1 item_4)", args: { cwd: "/w", edits: [1, 2, 3, 4].map((n) => ({ path: `f${n}.ts`, search: `s${n}`, replace: `r${n}`, precondition: "unique-match" })) } },
  { id: "{handle, search, replace}", args: { cwd: "/w", edits: [{ handle: "hjnvum2aeu3", search: "a", replace: "b" }] } },
  { id: "{path, handle, search, replace, allowPathFallback:false} (both addresses)", args: { cwd: "/w", edits: [{ path: "a.ts", handle: "h1", search: "a", replace: "b", allowPathFallback: false }] } },
  { id: "{path, range, content}", args: { cwd: "/w", edits: [{ path: "a.ts", range: "1-2", content: "x\n" }] } },
  { id: "{handle, range, content}", args: { cwd: "/w", edits: [{ handle: "h1", range: "1-2", content: "x\n" }] } },
  { id: "{path, create:true, content}", args: { cwd: "/w", edits: [{ path: "new.ts", create: true, content: "x\n" }] } },
  { id: "{path, create:true, from}", args: { cwd: "/w", edits: [{ path: "new.ts", create: true, from: "src.ts" }] } },
  { id: "intent rename", args: { cwd: "/w", edits: [{ path: "a.ts", intent: { kind: "rename", from: "old", to: "new" } }] } },
  { id: "intent remove-duplicate-branch", args: { cwd: "/w", edits: [{ path: "a.ts", intent: { kind: "remove-duplicate-branch", symbol: "handler" } }] } },
  { id: "intent append-union-member", args: { cwd: "/w", edits: [{ path: "a.ts", intent: { kind: "append-union-member", symbol: "Shape", to: "Circle" } }] } },
  { id: "intent append-enum-member (handle)", args: { cwd: "/w", edits: [{ handle: "h1", intent: { kind: "append-enum-member", symbol: "Color", to: "Blue" } }] } },
  { id: "intent rename-symbol-references", args: { cwd: "/w", edits: [{ path: "a.ts", intent: { kind: "rename-symbol-references", from: "old", to: "new", lang: "ts", includeComments: true } }] } },
  { id: "intent rename with no address: a workspace-wide rename (the third anyOf alternative)", args: { cwd: "/w", edits: [{ intent: { kind: "rename", from: "foo", to: "bar" } }] } },
  { id: "intent append-enum-member with no address: schema-valid, dispatch answers intent-requires-handle", args: { cwd: "/w", edits: [{ intent: { kind: "append-enum-member", symbol: "Color", to: "Blue" } }] } },
  { id: "{handle, content} whole-file", args: { cwd: "/w", edits: [{ handle: "h1", content: "x\n" }] } },
  { id: "{path, content} whole-file", args: { cwd: "/w", edits: [{ path: "a.ts", content: "x\n" }] } },
  { id: "{path, search, replace, target:\"all\"}", args: { cwd: "/w", edits: [{ path: "a.ts", search: "a", replace: "b", target: "all" }] } },
  { id: "multi-item batch, every item addressed (path, handle, create)", args: { cwd: "/w", edits: [{ path: "a.ts", search: "a", replace: "b" }, { handle: "h2", search: "c", replace: "d" }, { path: "n.ts", create: true, content: "" }] } },
  { id: "batch with range+expectedSha and review/target/scopeHandle/directoryHandle fields", args: { cwd: "/w", edits: [{ path: "a.ts", search: "x", replace: "y", precondition: "unique-match" }, { path: "b.ts", range: "1-1", content: "z\n", expectedSha: "sha256:abc" }, { path: "c.ts", search: "x", replace: "y", review: true, target: "all", scopeHandle: "sh1", directoryHandle: "dh1", allowPathFallback: false }] } },
  { id: "operation_id + lane + task.handle riders", args: { cwd: "/w", lane: "a", operation_id: "op", task: { handle: "t" }, edits: [{ handle: "h", search: "o", replace: "n", precondition: "unique-match", allowPathFallback: false }] } },
  { id: "credentials rider", args: { edits: [{ path: "secret.docx", content: "x" }], credentials: { in: "doc-pw", out: "doc-pw-out" } } },
  { id: "artifact alongside an addressed batch", args: { edits: [{ path: "a.ts", search: "x", replace: "y" }], artifact: { kind: "zip", members: [{ action: "delete", member: "old.txt" }] } } },
  { id: "artifact-only call (no edits)", args: { cwd: "/w", artifact: { kind: "zip", members: [{ action: "add", member: "a.txt", content: "hi" }] } } },
  { id: "edits: [] (an empty batch is the dispatcher's business)", args: { cwd: "/w", edits: [] } },
];

describe.each(SURFACES_WITH_KEYWORD)("edits[] item address keyword -- $label", (surface) => {
  it("advertises edits.items.anyOf as [{required:[path]},{required:[handle]},{required:[intent]}], a sibling of the six-branch oneOf and inside no branch", () => {
    const items = itemSchema(advertise(surface));
    expect(items["anyOf"]).toEqual([{ required: ["path"] }, { required: ["handle"] }, { required: ["intent"] }]);
    expect(items["oneOf"]).toHaveLength(6);
    for (const branch of items["oneOf"] as Array<Record<string, unknown>>) expect(branch, JSON.stringify(branch)).not.toHaveProperty("anyOf");
    expect((items["oneOf"] as Array<Record<string, unknown>>)[0]).toEqual({ required: ["search", "replace"] });
  });

  it.each(LOGGED_ADDRESSLESS_CALLS)("refuses the logged call $id at /edits/<i> with keyword anyOf", (call) => {
    for (const { label, validate } of validatorsFor(surface, false)) {
      expect(validate(structuredClone(call.args)), `${label}: ${call.id} must be invalid`).toBe(false);
      // The first failure (Copilot Chat stops there): the first address-less item.
      if (call.searchIsObject !== true) {
        expect(validate.errors!.find((error) => error.keyword === "anyOf")?.instancePath, label).toBe(`/edits/${call.badItems[0]}`);
      }
    }
    for (const { label, validate } of validatorsFor(surface, true)) {
      expect(validate(structuredClone(call.args)), `${label}: ${call.id} must be invalid`).toBe(false);
      const errors = validate.errors!;
      // Every address-less item, exactly once, and nothing outside edits[] is wrong with the call.
      expect(anyOfPaths(errors), label).toEqual(call.badItems.map((index) => `/edits/${index}`));
      expect(errors.filter((error) => !error.instancePath.startsWith("/edits/")), label).toEqual([]);
      const addressErrors = errors.filter((error) => error.keyword === "required" || error.keyword === "anyOf");
      expect(addressErrors.every((error) => /^\/edits\/\d+$/.test(error.instancePath)), label).toBe(true);
      const typeErrors = errors.filter((error) => error.keyword === "type").map((error) => error.instancePath);
      // r16 T07 tl-0 item_4 put {path, search} in `search`: that type error stays, beside the address one.
      expect(typeErrors, label).toEqual(call.searchIsObject === true ? call.badItems.map((index) => `/edits/${index}/search`) : []);
    }
  });

  it.each(CONSTRUCTED_ADDRESSLESS_CALLS)("refuses the constructed shape $id at its address-less item(s) with keyword anyOf", (call) => {
    for (const { label, validate } of validatorsFor(surface, true)) {
      expect(validate(structuredClone(call.args)), `${label}: ${call.id} must be invalid`).toBe(false);
      expect(anyOfPaths(validate.errors), label).toEqual(call.badItems.map((index) => `/edits/${index}`));
    }
  });

  it("accepts every control: each accepted item form, an item carrying both path and handle, artifact-only, an empty batch and the call riders", () => {
    for (const { label, validate } of validatorsFor(surface, true)) {
      for (const control of CONTROLS) {
        expect(validate(structuredClone(control.args)), `${label}: ${control.id}: ${JSON.stringify(validate.errors)}`).toBe(true);
      }
    }
  });
});

describe("what Copilot Chat tells the model for the r17 one-item call (Ajv errorsText)", () => {
  it("names the missing path, handle and intent and the anyOf, at edits/0", () => {
    const ajv = COPILOT_CHAT_AJV(false);
    const validate = ajv.compile(structuredClone(editTool(advertise(PORTABLE)).inputSchema) as AnySchema);
    const call = LOGGED_ADDRESSLESS_CALLS.find((entry) => entry.id.startsWith("r17"))!;
    expect(validate(structuredClone(call.args))).toBe(false);
    const text = ajv.errorsText(validate.errors);
    expect(text).toContain("data/edits/0 must have required property 'path'");
    expect(text).toContain("data/edits/0 must have required property 'handle'");
    expect(text).toContain("data/edits/0 must have required property 'intent'");
    expect(text).toContain("data/edits/0 must match a schema in anyOf");
  });
});

describe.each(LEAN_SURFACES)("the VS Code and Copilot CLI surfaces retain their address-keyword policy -- $label", (surface) => {
  it.each([undefined, "0"])("carries neither edits.items.anyOf nor edits.items.oneOf, with B9 object declarations pinned (TL_LEAN_SCHEMA=%s)", (leanSchema) => {
    const tools = advertise({ client: surface.client, env: { ...surface.env, TL_LEAN_SCHEMA: leanSchema } });
    const items = itemSchema(tools);
    expect(items).not.toHaveProperty("anyOf");
    expect(items).not.toHaveProperty("oneOf");
    expect(JSON.stringify(editTool(tools))).not.toMatch(/"(?:anyOf|oneOf)"/);
    expect(Buffer.byteLength(JSON.stringify(tools), "utf8"), `${surface.label} bytes`).toBe(surface.bytes);
    const digest = createHash("sha256").update(JSON.stringify(tools)).digest("hex");
    expect(digest, `${surface.label} sha256 ${digest}`).toBe(surface.sha256);
  });

  it("still validates every control (these surfaces carry no address keyword; dispatch, not the schema, refuses an address-less item)", () => {
    const schema = editTool(advertise(surface)).inputSchema as AnySchema;
    const validate = COPILOT_CHAT_AJV(true).compile(structuredClone(schema));
    for (const control of CONTROLS) expect(validate(structuredClone(control.args)), `${control.id}: ${JSON.stringify(validate.errors)}`).toBe(true);
  });
});

/**
 * Codex lowers every MCP tool schema before it reaches the model
 * (codex-rs/tools/src/json_schema.rs `sanitize_json_schema`, rust-v0.159.1):
 * it recurses into `properties`, `items`, `prefixItems`, `anyOf`/`oneOf`/`allOf`
 * and `$defs`, drops `not`, and a node with no `type` that carries `$ref` or a
 * composition keyword is returned as it is, STILL type-less (a node with
 * `required` alone becomes `{type:"object", properties:{}}`). A design that put
 * the `anyOf` inside the search/replace `oneOf` branch would add exactly such a
 * node; the item-level keyword must not.
 */
function codexTypelessCompositionNodes(node: unknown, at: string, found: string[] = []): string[] {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return found;
  const record = node as Record<string, unknown>;
  const properties = record["properties"];
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [name, child] of Object.entries(properties)) codexTypelessCompositionNodes(child, `${at}.properties.${name}`, found);
  }
  codexTypelessCompositionNodes(record["items"], `${at}.items`, found);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = record[key];
    if (Array.isArray(branches)) branches.forEach((branch, index) => codexTypelessCompositionNodes(branch, `${at}.${key}[${index}]`, found));
  }
  if (record["type"] === undefined && (record["$ref"] !== undefined || ["anyOf", "oneOf", "allOf"].some((key) => record[key] !== undefined))) found.push(at);
  return found;
}

describe("Codex schema lowering of the portable tl_edit_file", () => {
  it("self-check: the walker reports a branch that carries its own anyOf (the rejected, branch-nested design)", () => {
    const branchNested = { type: "object", properties: { edits: { type: "array", items: {
      type: "object",
      oneOf: [{ required: ["search", "replace"], anyOf: [{ required: ["path"] }, { required: ["handle"] }] }],
    } } } };
    expect(codexTypelessCompositionNodes(branchNested, "root")).toEqual(["root.properties.edits.items.oneOf[0]"]);
  });

  it("adds no type-less composition node: the item explicitly declares object and Codex types the bare required children", () => {
    const tool = editTool(advertise(PORTABLE));
    expect(codexTypelessCompositionNodes(tool.inputSchema, "inputSchema")).toEqual([]);
    const items = itemSchema([tool]);
    expect(items["type"]).toBe("object");
    expect(items["anyOf"]).toEqual([{ required: ["path"] }, { required: ["handle"] }, { required: ["intent"] }]);
    for (const child of items["anyOf"] as Array<Record<string, unknown>>) expect(Object.keys(child)).toEqual(["required"]);
  });
});

describe("the portable tl_edit_file description", () => {
  it("says each item carries its own path (or a served handle whose window covers search), keeping the multiple-windows rule", () => {
    const description = editTool(advertise(PORTABLE)).description;
    expect(description).toContain('Each item: its own path (or served handle whose window covers search; multiple windows: prefer path) + search/replace + precondition:"unique-match".');
    expect(description).toContain("multiple windows: prefer path");
    expect(description).toContain("New: path,create:true,content.");
    expect(description).not.toContain("Use served path/search/replace");
  });
});

describe("the server-side validation and refusals are unchanged by the advertisement", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  const workspace = (): string => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-edit-address-")));
    roots.push(root);
    fs.writeFileSync(path.join(root, "a.ts"), "export function foo() { return 1; }\n");
    return root;
  };

  it("requestShape's name and value validators never evaluate required/oneOf/anyOf: an address-less item passes both, in the dispatch view and the advertised view", () => {
    const advertised = editTool(advertise({ client: undefined, env: { ...HOST_DEFAULTS, TL_PORTABLE_TOOLS: "0" } })).inputSchema["properties"];
    for (const [view, properties] of [["dispatch", dispatchPropertiesForTest("tl_edit_file")], ["advertised", advertised]] as const) {
      for (const call of LOGGED_ADDRESSLESS_CALLS.filter((entry) => entry.searchIsObject !== true)) {
        // `task` is left out: the challenge payloads of the logged calls are the dispatcher's business, not the address's.
        const args = { cwd: call.args["cwd"], edits: call.args["edits"] };
        expect(requestShapeRefusal("tl_edit_file", properties, args), `${view}: ${call.id}`).toBeNull();
        expect(findInvalidValues("tl_edit_file", properties, args), `${view}: ${call.id}`).toEqual([]);
      }
    }
  });

  it("dispatch still answers an address-less batch with its own edits-item-missing-target (no earlier invalid-input) and the object-form search with the path hint", async () => {
    const root = workspace();
    const missing = parse(await callTool("tl_edit_file", { cwd: root, edits: structuredClone(R16_T07_TL0_EDITS) }));
    expect(missing).toMatchObject({ kind: "refusal", for: "tl_edit_file", code: "edits-item-missing-target", failed_items: [{ index: 0 }, { index: 1 }], retry: "call" });
    expect(missing["code"]).not.toBe("invalid-input");
    const objectForm = parse(await callTool("tl_edit_file", { cwd: root, edits: structuredClone(R16_T07_TL0_EDITS_SEARCH_OBJECT) }));
    expect(objectForm).toMatchObject({ kind: "refusal", code: "invalid-input", field: "edits[0].search" });
    expect(String(objectForm["detail"])).toContain("path goes beside search as its own field: edits:[{path, search, replace}]");
  });
});

describe("the address-less intent items the schema admits (spawned server, --allow-write)", () => {
  type Body = Record<string, any>;
  const roots: string[] = [];
  const stops: Array<() => void> = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  const bin = fileURLToPath(new URL("../bin.ts", import.meta.url));

  /** One server over `root` in the production-default environment; `call` adds `cwd`. */
  async function connect(root: string): Promise<(name: string, args: Body) => Promise<Body>> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith("TL_") && !key.startsWith("TOKENLIGHTEN_")));
    const child = pooledSpawn(process.execPath, [...TSX_NODE_ARGS, bin, root, "--allow-write"], {
      cwd: root,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    stops.push(() => killServerGroup(child));
    let buffer = "";
    let stderr = "";
    let sequence = 0;
    const waiters = new Map<number, (body: Body) => void>();
    child.stdout!.on("data", (data: Buffer) => {
      buffer += data.toString();
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: Body;
        try { message = JSON.parse(line); } catch { continue; }
        const done = waiters.get(message["id"]);
        if (done) { waiters.delete(message["id"]); done(message); }
      }
    });
    child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
    const rpc = (method: string, params: Body): Promise<Body> => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`${method} timed out\n${stderr}`)); }, 20000);
      waiters.set(id, (body) => { clearTimeout(timer); resolve(body); });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "0" } });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return async (name, args) => {
      const response = await rpc("tools/call", { name, arguments: { cwd: root, ...args } });
      return JSON.parse(response["result"].content[0].text) as Body;
    };
  }

  it("a lone rename item with no path or handle is schema-valid on every surface and applied workspace-wide; the other four intent kinds are schema-valid too and answered intent-requires-handle", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-edit-address-")));
    roots.push(root);
    const files: Record<string, string> = {
      "src/a.ts": "export enum Color { Red }\nexport function foo() { return 1; }\n",
      "src/b.ts": 'import { foo } from "./a";\nexport const y = foo();\n',
    };
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    const rename = { kind: "rename", from: "foo", to: "bar" };
    const others = [
      { kind: "append-enum-member", symbol: "Color", to: "Blue" },
      { kind: "remove-duplicate-branch", symbol: "foo" },
      { kind: "append-union-member", symbol: "Shape", to: "Circle" },
      { kind: "rename-symbol-references", from: "foo", to: "bar" },
    ];
    // The advertised schema admits all five address-less intent items, on every surface that carries the keyword ...
    for (const surface of SURFACES_WITH_KEYWORD) {
      for (const { label, validate } of validatorsFor(surface, true)) {
        for (const intent of [rename, ...others]) {
          expect(validate({ cwd: root, edits: [{ intent }] }), `${surface.label}: ${label}: ${intent.kind}: ${JSON.stringify(validate.errors)}`).toBe(true);
        }
      }
    }
    // ... and dispatch answers each kind that needs a handle with its own refusal, writing nothing ...
    const call = await connect(root);
    for (const intent of others) {
      const refused = await call("tl_edit_file", { edits: [{ intent }] });
      expect(refused, `${intent.kind}: ${JSON.stringify(refused)}`).toMatchObject({ kind: "refusal", code: "intent-requires-handle" });
    }
    for (const [rel, text] of Object.entries(files)) expect(fs.readFileSync(path.join(root, rel), "utf8"), rel).toBe(text);
    // ... while the rename needs no address at all: it is applied across the workspace.
    const applied = await call("tl_edit_file", { edits: [{ intent: rename }] });
    expect(applied["kind"], JSON.stringify(applied).slice(0, 500)).toBe("edit.applied");
    expect(fs.readFileSync(path.join(root, "src/a.ts"), "utf8")).toBe("export enum Color { Red }\nexport function bar() { return 1; }\n");
    expect(fs.readFileSync(path.join(root, "src/b.ts"), "utf8")).toBe('import { bar } from "./a";\nexport const y = bar();\n');
  }, 120000);
});
