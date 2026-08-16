/**
 * envelope.spec.ts — assert no tokenlighten:meta envelope appears in any
 * generated output from the extension package.
 *
 * Background: docs/00-postmortem.md §2.2 — the tokenlighten:meta envelope
 * dominated cache_write cost in iter-12/iter-13. Must never be revived.
 *
 * These tests mirror the pattern established in
 * packages/mcp-server/src/__tests__/envelope.spec.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, def: unknown) => def,
    }),
  },
  window: {
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
    createStatusBarItem: vi.fn(() => ({
      text: "",
      tooltip: "",
      command: undefined,
      show: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  env: {
    openExternal: vi.fn(),
  },
  Uri: {
    parse: (s: string) => ({ toString: () => s }),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import { spawnTl } from "../cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProc(stdout: string, code = 0): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setImmediate(() => {
    proc.stdout.emit("data", Buffer.from(stdout));
    proc.emit("close", code);
  });
  return proc;
}

const FORBIDDEN_ENVELOPE_PATTERN = /<!--\s*tokenlighten:meta/i;
const FORBIDDEN_KEYS = [
  '"tokenlighten:meta"',
  '"meta"',
  '"next_action"',
  '"edit_candidates"',
];

function assertNoEnvelope(text: string): void {
  expect(text).not.toMatch(FORBIDDEN_ENVELOPE_PATTERN);
  for (const key of FORBIDDEN_KEYS) {
    expect(text).not.toContain(key);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("envelope invariants — extension package output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawnTl stdout passes through without injecting envelope keys", async () => {
    const plainOutput = "proxy started on port 4000";
    mockSpawn.mockReturnValue(makeProc(plainOutput, 0));
    const result = await spawnTl(["proxy", "start"]);
    assertNoEnvelope(result.stdout);
    assertNoEnvelope(result.stderr);
  });

  it("doctor JSON output is not wrapped in an envelope", async () => {
    const doc = JSON.stringify({ ok: true, issues: [] });
    mockSpawn.mockReturnValue(makeProc(doc, 0));
    const result = await spawnTl(["doctor", "--json"]);
    assertNoEnvelope(result.stdout);
  });

  it("package.json contributes section contains no tokenlighten:meta text", () => {
    const pkgPath = join(__dirname, "..", "..", "package.json");
    const serialized = readFileSync(pkgPath, "utf8");
    expect(serialized).not.toMatch(FORBIDDEN_ENVELOPE_PATTERN);
    expect(serialized).not.toContain("tokenlighten:meta");
  });

  it("SpawnResult shape has no envelope keys", async () => {
    mockSpawn.mockReturnValue(makeProc("output", 0));
    const result = await spawnTl(["status"]);
    const keys = Object.keys(result).sort();
    expect(keys).toEqual(["code", "stderr", "stdout"]);
    const extensionSerializedResult = JSON.stringify(result);
    expect(extensionSerializedResult).not.toMatch(FORBIDDEN_ENVELOPE_PATTERN);
  });
});
