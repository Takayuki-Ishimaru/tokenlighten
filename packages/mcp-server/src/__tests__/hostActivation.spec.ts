/**
 * hostActivation.spec.ts — unit coverage of mcp/hostActivation.ts, the server
 * half of the VS Code window-scoped off switch (2026-10-02). The wire-level
 * behavior, against real spawned servers, is hostActivationTransport.spec.ts.
 *
 * WHAT IS PINNED HERE
 *   - WHO it applies to: the VS Code client by environment only, exact match;
 *   - the READING rules: a regular file of at most 4096 bytes in a real
 *     `.tokenlighten` directory, JSON with exactly the five v1 fields, and
 *     anything else is "no override" (fail-open);
 *   - LIVENESS: the owner pid is alive (EPERM counts as alive; a dead owner is
 *     stale) AND the file is fresh — no older than the 90 s TTL, none more than
 *     60 s ahead of the clock — because a live pid is any process the OS gave
 *     the number to (init, the parent, a reused pid, a teammate's committed
 *     file). The clock is injectable, so none of it waits out the TTL;
 *   - the timing constants, compared with the extension's copies;
 *   - the refusal TEXT both protocol legs share;
 *   - the WATCH: transitions only (an override that ages out is one, a refreshed
 *     file is not), an unref'd timer, none at all for a client the override
 *     does not apply to, a throwing callback never ends it;
 *   - the `initialize` capability, in-process through the hand-rolled leg.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOST_ACTIVATION_FUTURE_SKEW_MS,
  HOST_ACTIVATION_HEARTBEAT_MS,
  HOST_ACTIVATION_MAX_BYTES,
  HOST_ACTIVATION_POLL_MS,
  HOST_ACTIVATION_TTL_MS,
  hostActivationBypass,
  hostActivationClientApplies,
  hostActivationFilePath,
  hostActivationToolNotFoundMessage,
  hostActivationToolsCapability,
  isHostOwnerAlive,
  readHostActivationOverride,
  resetHostActivationCacheForTest,
  startHostActivationWatch,
} from "../mcp/hostActivation.js";
import { advertisedTools, handleRequest, resetCapturedClientIdForTest } from "../server.js";
import { symlinkSupported } from "./helpers/symlinkSupported.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const ENV_NAMES = ["TOKENLIGHTEN_CLIENT_ID", "TOKENLIGHTEN_CLIENT"] as const;
/** Every test here is in-process and finishes in milliseconds; this only bounds a hang. */
const UNIT_TIMEOUT_MS = 20_000;

const roots: string[] = [];
const savedEnv = new Map<string, string | undefined>();
let stderrNotes: string[] = [];

function setClientEnv(values: Partial<Record<(typeof ENV_NAMES)[number], string | undefined>>): void {
  for (const name of ENV_NAMES) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

beforeEach(() => {
  for (const name of ENV_NAMES) savedEnv.set(name, process.env[name]);
  // Every test starts as a non-VS Code server; the ones that need VS Code say so.
  setClientEnv({});
  resetHostActivationCacheForTest();
  stderrNotes = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrNotes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of ENV_NAMES) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetCapturedClientIdForTest();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(HOME, ".tl-host-activation-unit-")));
  roots.push(root);
  return root;
}

/** A record this process owns, stamped NOW (an override is only live while fresh); `patch` overrides any field. */
function validRecord(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    client: "vscode",
    state: "disabled",
    ownerPid: process.pid,
    updatedAt: new Date().toISOString(),
    ...patch,
  };
}

/** The way the extension writes: a temp file in the same directory, then a rename. */
function writeOverride(root: string, content: string | Record<string, unknown>): string {
  const target = hostActivationFilePath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, typeof content === "string" ? content : JSON.stringify(content));
  fs.renameSync(temp, target);
  return target;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deadPid(): number {
  const finished = spawnSync(process.execPath, ["-e", ""]);
  const pid = finished.pid;
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
  return pid;
}

describe("hostActivationClientApplies — the VS Code client by environment only", { timeout: UNIT_TIMEOUT_MS }, () => {
  it.each<[string, Partial<Record<(typeof ENV_NAMES)[number], string>>, boolean]>([
    ["TOKENLIGHTEN_CLIENT_ID=vscode", { TOKENLIGHTEN_CLIENT_ID: "vscode" }, true],
    ["TOKENLIGHTEN_CLIENT=vscode (an older VS Code entry)", { TOKENLIGHTEN_CLIENT: "vscode" }, true],
    ["both set to vscode (what setup writes)", { TOKENLIGHTEN_CLIENT_ID: "vscode", TOKENLIGHTEN_CLIENT: "vscode" }, true],
    ["neither set", {}, false],
    ["Claude Code's entry", { TOKENLIGHTEN_CLIENT: "claude-code" }, false],
    ["another client id", { TOKENLIGHTEN_CLIENT_ID: "codex", TOKENLIGHTEN_CLIENT: "claude-code" }, false],
    ["a different case", { TOKENLIGHTEN_CLIENT_ID: "VSCode" }, false],
    ["a padded value", { TOKENLIGHTEN_CLIENT_ID: " vscode" }, false],
    ["a longer value", { TOKENLIGHTEN_CLIENT: "vscode-insiders" }, false],
    ["an empty value", { TOKENLIGHTEN_CLIENT_ID: "" }, false],
  ])("%s", (_label, env, expected) => {
    setClientEnv(env);
    expect(hostActivationClientApplies()).toBe(expected);
    // The capability follows the same predicate, and `{}` stays `{}` byte for byte.
    expect(JSON.stringify(hostActivationToolsCapability())).toBe(expected ? '{"listChanged":true}' : "{}");
  });
});

describe("readHostActivationOverride — the reading rules", { timeout: UNIT_TIMEOUT_MS }, () => {
  it("returns the validated record for a well-formed file", () => {
    const root = workspace();
    // Reading is about the file's shape, not its age: a stamp from long ago is still a valid record.
    writeOverride(root, validRecord({ state: "native", ownerPid: 4242, updatedAt: "2026-10-02T09:00:00.000Z" }));
    expect(readHostActivationOverride(root)).toEqual({
      state: "native",
      ownerPid: 4242,
      updatedAt: "2026-10-02T09:00:00.000Z",
    });
  });

  it("returns nothing, quietly, when there is no .tokenlighten directory or no file", () => {
    const root = workspace();
    expect(readHostActivationOverride(root)).toBeUndefined();
    fs.mkdirSync(path.join(root, ".tokenlighten"));
    expect(readHostActivationOverride(root)).toBeUndefined();
    expect(stderrNotes).toEqual([]);
  });

  const wellFormed = JSON.stringify(validRecord());
  it.each<[string, string]>([
    ["not JSON", "{ nope"],
    ["an empty file", ""],
    ["JSON null", "null"],
    ["an array", "[]"],
    ["a string", '"vscode"'],
    ["a UTF-8 byte order mark before the JSON", `﻿${wellFormed}`],
    ["a missing field (updatedAt)", JSON.stringify({ schemaVersion: 1, client: "vscode", state: "disabled", ownerPid: 1 })],
    ["a field this version does not know", JSON.stringify(validRecord({ window: "a" }))],
    ["schemaVersion 2", JSON.stringify(validRecord({ schemaVersion: 2 }))],
    ["schemaVersion \"1\" as a string", JSON.stringify(validRecord({ schemaVersion: "1" }))],
    ["another client", JSON.stringify(validRecord({ client: "codex" }))],
    ["an unknown state", JSON.stringify(validRecord({ state: "off" }))],
    ["a differently cased state", JSON.stringify(validRecord({ state: "Native" }))],
    ["ownerPid 0", JSON.stringify(validRecord({ ownerPid: 0 }))],
    ["a negative ownerPid", JSON.stringify(validRecord({ ownerPid: -5 }))],
    ["a fractional ownerPid", JSON.stringify(validRecord({ ownerPid: 1.5 }))],
    ["an ownerPid beyond the safe integers", wellFormed.replace(String(process.pid), "1e300")],
    ["an ownerPid as a string", JSON.stringify(validRecord({ ownerPid: String(process.pid) }))],
    ["a null ownerPid", JSON.stringify(validRecord({ ownerPid: null }))],
    ["an updatedAt that is not a date", JSON.stringify(validRecord({ updatedAt: "yesterday-ish" }))],
    ["a numeric updatedAt", JSON.stringify(validRecord({ updatedAt: 1759395600000 }))],
    ["an empty updatedAt", JSON.stringify(validRecord({ updatedAt: "" }))],
    ["an overlong updatedAt", JSON.stringify(validRecord({ updatedAt: `2026-10-02T09:00:00.000Z${"0".repeat(80)}` }))],
  ])("ignores %s", (_label, content) => {
    const root = workspace();
    writeOverride(root, content);
    expect(readHostActivationOverride(root)).toBeUndefined();
  });

  it("ignores a file past 4096 bytes but accepts one of exactly 4096", () => {
    const root = workspace();
    const base = JSON.stringify(validRecord());
    const exact = base + " ".repeat(HOST_ACTIVATION_MAX_BYTES - Buffer.byteLength(base));
    expect(Buffer.byteLength(exact)).toBe(HOST_ACTIVATION_MAX_BYTES);
    writeOverride(root, exact);
    expect(readHostActivationOverride(root)?.ownerPid).toBe(process.pid);

    writeOverride(root, `${exact} `);
    expect(readHostActivationOverride(root)).toBeUndefined();
    expect(stderrNotes.join("")).toContain(`larger than ${HOST_ACTIVATION_MAX_BYTES} bytes`);
  });

  it("ignores a directory where the file should be", () => {
    const root = workspace();
    fs.mkdirSync(hostActivationFilePath(root), { recursive: true });
    expect(readHostActivationOverride(root)).toBeUndefined();
    expect(stderrNotes.join("")).toContain("not a regular file");
  });

  it.skipIf(!symlinkSupported())("ignores a symlinked override file, even one pointing at a valid file", () => {
    const root = workspace();
    const real = path.join(root, "elsewhere.json");
    fs.writeFileSync(real, JSON.stringify(validRecord()));
    fs.mkdirSync(path.join(root, ".tokenlighten"));
    fs.symlinkSync(real, hostActivationFilePath(root));
    expect(readHostActivationOverride(root)).toBeUndefined();
    expect(stderrNotes.join("")).toContain("not a regular file");
  });

  it.skipIf(!symlinkSupported())("ignores an override reached through a symlinked .tokenlighten directory", () => {
    const root = workspace();
    const realDir = path.join(root, "real-state");
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, "host-activation.json"), JSON.stringify(validRecord()));
    fs.symlinkSync(realDir, path.join(root, ".tokenlighten"), "dir");
    expect(readHostActivationOverride(root)).toBeUndefined();
    expect(stderrNotes.join("")).toContain("not a real directory");
  });

  it("notes an ignored file once per distinct file state, and follows the file as it changes", () => {
    const root = workspace();
    writeOverride(root, "{ nope");
    expect(readHostActivationOverride(root)).toBeUndefined();
    expect(readHostActivationOverride(root)).toBeUndefined();
    expect(readHostActivationOverride(root)).toBeUndefined();
    expect(stderrNotes.filter((line) => line.includes("malformed or unsupported content"))).toHaveLength(1);

    writeOverride(root, validRecord({ state: "native" }));
    expect(readHostActivationOverride(root)?.state).toBe("native");
    // A different valid file (new inode, new stamp) replaces the cached parse.
    writeOverride(root, validRecord({ state: "disabled", ownerPid: process.pid + 1 }));
    expect(readHostActivationOverride(root)).toMatchObject({ state: "disabled", ownerPid: process.pid + 1 });
    // And back to a bad file: noted again, because it is a new file state.
    writeOverride(root, "[]");
    expect(readHostActivationOverride(root)).toBeUndefined();
    expect(stderrNotes.filter((line) => line.includes("malformed or unsupported content"))).toHaveLength(2);

    fs.rmSync(hostActivationFilePath(root));
    expect(readHostActivationOverride(root)).toBeUndefined();
  });
});

describe("isHostOwnerAlive", { timeout: UNIT_TIMEOUT_MS }, () => {
  it("is true for a running process and false for one that has exited", () => {
    expect(isHostOwnerAlive(process.pid)).toBe(true);
    expect(isHostOwnerAlive(deadPid())).toBe(false);
  });

  it("counts EPERM (a process that exists but is not ours to signal) as alive; ESRCH and anything else as dead", () => {
    const failWith = (code: string | undefined): void => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error(code ?? "no code"), code === undefined ? {} : { code });
      });
    };
    failWith("EPERM");
    expect(isHostOwnerAlive(4242)).toBe(true);
    vi.restoreAllMocks();
    failWith("ESRCH");
    expect(isHostOwnerAlive(4242)).toBe(false);
    vi.restoreAllMocks();
    failWith(undefined);
    expect(isHostOwnerAlive(4242)).toBe(false);
  });
});

describe("hostActivationBypass — a LIVE override that applies to this server", { timeout: UNIT_TIMEOUT_MS }, () => {
  it("is the validated record plus the refusal's reason, for each state", () => {
    setClientEnv({ TOKENLIGHTEN_CLIENT_ID: "vscode" });
    const root = workspace();

    const stamped = validRecord({ state: "disabled" });
    writeOverride(root, stamped);
    expect(hostActivationBypass(root)).toEqual({
      state: "disabled",
      ownerPid: process.pid,
      updatedAt: stamped["updatedAt"],
      reason: "disabled by tokenlighten.enabled=false",
    });
    writeOverride(root, validRecord({ state: "native" }));
    expect(hostActivationBypass(root)?.reason).toBe("native session");
  });

  it("is nothing for a server that is not the VS Code client, whatever the file says", () => {
    const root = workspace();
    writeOverride(root, validRecord());
    expect(hostActivationBypass(root)).toBeUndefined();
    setClientEnv({ TOKENLIGHTEN_CLIENT: "claude-code" });
    expect(hostActivationBypass(root)).toBeUndefined();
    // ...and nothing was even looked at: no note, no parse for a client it never concerned.
    expect(stderrNotes).toEqual([]);
  });

  it("is nothing once the owner has exited, and live again the moment a live owner writes the file", () => {
    setClientEnv({ TOKENLIGHTEN_CLIENT_ID: "vscode" });
    const root = workspace();
    writeOverride(root, validRecord({ ownerPid: deadPid() }));
    expect(hostActivationBypass(root)).toBeUndefined();
    writeOverride(root, validRecord({ ownerPid: process.pid }));
    expect(hostActivationBypass(root)?.state).toBe("disabled");
  });

  it("re-probes the owner on every call: the same cached file goes stale when its owner dies", () => {
    setClientEnv({ TOKENLIGHTEN_CLIENT_ID: "vscode" });
    const root = workspace();
    writeOverride(root, validRecord({ ownerPid: 4242 }));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(hostActivationBypass(root)?.ownerPid).toBe(4242);
    kill.mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    expect(hostActivationBypass(root)).toBeUndefined();
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it("is nothing for an invalid file (fail-open)", () => {
    setClientEnv({ TOKENLIGHTEN_CLIENT_ID: "vscode" });
    const root = workspace();
    writeOverride(root, "{ nope");
    expect(hostActivationBypass(root)).toBeUndefined();
    writeOverride(root, validRecord({ schemaVersion: 2 }));
    expect(hostActivationBypass(root)).toBeUndefined();
  });
});

// An override is live only while its owner pid is alive AND its file is fresh:
// a live pid alone is any process the OS gave the number to (init, the parent, a
// reused pid, the pid a teammate's committed file names). The clock is a
// parameter, so none of this waits out the 90 s TTL.
describe("hostActivationBypass — a live pid is not enough: the file must be fresh", { timeout: UNIT_TIMEOUT_MS }, () => {
  const STAMP = "2026-10-02T09:00:00.000Z";
  const STAMPED_AT = Date.parse(STAMP);
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** An override stamped STAMP whose owner (by default this process) is alive, judged `ageMs` after it was stamped. */
  function judge(ageMs: number, patch: Record<string, unknown> = {}) {
    setClientEnv({ TOKENLIGHTEN_CLIENT_ID: "vscode" });
    const root = workspace();
    writeOverride(root, validRecord({ updatedAt: STAMP, ...patch }));
    return hostActivationBypass(root, STAMPED_AT + ageMs);
  }

  it.each<[string, number]>([
    ["just written", 0],
    ["half the TTL old", HOST_ACTIVATION_TTL_MS / 2],
    ["one millisecond inside the TTL", HOST_ACTIVATION_TTL_MS - 1],
    ["exactly the TTL old", HOST_ACTIVATION_TTL_MS],
  ])("honours a live owner's override that is %s", (_label, ageMs) => {
    expect(judge(ageMs)?.ownerPid).toBe(process.pid);
  });

  it.each<[string, number]>([
    ["one millisecond past the TTL", HOST_ACTIVATION_TTL_MS + 1],
    ["a minute past the TTL", HOST_ACTIVATION_TTL_MS + 60_000],
    ["a day old", DAY_MS],
  ])("ignores a live owner's override that is %s", (_label, ageMs) => {
    expect(judge(ageMs)).toBeUndefined();
  });

  it.each<[string, number]>([
    ["stamped a millisecond ahead of the clock", -1],
    ["stamped exactly the skew ahead of the clock", -HOST_ACTIVATION_FUTURE_SKEW_MS],
  ])("honours a live owner's override %s", (_label, ageMs) => {
    expect(judge(ageMs)?.ownerPid).toBe(process.pid);
  });

  it.each<[string, number]>([
    ["stamped a millisecond beyond the skew ahead of the clock", -(HOST_ACTIVATION_FUTURE_SKEW_MS + 1)],
    ["stamped a day ahead of the clock", -DAY_MS],
  ])("ignores a live owner's override %s (a future-dated file is invalid)", (_label, ageMs) => {
    expect(judge(ageMs)).toBeUndefined();
  });

  it("ignores the review's probe: pid 1, which is always alive, with a 2020 stamp, on the real clock", () => {
    setClientEnv({ TOKENLIGHTEN_CLIENT_ID: "vscode" });
    const root = workspace();
    writeOverride(root, validRecord({ ownerPid: 1, updatedAt: "2020-01-01T00:00:00.000Z" }));
    expect(hostActivationBypass(root)).toBeUndefined();
  });

  it("ignores an unrelated live process's pid (the parent process) once its file has aged out", () => {
    expect(judge(HOST_ACTIVATION_TTL_MS + 1, { ownerPid: process.ppid })).toBeUndefined();
    // Control: the very same pid, a file just inside the TTL, is honoured.
    expect(judge(HOST_ACTIVATION_TTL_MS, { ownerPid: process.ppid })?.ownerPid).toBe(process.ppid);
  });

  it("judges the file as it is on disk now: rewriting it with a current stamp makes it live again", () => {
    setClientEnv({ TOKENLIGHTEN_CLIENT_ID: "vscode" });
    const root = workspace();
    const later = STAMPED_AT + HOST_ACTIVATION_TTL_MS + 1;
    writeOverride(root, validRecord({ updatedAt: STAMP }));
    expect(hostActivationBypass(root, later)).toBeUndefined();
    writeOverride(root, validRecord({ updatedAt: new Date(later).toISOString() }));
    expect(hostActivationBypass(root, later)?.ownerPid).toBe(process.pid);
  });
});

describe("hostActivationToolNotFoundMessage", { timeout: UNIT_TIMEOUT_MS }, () => {
  it("names the tool and the reason, and points at the native tools", () => {
    const base = { ownerPid: 1, updatedAt: "2026-10-02T09:00:00.000Z" } as const;
    expect(
      hostActivationToolNotFoundMessage("tl_read_file", { ...base, state: "disabled", reason: "disabled by tokenlighten.enabled=false" }),
    ).toBe("Tool not found: tl_read_file (TokenLighten is turned off for this VS Code window: disabled by tokenlighten.enabled=false; use the host's native tools)");
    expect(
      hostActivationToolNotFoundMessage("tl_search_files", { ...base, state: "native", reason: "native session" }),
    ).toBe("Tool not found: tl_search_files (TokenLighten is turned off for this VS Code window: native session; use the host's native tools)");
  });
});

describe("startHostActivationWatch — transitions only", { timeout: UNIT_TIMEOUT_MS }, () => {
  it("starts nothing at all for a client the override does not apply to", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const root = workspace();
    writeOverride(root, validRecord());
    expect(startHostActivationWatch(root, () => undefined, 10)).toBeUndefined();
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("uses an unref'd timer, so it never keeps the process alive", () => {
    setClientEnv({ TOKENLIGHTEN_CLIENT_ID: "vscode" });
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const watch = startHostActivationWatch(workspace(), () => undefined, 10_000);
    try {
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      const timer = setIntervalSpy.mock.results[0]!.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
    } finally {
      watch?.stop();
    }
  });

  it("reports the file appearing and going, nothing in between, and nothing once stopped", async () => {
    setClientEnv({ TOKENLIGHTEN_CLIENT_ID: "vscode" });
    const root = workspace();
    const changes: boolean[] = [];
    const watch = startHostActivationWatch(root, (live) => changes.push(live), 10)!;
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(changes).toEqual([]); // the baseline is "not live" and it stayed that way

      const file = writeOverride(root, validRecord({ state: "disabled" }));
      await waitUntil(() => changes.length === 1);
      expect(changes).toEqual([true]);

      // A different live state is not a transition.
      writeOverride(root, validRecord({ state: "native" }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(changes).toEqual([true]);

      fs.rmSync(file);
      await waitUntil(() => changes.length === 2);
      expect(changes).toEqual([true, false]);
      // The note names the state the transition saw (the first write), not the later rewrite.
      expect(stderrNotes.join("")).toContain("host activation: TokenLighten turned off for this VS Code window (disabled by tokenlighten.enabled=false; owner pid");
      expect(stderrNotes.join("")).toContain("host activation: override ended; TokenLighten tools restored");
    } finally {
      watch.stop();
    }

    writeOverride(root, validRecord());
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(changes).toEqual([true, false]); // stopped: the new file is never reported
  });

  it("takes the state at start as its baseline: an override already live is not a transition, its end is", async () => {
    setClientEnv({ TOKENLIGHTEN_CLIENT_ID: "vscode" });
    const root = workspace();
    const file = writeOverride(root, validRecord());
    const changes: boolean[] = [];
    const watch = startHostActivationWatch(root, (live) => changes.push(live), 10)!;
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(changes).toEqual([]);
      fs.rmSync(file);
      await waitUntil(() => changes.length === 1);
      expect(changes).toEqual([false]);
    } finally {
      watch.stop();
    }
  });

  it("does not report a stale file, and reports the owner's death as the override ending", async () => {
    setClientEnv({ TOKENLIGHTEN_CLIENT_ID: "vscode" });
    const root = workspace();
    writeOverride(root, validRecord({ ownerPid: deadPid() }));
    const changes: boolean[] = [];
    const watch = startHostActivationWatch(root, (live) => changes.push(live), 10)!;
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(changes).toEqual([]);

      // A live owner, then that owner "dies" while the file stays on disk.
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      writeOverride(root, validRecord({ ownerPid: 4242 }));
      await waitUntil(() => changes.length === 1);
      kill.mockImplementation(() => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      });
      await waitUntil(() => changes.length === 2);
      expect(changes).toEqual([true, false]);
    } finally {
      watch.stop();
    }
  });

  it("reports a live override that ages out as the override ending, and a refreshed file as live again — on an injected clock", async () => {
    setClientEnv({ TOKENLIGHTEN_CLIENT_ID: "vscode" });
    const root = workspace();
    let now = Date.parse("2026-10-02T09:00:00.000Z");
    writeOverride(root, validRecord({ updatedAt: new Date(now).toISOString() }));
    const changes: boolean[] = [];
    const watch = startHostActivationWatch(root, (live) => changes.push(live), 10, () => now)!;
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(changes).toEqual([]); // the baseline is live, and it stays live

      now += HOST_ACTIVATION_TTL_MS; // exactly the TTL old: still live
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(changes).toEqual([]);

      now += 1; // one millisecond more: aged out, with the file untouched and its owner alive
      await waitUntil(() => changes.length === 1);
      expect(changes).toEqual([false]);
      expect(stderrNotes.join("")).toContain(
        `host activation: override ended; TokenLighten tools restored (not refreshed within ${HOST_ACTIVATION_TTL_MS / 1000} s)`,
      );

      // The extension's heartbeat rewrites its file with a current stamp: live again.
      writeOverride(root, validRecord({ updatedAt: new Date(now).toISOString() }));
      await waitUntil(() => changes.length === 2);
      expect(changes).toEqual([false, true]);
    } finally {
      watch.stop();
    }
  });

  it("keeps an override live for as long as it is refreshed, however many TTLs pass, and ends it once the refreshing stops", async () => {
    setClientEnv({ TOKENLIGHTEN_CLIENT_ID: "vscode" });
    const root = workspace();
    let now = Date.parse("2026-10-02T09:00:00.000Z");
    writeOverride(root, validRecord({ updatedAt: new Date(now).toISOString() }));
    const changes: boolean[] = [];
    const watch = startHostActivationWatch(root, (live) => changes.push(live), 10, () => now)!;
    try {
      // More than two full TTLs of heartbeats, each one rewriting the file with the new time.
      for (let beat = 0; beat < 2 * Math.ceil(HOST_ACTIVATION_TTL_MS / HOST_ACTIVATION_HEARTBEAT_MS) + 2; beat++) {
        now += HOST_ACTIVATION_HEARTBEAT_MS;
        writeOverride(root, validRecord({ updatedAt: new Date(now).toISOString() }));
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(changes).toEqual([]);

      // The heartbeat stops (a hung extension host, or a crash whose pid the OS reused): the file ages out.
      now += HOST_ACTIVATION_TTL_MS + 1;
      await waitUntil(() => changes.length === 1);
      expect(changes).toEqual([false]);
    } finally {
      watch.stop();
    }
  });

  it("survives a callback that throws: the next transition is still reported", async () => {
    setClientEnv({ TOKENLIGHTEN_CLIENT_ID: "vscode" });
    const root = workspace();
    const seen: boolean[] = [];
    const watch = startHostActivationWatch(root, (live) => {
      seen.push(live);
      if (seen.length === 1) throw new Error("the host went away mid-write");
    }, 10)!;
    try {
      const file = writeOverride(root, validRecord());
      await waitUntil(() => seen.length === 1);
      fs.rmSync(file);
      await waitUntil(() => seen.length === 2);
      expect(seen).toEqual([true, false]);
    } finally {
      watch.stop();
    }
  });
});

describe("initialize — the hand-rolled leg declares tools.listChanged for the VS Code client only", { timeout: UNIT_TIMEOUT_MS }, () => {
  async function initializeResult(clientName: string): Promise<Record<string, unknown>> {
    const reply = await handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: clientName, version: "0" } },
    });
    return reply!.result as Record<string, unknown>;
  }

  it.each<[string, Partial<Record<(typeof ENV_NAMES)[number], string>>, string]>([
    ["TOKENLIGHTEN_CLIENT_ID=vscode", { TOKENLIGHTEN_CLIENT_ID: "vscode" }, '{"tools":{"listChanged":true}}'],
    ["TOKENLIGHTEN_CLIENT=vscode", { TOKENLIGHTEN_CLIENT: "vscode" }, '{"tools":{"listChanged":true}}'],
    ["no VS Code environment, even for a client that calls itself VS Code", {}, '{"tools":{}}'],
    ["Claude Code's environment", { TOKENLIGHTEN_CLIENT: "claude-code" }, '{"tools":{}}'],
  ])("%s", async (label, env, expected) => {
    setClientEnv(env);
    const result = await initializeResult(label.startsWith("no VS Code") ? "Visual Studio Code" : "some-client");
    expect(JSON.stringify(result["capabilities"])).toBe(expected);
  });

  it("changes nothing else in the initialize result, and leaves tools/list the full advertised surface when no override is live", async () => {
    setClientEnv({});
    const plain = await initializeResult("some-client");
    setClientEnv({ TOKENLIGHTEN_CLIENT_ID: "vscode" });
    const vscode = await initializeResult("some-client");
    const { capabilities: _plainCapabilities, instructions: _plainInstructions, ...plainRest } = plain;
    const { capabilities: _vscodeCapabilities, instructions: _vscodeInstructions, ...vscodeRest } = vscode;
    // `instructions` is the VS Code variant for that client (clientAdvertisement.ts), as it already was.
    expect(vscodeRest).toEqual(plainRest);

    const listed = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((listed!.result as { tools: unknown[] }).tools).toEqual(advertisedTools());
  });
});

// The two halves share no code, so the numbers they must agree on are compared
// here, from the extension's source text (the extension's own spec does the same
// against this one).
describe("the timing constants — the extension keeps its own copies in step", { timeout: UNIT_TIMEOUT_MS }, () => {
  const extensionSource = fs.readFileSync(
    path.resolve(HERE, "..", "..", "..", "vscode-extension", "src", "hostActivation.ts"),
    "utf8",
  );
  function extensionConstant(name: string): number {
    const match = new RegExp(`export const ${name} = ([0-9_]+);`).exec(extensionSource);
    if (match === null) {
      throw new Error(`${name} is not exported as a plain number from packages/vscode-extension/src/hostActivation.ts`);
    }
    return Number(match[1]!.replaceAll("_", ""));
  }

  it.each<[string, number]>([
    ["HOST_ACTIVATION_HEARTBEAT_MS", HOST_ACTIVATION_HEARTBEAT_MS],
    ["HOST_ACTIVATION_TTL_MS", HOST_ACTIVATION_TTL_MS],
    ["HOST_ACTIVATION_FUTURE_SKEW_MS", HOST_ACTIVATION_FUTURE_SKEW_MS],
  ])("%s is the same number on both sides", (name, serverValue) => {
    expect(extensionConstant(name)).toBe(serverValue);
  });

  it("are the agreed numbers: a 30 s heartbeat, a 90 s TTL, a 60 s future skew", () => {
    expect([HOST_ACTIVATION_HEARTBEAT_MS, HOST_ACTIVATION_TTL_MS, HOST_ACTIVATION_FUTURE_SKEW_MS]).toEqual([30_000, 90_000, 60_000]);
  });

  it("size the TTL on the heartbeat: a healthy file is rewritten, with room to spare, before it can age out", () => {
    // The first heartbeat past half the TTL rewrites the file, so that heartbeat's
    // age is the oldest a healthy file ever gets; add two server polls of slack.
    const oldestHealthyAgeMs = (Math.floor(HOST_ACTIVATION_TTL_MS / 2 / HOST_ACTIVATION_HEARTBEAT_MS) + 1) * HOST_ACTIVATION_HEARTBEAT_MS;
    expect(oldestHealthyAgeMs + 2 * HOST_ACTIVATION_POLL_MS).toBeLessThan(HOST_ACTIVATION_TTL_MS);
  });
});

describe("the file path", { timeout: UNIT_TIMEOUT_MS }, () => {
  it("is <workspace>/.tokenlighten/host-activation.json", () => {
    expect(hostActivationFilePath(path.join("/work", "proj"))).toBe(path.join("/work", "proj", ".tokenlighten", "host-activation.json"));
  });
});
