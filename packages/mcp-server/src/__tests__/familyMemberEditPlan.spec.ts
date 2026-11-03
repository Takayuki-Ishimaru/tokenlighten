/**
 * familyMemberEditPlan.spec.ts — the edit plan for "add a new member of an
 * existing identifier family" (2026-11-02; external evaluation of v0.16.4,
 * T2 against a flask clone: "add a SESSION_COOKIE_SALT config key").
 *
 * Before: the first reply served the Sphinx `docs/conf.py` (EN; the request
 * was bound `artifact_build` because "document it in docs/config.rst" matched
 * the artifact reference `document`, and the pack fell back to the inferred
 * `docs/` scope) or a three-line test fixture named after the project plus an
 * import block (JA), decided `discover`, and disclosed the key the request
 * asks to ADD as `request-item-absent`. The agent abandoned TL in all three
 * runs and never called tl_edit_file.
 *
 * After: the siblings of the new name say where the change goes. The first
 * reply seeds the family's definition site, its consumer, the page that
 * documents it and a test that exercises a sibling; decides `act.edit` with a
 * writable frontier; and names the new key as the thing to create.
 *
 * Fixture: helpers/familyMemberFixture.ts (written from scratch in the flask
 * layout: a defaults table, a sessions module with the serializer salt, Sphinx
 * conf.py beside docs/config.rst, tests, and a test-app fixture whose FILE
 * NAME is the package name).
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  asCreateIfIntroduced,
  buildTaskPack,
  hasArtifactBuildIntentMarker,
  requestNamesFileByWord,
  surfaceAdmittedByFilenameMatchOnly,
} from "../tools/readCodeTaskPack.js";
import {
  familyMemberCandidates,
  familyMemberSeedPlan,
  requestIntroducesName,
} from "../features/task-pack/familyMemberSeeds.js";
import type { RequestItem } from "../features/task-pack/requestItems.js";
import {
  FAMILY_CONSUMER_PATH,
  FAMILY_DEFINITION_PATH,
  FAMILY_DOC_PATH,
  FAMILY_FIXTURE_FILES,
  FAMILY_PACKAGE,
  FAMILY_REQUEST_EN,
  FAMILY_REQUEST_JA,
  FAMILY_TEST_PATH,
  NAME_ONLY_FIXTURE_PATH,
  NO_FAMILY_REQUEST_JA,
  SPHINX_CONF_PATH,
} from "./helpers/familyMemberFixture.js";
import { makeSmallTaskWorkspace, startSmallTaskServer, type CallResult, type SmallTaskServer } from "./helpers/smallTaskServer.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

const FAMILY_SEED_PATHS = [FAMILY_DEFINITION_PATH, FAMILY_CONSUMER_PATH, FAMILY_DOC_PATH, FAMILY_TEST_PATH];

const workspaces: string[] = [];
function fixtureWorkspace(): string {
  const ws = makeSmallTaskWorkspace("tl-family-", FAMILY_FIXTURE_FILES);
  workspaces.push(ws);
  return ws;
}
afterAll(async () => {
  for (const ws of workspaces.splice(0)) await rmDirWithRetry(ws);
});

interface Surface { readonly path: string; readonly range?: string; readonly why?: string; readonly code?: string; readonly role?: string }
interface Obligation { readonly path: string; readonly action: "edit" | "review"; readonly required: boolean; readonly reason: string }
interface Absence { readonly id: string; readonly term: string; readonly create?: boolean; readonly create_reason?: string }
interface Pack {
  readonly coverage: string;
  readonly surfaces: readonly Surface[];
  readonly route?: { readonly action: string };
  readonly change_contract?: { readonly obligations: readonly Obligation[] };
  readonly request_item_absences?: readonly Absence[];
  readonly advisory?: string;
  readonly execution_contract?: { readonly next_call?: unknown; readonly readiness_certificate?: { readonly action_frontier?: readonly string[]; readonly gaps?: readonly string[] } };
}
const pack = async (query: string, ws: string): Promise<Pack> => (await buildTaskPack({ query } as never, ws)) as unknown as Pack;

// ---------------------------------------------------------------------------
// 1. "document it in …" is a verb, not an artifact reference
// ---------------------------------------------------------------------------

describe("the artifact_build reader and the verb 'document'", () => {
  it("does not bind artifact_build for 'document it in docs/config.rst'", () => {
    expect(hasArtifactBuildIntentMarker(FAMILY_REQUEST_EN)).toBe(false);
    expect(hasArtifactBuildIntentMarker("Add the option and document the change in docs/config.rst.")).toBe(false);
    expect(hasArtifactBuildIntentMarker("Implement it and document how the salt is derived.")).toBe(false);
  });

  it("still binds artifact_build for a document/spreadsheet artifact named as a noun", () => {
    expect(hasArtifactBuildIntentMarker("Update the document with the new totals.")).toBe(true);
    expect(hasArtifactBuildIntentMarker("Add the new rows to the spreadsheet.")).toBe(true);
    expect(hasArtifactBuildIntentMarker("Implement the rules from requirements.docx.")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. the family plan
// ---------------------------------------------------------------------------

describe("familyMemberSeedPlan", () => {
  it("names the member the request adds and skips file names and existing members", () => {
    expect(familyMemberCandidates(FAMILY_REQUEST_EN)).toEqual(["SESSION_COOKIE_SALT"]);
    expect(familyMemberCandidates(FAMILY_REQUEST_JA)).toEqual(["SESSION_COOKIE_SALT"]);
    expect(familyMemberCandidates("Add a test in tests/test_config.py for SESSION_COOKIE_NAME")).toEqual(["SESSION_COOKIE_NAME"]);
    expect(familyMemberCandidates("set MAX_X to 5")).toEqual([]);
  });

  it("reads add/introduce intent in EN and JA from the item's own clause", () => {
    expect(requestIntroducesName("Add a new config key SESSION_COOKIE_SALT that sets the salt", "SESSION_COOKIE_SALT")).toBe(true);
    expect(requestIntroducesName("Introduce SESSION_COOKIE_SALT beside the other keys", "SESSION_COOKIE_SALT")).toBe(true);
    expect(requestIntroducesName(`${FAMILY_PACKAGE} に SESSION_COOKIE_SALT 設定を追加して`, "SESSION_COOKIE_SALT")).toBe(true);
    expect(requestIntroducesName("SESSION_COOKIE_SALT を新しく定義して", "SESSION_COOKIE_SALT")).toBe(true);
    expect(requestIntroducesName("Explain SESSION_COOKIE_SALT", "SESSION_COOKIE_SALT")).toBe(false);
    expect(requestIntroducesName("Add a new key", "SESSION_COOKIE_SALT")).toBe(false);
  });

  it.each([["EN", FAMILY_REQUEST_EN], ["JA", FAMILY_REQUEST_JA]])("%s: seeds the definition site, the consumer, the documentation page and a test", (_label, query) => {
    const ws = fixtureWorkspace();
    const plan = familyMemberSeedPlan(query, ws);
    expect(plan, "a plan").toBeDefined();
    expect(plan!.member).toBe("SESSION_COOKIE_SALT");
    expect(plan!.stem).toBe("SESSION_COOKIE_");
    expect(plan!.definition.path).toBe(FAMILY_DEFINITION_PATH);
    const seedPaths = plan!.seeds.map((seed) => seed.path);
    expect(seedPaths.slice(0, 4)).toEqual(FAMILY_SEED_PATHS);
    expect(new Set(seedPaths)).toEqual(new Set(FAMILY_SEED_PATHS));
    expect(plan!.siblings).toContain("SESSION_COOKIE_NAME");
    expect(plan!.siblings).not.toContain("SESSION_COOKIE_SALT");
    for (const seed of plan!.seeds) {
      expect(seed.range, seed.path).toMatch(/^\d+-\d+$/);
      expect((seed.purpose ?? "").length, seed.purpose).toBeLessThanOrEqual(43);
    }
    // The defaults table (keys) outranks the module that only reads the keys.
    const definitionRange = plan!.seeds[0]!.range!.split("-").map(Number) as [number, number];
    const served = FAMILY_FIXTURE_FILES[FAMILY_DEFINITION_PATH]!.split(String.fromCharCode(10)).slice(definitionRange[0] - 1, definitionRange[1]).join(String.fromCharCode(10));
    expect(served).toContain('"SESSION_COOKIE_NAME": "session"');
    expect(served).toContain('"SESSION_COOKIE_SAMESITE": None');
    // The request's quoted default ('cookie-session') is the serializer salt,
    // sixty lines below the family's readers: it gets a window of its own.
    const consumerLines = FAMILY_FIXTURE_FILES[FAMILY_CONSUMER_PATH]!.split(String.fromCharCode(10));
    const saltLine = consumerLines.findIndex((line) => line.includes('salt = "cookie-session"')) + 1;
    expect(saltLine).toBeGreaterThan(0);
    const coversSalt = plan!.seeds.some((seed) => {
      if (seed.path !== FAMILY_CONSUMER_PATH) return false;
      const [start, end] = seed.range!.split("-").map(Number) as [number, number];
      return saltLine >= start && saltLine <= end;
    });
    expect(coversSalt, JSON.stringify(plan!.seeds)).toBe(_label === "EN");
  });

  it("stays out of every other request shape", () => {
    const ws = fixtureWorkspace();
    expect(familyMemberSeedPlan("Explain SESSION_COOKIE_SALT", ws)).toBeUndefined();
    expect(familyMemberSeedPlan("Add a test for SESSION_COOKIE_NAME", ws), "an existing member").toBeUndefined();
    expect(familyMemberSeedPlan(NO_FAMILY_REQUEST_JA, ws), "no siblings").toBeUndefined();
    expect(familyMemberSeedPlan("Add a MAX_SALT constant", ws), "a stem too short to name a family").toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. the pack: edit-ready from the first reply
// ---------------------------------------------------------------------------

describe("buildTaskPack for a new member of an existing family", () => {
  it.each([["EN", FAMILY_REQUEST_EN], ["JA", FAMILY_REQUEST_JA]])("%s: serves the family's sites with bodies and an edit route", async (_label, query) => {
    const ws = fixtureWorkspace();
    const result = await pack(query, ws);
    const detail = JSON.stringify({ coverage: result.coverage, route: result.route, surfaces: result.surfaces.map((s) => `${s.path}:${s.range} ${s.why ?? ""}`) });
    expect(result.route?.action, detail).toBe("edit_from_handles");
    expect(result.coverage, detail).toBe("complete");
    const paths = result.surfaces.map((surface) => surface.path);
    expect(paths.slice(0, 4), detail).toEqual(FAMILY_SEED_PATHS);
    expect(new Set(paths), detail).toEqual(new Set(FAMILY_SEED_PATHS));
    for (const surface of result.surfaces) {
      expect((surface.code ?? "").length, `${surface.path} body`).toBeGreaterThan(0);
    }
    for (const surface of result.surfaces.slice(0, 4)) {
      expect(surface.why ?? "", surface.path).toContain("SESSION_COOKIE_*");
    }
    // EN quotes the serializer's default: the line that sets it is served too.
    if (_label === "EN") {
      expect(result.surfaces.some((surface) => surface.path === FAMILY_CONSUMER_PATH && (surface.code ?? "").includes('salt = "cookie-session"')), detail).toBe(true);
    }
    expect(result.surfaces.some((surface) => surface.path === SPHINX_CONF_PATH), detail).toBe(false);
    expect(result.surfaces.some((surface) => surface.path === NAME_ONLY_FIXTURE_PATH), detail).toBe(false);

    const definition = result.change_contract?.obligations.find((obligation) => obligation.path === FAMILY_DEFINITION_PATH);
    expect(definition, JSON.stringify(result.change_contract)).toMatchObject({ action: "edit", required: true });
    expect(result.execution_contract?.readiness_certificate?.action_frontier?.length ?? 0, "writable frontier").toBeGreaterThan(0);
    expect(result.execution_contract?.next_call, "no further discovery call").toBeUndefined();
    expect(result.advisory ?? "", "the advisory names the new key and its family").toContain("SESSION_COOKIE_SALT");
    expect(result.advisory ?? "").toContain(FAMILY_DEFINITION_PATH);

    // The key the request adds is never disclosed as missing code.
    for (const absence of result.request_item_absences ?? []) {
      if (absence.term === "SESSION_COOKIE_SALT") expect(absence.create, JSON.stringify(absence)).toBe(true);
    }
    for (const gap of result.execution_contract?.readiness_certificate?.gaps ?? []) {
      expect(gap).not.toContain("request-item-absent:SESSION_COOKIE_SALT");
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// 4. a name the request adds is a create item, not missing code
// ---------------------------------------------------------------------------

describe("asCreateIfIntroduced", () => {
  const item = (text: string): RequestItem => ({ id: "ri-1", text, kind: "topic", terms: [], aliases: [], bindable: true });
  const entry = { id: "ri-1", term: "SESSION_COOKIE_SALT", scope_complete: true, omitted_count: 0 };

  it.each([
    ["EN add", "Add a new config key SESSION_COOKIE_SALT that sets the salt used by the session cookie serializer"],
    ["EN introduce", "introduce SESSION_COOKIE_SALT next to SESSION_COOKIE_NAME"],
    ["EN new", "a new SESSION_COOKIE_SALT key"],
    ["JA 追加", `${FAMILY_PACKAGE} に SESSION_COOKIE_SALT 設定を追加して`],
    ["JA 新しく", "SESSION_COOKIE_SALT を新しく追加して"],
    ["JA 新規", "SESSION_COOKIE_SALT を新規に定義"],
  ])("%s: flags the absence as the thing to create", (_label, text) => {
    const flagged = asCreateIfIntroduced(item(text), entry);
    expect(flagged.create).toBe(true);
    expect(flagged.create_reason).toContain("SESSION_COOKIE_SALT");
    expect(flagged).toMatchObject(entry);
  });

  it.each([
    ["a question", "Explain SESSION_COOKIE_SALT"],
    ["a different name", "Add SESSION_COOKIE_SALT_FALLBACK"],
    ["a fix", "Fix SESSION_COOKIE_SALT handling"],
  ])("%s: leaves a genuine absence alone", (_label, text) => {
    const result = asCreateIfIntroduced(item(text), entry);
    expect(result.create).toBeUndefined();
    expect(result).toEqual(entry);
  });

  it("never discloses the new key as absent when the request is seeded without the family (no siblings)", async () => {
    const ws = fixtureWorkspace();
    const result = await pack(NO_FAMILY_REQUEST_JA, ws);
    for (const absence of result.request_item_absences ?? []) {
      if (absence.term === "COOKIE_SALT_ROUNDS") expect(absence.create, JSON.stringify(absence)).toBe(true);
    }
    for (const gap of result.execution_contract?.readiness_certificate?.gaps ?? []) {
      expect(gap).not.toContain("request-item-absent:COOKIE_SALT_ROUNDS");
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// 5. a file-name match alone never makes a required edit target
// ---------------------------------------------------------------------------

describe("filename-match-only write authority", () => {
  it("recognises a surface admitted on its file name alone", () => {
    expect(surfaceAdmittedByFilenameMatchOnly("filename-match")).toBe(true);
    expect(surfaceAdmittedByFilenameMatchOnly("filename-match; caller-supplied")).toBe(true);
    expect(surfaceAdmittedByFilenameMatchOnly("filename-match; variant token match")).toBe(true);
    expect(surfaceAdmittedByFilenameMatchOnly("filename-match; matched distinctive identifier")).toBe(false);
    expect(surfaceAdmittedByFilenameMatchOnly("defines get_cookie_name")).toBe(false);
    expect(surfaceAdmittedByFilenameMatchOnly("variant token match")).toBe(false);
    expect(surfaceAdmittedByFilenameMatchOnly(undefined)).toBe(false);
  });

  it("the project's own name is a scope word, not the fixture file that shares it", () => {
    const ws = fixtureWorkspace();
    expect(requestNamesFileByWord(FAMILY_REQUEST_JA, NAME_ONLY_FIXTURE_PATH, ws)).toBe(false);
    expect(requestNamesFileByWord(`Fix the ${FAMILY_PACKAGE} session salt`, NAME_ONLY_FIXTURE_PATH, ws)).toBe(false);
    expect(requestNamesFileByWord("Update the changelog", "CHANGELOG.md", ws)).toBe(true);
    expect(requestNamesFileByWord("fix tests/test_basic.py", FAMILY_TEST_PATH, ws)).toBe(true);
    expect(requestNamesFileByWord("Fix test_basic so the salt test passes", FAMILY_TEST_PATH, ws)).toBe(true);
    expect(requestNamesFileByWord("Fix the basics", FAMILY_TEST_PATH, ws), "a substring is not a name").toBe(false);
    expect(requestNamesFileByWord("Fix the config loader", SPHINX_CONF_PATH, ws), "'conf' inside 'config' is not a name").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. the wire: the exact call shape Claude Code sends
// ---------------------------------------------------------------------------

describe("tl_read_file first reply for a new family member (Claude Code wire)", () => {
  const servers: SmallTaskServer[] = [];
  afterAll(async () => {
    for (const server of servers.splice(0)) {
      await server.kill();
      await rmDirWithRetry(server.workspace);
    }
  });

  interface Row { readonly path: string; readonly range?: string; readonly body?: string; readonly why?: string }
  interface Decision { readonly kind: string; readonly gaps?: ReadonlyArray<{ readonly code: string; readonly refs?: readonly string[] }>; readonly frontier?: ReadonlyArray<{ readonly path: string; readonly writable?: boolean }>; readonly certificate?: { readonly gaps?: readonly string[] } }
  const rowsOf = (call: CallResult): Row[] => ((call.body["evidence"] as Row[] | undefined) ?? []);
  const decisionOf = (call: CallResult): Decision => call.body["decision"] as Decision;

  it.each([["EN", FAMILY_REQUEST_EN], ["JA", FAMILY_REQUEST_JA]])("%s: act.edit with the family's sites served and writable", async (_label, query) => {
    const server = await startSmallTaskServer(makeSmallTaskWorkspace("tl-family-wire-", FAMILY_FIXTURE_FILES), { env: { TOKENLIGHTEN_CLIENT: "claude-code" } });
    servers.push(server);
    const call = await server.call("tl_read_file", { cwd: server.workspace, query, task: { epoch: "new" } }, 120000);
    const detail = call.text.slice(0, 2000);
    expect(call.isError, detail).toBe(false);
    expect(call.body["kind"], detail).toBe("read.task_pack");
    const decision = decisionOf(call);
    expect(decision.kind, detail).toBe("act.edit");
    const paths = rowsOf(call).map((row) => row.path);
    expect(paths.slice(0, 4), detail).toEqual(FAMILY_SEED_PATHS);
    expect(new Set(paths), detail).toEqual(new Set(FAMILY_SEED_PATHS));
    for (const row of rowsOf(call)) expect((row.body ?? "").length, `${row.path} body`).toBeGreaterThan(0);
    expect(paths).not.toContain(SPHINX_CONF_PATH);
    expect(paths).not.toContain(NAME_ONLY_FIXTURE_PATH);
    const frontier = decision.frontier ?? [];
    expect(frontier.find((entry) => entry.path === FAMILY_DEFINITION_PATH)?.writable, JSON.stringify(frontier)).toBe(true);
    for (const gap of decision.gaps ?? []) expect(gap.code, JSON.stringify(gap)).not.toBe("request-item-absent");
    for (const gap of decision.certificate?.gaps ?? []) expect(gap).not.toContain("request-item-absent:SESSION_COOKIE_SALT");
    expect(String(call.body["advisory"] ?? ""), detail).toContain("SESSION_COOKIE_SALT");
    expect(call.bytes, `bytes ${call.bytes}`).toBeLessThan(24_000);
    expect(JSON.stringify(call.body["profile_binding"])).not.toContain("artifact_build");
  }, 180000);
});
