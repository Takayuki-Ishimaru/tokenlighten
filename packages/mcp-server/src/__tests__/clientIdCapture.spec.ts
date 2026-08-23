// clientIdCapture.spec.ts — F-A7 (v0.11 wave C): initialize's clientInfo.name
// captured once per connection (server.ts's hand-rolled `handleRequest`),
// threaded into every call's ProtocolCallContext.clientId, and proven to
// reach the codec v2 client-profile resolution layer
// (protocol/codec/clientProfile.ts) through a REAL end-to-end dispatch —
// not a hand-built ProtocolCallContext like wireCodecV2Selection.spec.ts's
// own unit tests use.
//
// Why resolveClientProfile is spied rather than observed via the
// wire_codec_v2_cell trace event or a byte-differential codec win: at the
// time this spec was written, that trace only fired when `context.workspace`
// was set (only `edit_file`'s finishEdit() populated it, and `edit.applied`
// is itself HARD_JSON_FIXED — protocol/codec/policy.ts — so it was moot
// either way), and a real read_file `read.text` response wraps its body
// inside `evidence[].body`, which tl-raw-1's bodyFieldOf() never selected.
// D1 (F-C2, 2026-08-21) fixed BOTH: server.ts now threads a dedicated
// codecTraceWorkspace note for read_file/search_files (envelope.ts's
// noteCodecTraceWorkspace — deliberately NOT `context.workspace`, which
// other wire-affecting projectors also read), and tlRaw1.ts's
// locateDominantBody() now also considers evidence[i].body — see
// wireCodecTraceE2E.rc.spec.ts and wireCodecRawBlockE2E.spec.ts for the live
// real-dispatch proof of each. This spec is UNCHANGED by that fix: it still
// proves the clientId WIRING itself (capture + threading) directly at its
// one real consumer, `resolveClientProfile`, independent of whether a codec
// trace happens to fire for the exact call shape used here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  handleRequest,
  capturedClientId,
  resetCapturedClientIdForTest,
} from "../server.js";

const tmpDirs: string[] = [];
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

// Dispatch-based tests need a cwd checkCwdOrRefuse accepts: under $HOME (same
// constraint nextCallEcho.spec.ts/closureMode.spec.ts honor) — an arbitrary
// os.tmpdir() path is refused as "invalid-cwd" by the real callTool() path.
function mkWorkspace(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(HOME, ".tl-clientid-test-")));
  tmpDirs.push(dir);
  return dir;
}

const ENV_KEYS = ["TOKENLIGHTEN_RESPONSE_FORMAT", "TL_WIRE_BREAKEVEN", "TOKENLIGHTEN_CLIENT_ID"] as const;
let savedEnv: Record<string, string | undefined>;

async function initializeWith(name: string): Promise<void> {
  await handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { clientInfo: { name, version: "1.0.0" } },
  });
}

beforeEach(() => {
  resetCapturedClientIdForTest();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  resetCapturedClientIdForTest();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  vi.resetModules();
  vi.doUnmock("../protocol/codec/clientProfile.js");
});

describe("F-A7: handleRequest's initialize case captures clientInfo.name", () => {
  it("captures a well-formed clientInfo.name into module state", async () => {
    expect(capturedClientId).toBeUndefined();
    await initializeWith("tl-reference-client");
    expect(capturedClientId).toBe("tl-reference-client");
  });

  it("a missing or empty clientInfo.name leaves capturedClientId unset", async () => {
    await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(capturedClientId).toBeUndefined();

    await handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { clientInfo: { name: "", version: "1.0.0" } },
    });
    expect(capturedClientId).toBeUndefined();
  });
});

describe("F-A7: captured clientId reaches resolveClientProfile via a real callTool() dispatch", () => {
  // Each case needs its own fresh module graph: vi.doMock only affects
  // imports resolved AFTER it runs, and server.ts (plus everything it pulls
  // in transitively — protocol/emit.ts -> codec/pipeline.ts ->
  // codec/clientProfile.ts) is already statically imported once at this
  // file's top for the describe block above.

  it("initialize's clientInfo.name reaches resolveClientProfile as context.clientId", async () => {
    vi.resetModules();
    const seen: Array<string | undefined> = [];
    vi.doMock("../protocol/codec/clientProfile.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../protocol/codec/clientProfile.js")>();
      return {
        ...actual,
        resolveClientProfile: (clientId: string | undefined, now?: number) => {
          seen.push(clientId);
          return actual.resolveClientProfile(clientId, now);
        },
      };
    });
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "auto";
    process.env["TL_WIRE_BREAKEVEN"] = "1";

    const fresh = await import("../server.js");
    await fresh.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "tl-reference-client", version: "1.0.0" } },
    });

    const ws = mkWorkspace();
    fs.writeFileSync(path.join(ws, "sample.ts"), "export const alpha = 1;\n", "utf8");
    await fresh.callTool("read_file", { path: "sample.ts", cwd: ws });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen).toContain("tl-reference-client");
  });

  it("TOKENLIGHTEN_CLIENT_ID overrides an unregistered captured clientId at resolveClientProfile", async () => {
    vi.resetModules();
    const seen: Array<string | undefined> = [];
    vi.doMock("../protocol/codec/clientProfile.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../protocol/codec/clientProfile.js")>();
      return {
        ...actual,
        resolveClientProfile: (clientId: string | undefined, now?: number) => {
          seen.push(clientId);
          return actual.resolveClientProfile(clientId, now);
        },
      };
    });
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "auto";
    process.env["TL_WIRE_BREAKEVEN"] = "1";

    const fresh = await import("../server.js");
    await fresh.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "some-unregistered-client", version: "1.0.0" } },
    });
    process.env["TOKENLIGHTEN_CLIENT_ID"] = "tl-reference-client";

    const ws = mkWorkspace();
    fs.writeFileSync(path.join(ws, "sample.ts"), "export const alpha = 1;\n", "utf8");
    await fresh.callTool("read_file", { path: "sample.ts", cwd: ws });

    expect(seen).toContain("tl-reference-client");
    expect(seen).not.toContain("some-unregistered-client");
  });

  it("no initialize call, no override: resolveClientProfile sees undefined (the conservative default)", async () => {
    vi.resetModules();
    const seen: Array<string | undefined> = [];
    vi.doMock("../protocol/codec/clientProfile.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../protocol/codec/clientProfile.js")>();
      return {
        ...actual,
        resolveClientProfile: (clientId: string | undefined, now?: number) => {
          seen.push(clientId);
          return actual.resolveClientProfile(clientId, now);
        },
      };
    });
    process.env["TOKENLIGHTEN_RESPONSE_FORMAT"] = "auto";
    process.env["TL_WIRE_BREAKEVEN"] = "1";

    const fresh = await import("../server.js");
    const ws = mkWorkspace();
    fs.writeFileSync(path.join(ws, "sample.ts"), "export const alpha = 1;\n", "utf8");
    await fresh.callTool("read_file", { path: "sample.ts", cwd: ws });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((id) => id === undefined)).toBe(true);
  });
});
