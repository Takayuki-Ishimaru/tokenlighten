import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The extension half of the VS Code window-scoped off switch (2026-10-02).
// The server half is packages/mcp-server/src/mcp/hostActivation.ts and its two
// specs; this one pins what the extension WRITES and REMOVES, against real
// temporary folders and the real `vscodeMcpJsonManaged`.

const {
  mockBypass,
  mockConfigurationChanged,
  mockWorkspaceFoldersChanged,
  workspaceFolders,
  enabledByFolder,
} = vi.hoisted(() => ({
  mockBypass: vi.fn(() => false),
  mockConfigurationChanged: vi.fn(() => ({ dispose: vi.fn() })),
  mockWorkspaceFoldersChanged: vi.fn(() => ({ dispose: vi.fn() })),
  // Mutable so each test can model the folders the window has open.
  workspaceFolders: { value: [] as Array<{ uri: { fsPath: string; scheme?: string } }> | undefined },
  // `tokenlighten.enabled` per folder (resource-scoped); a folder not listed has the default, true.
  enabledByFolder: new Map<string, boolean>(),
}));

vi.mock("vscode", () => ({
  workspace: {
    get workspaceFolders() {
      return workspaceFolders.value;
    },
    onDidChangeConfiguration: mockConfigurationChanged,
    onDidChangeWorkspaceFolders: mockWorkspaceFoldersChanged,
    getConfiguration: (section: string, resource?: { fsPath: string }) => ({
      get: (key: string, fallback: unknown) =>
        section === "tokenlighten" && key === "enabled" && resource !== undefined && enabledByFolder.has(resource.fsPath)
          ? enabledByFolder.get(resource.fsPath)
          : fallback,
    }),
  },
}));

vi.mock("../mcpProvider.js", () => ({ nativeSessionBypassEnabled: mockBypass }));
// workspaceState.ts is REAL (so `vscodeMcpJsonManaged` reads real files); only its CLI import is stubbed.
vi.mock("../cli.js", () => ({ findTlBinary: vi.fn(), spawnTl: vi.fn() }));

import {
  HOST_ACTIVATION_FUTURE_SKEW_MS,
  HOST_ACTIVATION_HEARTBEAT_MS,
  HOST_ACTIVATION_TTL_MS,
  hostActivationOverridePath,
  registerHostActivation,
  removeOwnHostActivationOverrides,
  syncHostActivationOverrides,
} from "../hostActivation.js";

const folders: string[] = [];

/** Every test here is synchronous file I/O in a temp folder; this only bounds a hang. */
const UNIT_TIMEOUT_MS = 20_000;

function makeFolder(options: { managed: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "tl-ext-host-activation-"));
  folders.push(root);
  if (options.managed) {
    mkdirSync(join(root, ".vscode"));
    writeFileSync(
      join(root, ".vscode", "mcp.json"),
      JSON.stringify({
        servers: {
          tokenlighten: {
            command: "tl",
            args: ["mcp", "start", "--stdio", "--allow-write", "--workspace", root],
            env: { TOKENLIGHTEN_MANAGED: "1", TOKENLIGHTEN_CLIENT: "vscode", TOKENLIGHTEN_CLIENT_ID: "vscode" },
          },
        },
      }),
    );
  }
  return root;
}

function openFolders(...roots: string[]): void {
  workspaceFolders.value = roots.map((fsPath) => ({ uri: { fsPath, scheme: "file" } }));
}

function overrideOf(root: string): Record<string, unknown> | undefined {
  const file = hostActivationOverridePath(root);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : undefined;
}

/** A record as the extension writes it; `updatedAt` defaults to NOW, because an override is only live while fresh. */
function record(state: string, ownerPid: number, updatedAt: string = new Date().toISOString()): string {
  return JSON.stringify({ schemaVersion: 1, client: "vscode", state, ownerPid, updatedAt });
}

function plant(root: string, content: string): string {
  mkdirSync(join(root, ".tokenlighten"), { recursive: true });
  const file = hostActivationOverridePath(root);
  writeFileSync(file, content);
  return file;
}

/** A pid that belonged to a process this test started and waited for. */
function deadPid(): number {
  const finished = spawnSync(process.execPath, ["-e", ""]);
  expect(() => process.kill(finished.pid, 0)).toThrow();
  return finished.pid;
}

function symlinksWork(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "tl-ext-symlink-probe-"));
  try {
    mkdirSync(join(dir, "target"));
    symlinkSync(join(dir, "target"), join(dir, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBypass.mockReturnValue(false);
  enabledByFolder.clear();
  workspaceFolders.value = [];
  // Forget what a previous test's window had written.
  removeOwnHostActivationOverrides();
});

afterEach(() => {
  removeOwnHostActivationOverrides();
  vi.restoreAllMocks();
  for (const root of folders.splice(0)) {
    try {
      chmodSync(join(root, ".tokenlighten"), 0o700);
    } catch {
      // not there
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("syncHostActivationOverrides — what the window wants, written for the server", { timeout: UNIT_TIMEOUT_MS }, () => {
  it("writes {state:\"disabled\"} for a managed folder while tokenlighten.enabled is false", () => {
    const root = makeFolder({ managed: true });
    openFolders(root);
    enabledByFolder.set(root, false);

    syncHostActivationOverrides();

    const written = overrideOf(root)!;
    expect(written).toMatchObject({ schemaVersion: 1, client: "vscode", state: "disabled", ownerPid: process.pid });
    // Exactly the five fields the server accepts, and a real ISO-8601 timestamp.
    expect(Object.keys(written).sort()).toEqual(["client", "ownerPid", "schemaVersion", "state", "updatedAt"]);
    expect(new Date(written["updatedAt"] as string).toISOString()).toBe(written["updatedAt"]);
    // Atomic write: no temp file left beside it.
    expect(readdirSync(join(root, ".tokenlighten"))).toEqual(["host-activation.json"]);
  });

  it("writes {state:\"native\"} while the session bypass is on, even if the setting is also false", () => {
    const root = makeFolder({ managed: true });
    openFolders(root);
    mockBypass.mockReturnValue(true);

    syncHostActivationOverrides();
    expect(overrideOf(root)).toMatchObject({ state: "native", ownerPid: process.pid });

    enabledByFolder.set(root, false);
    syncHostActivationOverrides();
    expect(overrideOf(root)).toMatchObject({ state: "native" });
  });

  it("follows the state: disabled, then native, then back to nothing when re-enabled with the bypass off", () => {
    const root = makeFolder({ managed: true });
    openFolders(root);

    enabledByFolder.set(root, false);
    syncHostActivationOverrides();
    expect(overrideOf(root)?.["state"]).toBe("disabled");

    mockBypass.mockReturnValue(true);
    syncHostActivationOverrides();
    expect(overrideOf(root)?.["state"]).toBe("native");

    mockBypass.mockReturnValue(false);
    syncHostActivationOverrides();
    expect(overrideOf(root)?.["state"]).toBe("disabled");

    enabledByFolder.set(root, true);
    syncHostActivationOverrides();
    expect(overrideOf(root)).toBeUndefined();
    expect(existsSync(hostActivationOverridePath(root))).toBe(false);
  });

  it("creates nothing for an enabled managed folder with the bypass off", () => {
    const root = makeFolder({ managed: true });
    openFolders(root);

    syncHostActivationOverrides();

    expect(existsSync(join(root, ".tokenlighten"))).toBe(false);
  });

  it("decides per folder in a multi-root window: only the managed folder whose setting is false gets a file", () => {
    const off = makeFolder({ managed: true });
    const on = makeFolder({ managed: true });
    const unmanaged = makeFolder({ managed: false });
    openFolders(off, on, unmanaged);
    enabledByFolder.set(off, false);
    enabledByFolder.set(unmanaged, false);

    syncHostActivationOverrides();

    expect(overrideOf(off)?.["state"]).toBe("disabled");
    expect(existsSync(join(on, ".tokenlighten"))).toBe(false);
    expect(existsSync(join(unmanaged, ".tokenlighten"))).toBe(false);
  });

  it("leaves a file it already wrote alone when nothing changed, and rewrites it when the state does", () => {
    const root = makeFolder({ managed: true });
    openFolders(root);
    enabledByFolder.set(root, false);
    syncHostActivationOverrides();
    const file = hostActivationOverridePath(root);
    const before = { text: readFileSync(file, "utf8"), ino: statSync(file).ino };

    syncHostActivationOverrides();
    syncHostActivationOverrides();
    expect({ text: readFileSync(file, "utf8"), ino: statSync(file).ino }).toEqual(before);

    mockBypass.mockReturnValue(true);
    syncHostActivationOverrides();
    expect(readFileSync(file, "utf8")).not.toBe(before.text);
    expect(overrideOf(root)?.["state"]).toBe("native");
  });

  it("skips a folder on a virtual file system", () => {
    const root = makeFolder({ managed: true });
    workspaceFolders.value = [{ uri: { fsPath: root, scheme: "vscode-vfs" } }];
    enabledByFolder.set(root, false);

    syncHostActivationOverrides();

    expect(existsSync(join(root, ".tokenlighten"))).toBe(false);
  });

  it("does nothing, and does not throw, with no workspace folder open", () => {
    workspaceFolders.value = undefined;
    expect(() => syncHostActivationOverrides()).not.toThrow();
  });
});

describe("syncHostActivationOverrides — folders and files that are not this window's", { timeout: UNIT_TIMEOUT_MS }, () => {
  it("never writes into a folder whose .vscode/mcp.json is not TokenLighten-managed, for either state", () => {
    const root = makeFolder({ managed: false });
    openFolders(root);
    enabledByFolder.set(root, false);

    syncHostActivationOverrides();
    mockBypass.mockReturnValue(true);
    syncHostActivationOverrides();

    expect(existsSync(join(root, ".tokenlighten"))).toBe(false);
  });

  it("writes for the unmarked vscode entry an older `tl workspace setup` wrote: VS Code launches that server too (Copilot retest r3)", () => {
    const root = makeFolder({ managed: false });
    mkdirSync(join(root, ".vscode"));
    writeFileSync(
      join(root, ".vscode", "mcp.json"),
      JSON.stringify({
        servers: {
          tokenlighten: {
            command: "/home/user/.local/share/tokenlighten/bin/tl",
            args: ["mcp", "start", "--stdio", "--allow-write", "--workspace", root],
            env: { TOKENLIGHTEN_CLIENT: "vscode", TOKENLIGHTEN_USAGE_LOG: "on", TOKENLIGHTEN_CLIENT_ID: "vscode", TL_TURN_ECONOMY: "1" },
          },
        },
      }),
    );
    openFolders(root);

    enabledByFolder.set(root, false);
    syncHostActivationOverrides();
    expect(overrideOf(root)).toMatchObject({ state: "disabled", ownerPid: process.pid });

    enabledByFolder.set(root, true);
    mockBypass.mockReturnValue(true);
    syncHostActivationOverrides();
    expect(overrideOf(root)).toMatchObject({ state: "native", ownerPid: process.pid });
  });

  it("never removes a file whose owner is another LIVE process, and replaces it only to write a state of its own", () => {
    const root = makeFolder({ managed: true });
    openFolders(root);
    // The parent of the test process: alive, and not this process.
    const other = process.ppid;
    expect(other).not.toBe(process.pid);
    const file = plant(root, record("disabled", other));
    const planted = readFileSync(file, "utf8");

    // This window wants nothing: the other window's file stays.
    syncHostActivationOverrides();
    expect(readFileSync(file, "utf8")).toBe(planted);
    removeOwnHostActivationOverrides();
    expect(readFileSync(file, "utf8")).toBe(planted);

    // This window wants a state: the file is its to write (two windows on one folder share it, last writer wins).
    enabledByFolder.set(root, false);
    syncHostActivationOverrides();
    expect(overrideOf(root)).toMatchObject({ state: "disabled", ownerPid: process.pid });
  });

  it("does remove a stale file (its owner has exited), in a managed and in an unmanaged folder", () => {
    const managed = makeFolder({ managed: true });
    const unmanaged = makeFolder({ managed: false });
    openFolders(managed, unmanaged);
    const gone = deadPid();
    plant(managed, record("disabled", gone));
    plant(unmanaged, record("native", gone));

    syncHostActivationOverrides();

    expect(existsSync(hostActivationOverridePath(managed))).toBe(false);
    expect(existsSync(hostActivationOverridePath(unmanaged))).toBe(false);
  });

  it("leaves a file it cannot prove is its own or stale: malformed, an unknown field, an unsupported schema", () => {
    const root = makeFolder({ managed: true });
    openFolders(root);
    for (const content of [
      "{ not json",
      JSON.stringify({ schemaVersion: 1, client: "vscode", state: "disabled", ownerPid: process.pid, updatedAt: "2026-10-02T09:00:00.000Z", extra: true }),
      JSON.stringify({ schemaVersion: 2, client: "vscode", state: "disabled", ownerPid: process.pid, updatedAt: "2026-10-02T09:00:00.000Z" }),
    ]) {
      const file = plant(root, content);
      syncHostActivationOverrides();
      expect(readFileSync(file, "utf8")).toBe(content);
    }
  });

  it("overwrites such a file when it has a state of its own to write", () => {
    const root = makeFolder({ managed: true });
    openFolders(root);
    plant(root, "{ not json");
    enabledByFolder.set(root, false);

    syncHostActivationOverrides();

    expect(overrideOf(root)).toMatchObject({ state: "disabled", ownerPid: process.pid });
  });

  it("removes the override of a folder it no longer hosts, but not another window's", () => {
    const root = makeFolder({ managed: true });
    const other = makeFolder({ managed: true });
    openFolders(root, other);
    enabledByFolder.set(root, false);
    enabledByFolder.set(other, false);
    syncHostActivationOverrides();
    expect(overrideOf(root)).toBeDefined();
    expect(overrideOf(other)).toBeDefined();
    // Another window takes over `other`'s file while this one still lists the folder.
    const foreign = record("disabled", process.ppid);
    const takenOver = plant(other, foreign);

    openFolders();
    syncHostActivationOverrides();

    expect(overrideOf(root)).toBeUndefined();
    expect(readFileSync(takenOver, "utf8")).toBe(foreign);
  });
});

describe("syncHostActivationOverrides — symlinks and failures", { timeout: UNIT_TIMEOUT_MS }, () => {
  it.skipIf(!symlinksWork())("never writes through a symlinked .tokenlighten directory", () => {
    const root = makeFolder({ managed: true });
    const elsewhere = mkdtempSync(join(tmpdir(), "tl-ext-elsewhere-"));
    folders.push(elsewhere);
    symlinkSync(elsewhere, join(root, ".tokenlighten"), "dir");
    openFolders(root);
    enabledByFolder.set(root, false);

    syncHostActivationOverrides();

    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it.skipIf(!symlinksWork())("never replaces or follows a symlinked override file", () => {
    const root = makeFolder({ managed: true });
    const elsewhere = mkdtempSync(join(tmpdir(), "tl-ext-elsewhere-"));
    folders.push(elsewhere);
    const real = join(elsewhere, "real.json");
    const content = record("disabled", process.pid);
    writeFileSync(real, content);
    mkdirSync(join(root, ".tokenlighten"));
    const link = hostActivationOverridePath(root);
    symlinkSync(real, link);
    openFolders(root);

    // Wanting a state: refused, and the target of the link is untouched.
    enabledByFolder.set(root, false);
    mockBypass.mockReturnValue(true);
    syncHostActivationOverrides();
    expect(readFileSync(real, "utf8")).toBe(content);
    // Wanting nothing: the link is neither followed nor removed, even though it points at "our" record.
    enabledByFolder.set(root, true);
    mockBypass.mockReturnValue(false);
    syncHostActivationOverrides();
    removeOwnHostActivationOverrides();
    expect(readFileSync(real, "utf8")).toBe(content);
    expect(statSync(real).isFile()).toBe(true);
    expect(existsSync(link)).toBe(true);
  });

  it("refuses, quietly, a .tokenlighten that is a regular file", () => {
    const root = makeFolder({ managed: true });
    writeFileSync(join(root, ".tokenlighten"), "not a directory");
    openFolders(root);
    enabledByFolder.set(root, false);

    expect(() => syncHostActivationOverrides()).not.toThrow();

    expect(readFileSync(join(root, ".tokenlighten"), "utf8")).toBe("not a directory");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a write failure once on the console and never throws",
    () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const root = makeFolder({ managed: true });
      mkdirSync(join(root, ".tokenlighten"));
      chmodSync(join(root, ".tokenlighten"), 0o500); // nothing can be created in it
      openFolders(root);
      enabledByFolder.set(root, false);

      expect(() => syncHostActivationOverrides()).not.toThrow();
      expect(() => syncHostActivationOverrides()).not.toThrow();

      expect(existsSync(hostActivationOverridePath(root))).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("TokenLighten: could not update the host activation override");
    },
  );
});

describe("removeOwnHostActivationOverrides — deactivate", { timeout: UNIT_TIMEOUT_MS }, () => {
  it("removes the overrides this window wrote, and nobody else's", () => {
    const mine = makeFolder({ managed: true });
    const theirs = makeFolder({ managed: true });
    openFolders(mine, theirs);
    enabledByFolder.set(mine, false);
    syncHostActivationOverrides();
    expect(overrideOf(mine)).toBeDefined();
    const foreignContent = record("native", process.ppid);
    const foreign = plant(theirs, foreignContent);

    removeOwnHostActivationOverrides();

    expect(existsSync(hostActivationOverridePath(mine))).toBe(false);
    expect(readFileSync(foreign, "utf8")).toBe(foreignContent);
  });

  it("also removes an override of this window's pid in a folder it never recorded (a previous activation's)", () => {
    const root = makeFolder({ managed: true });
    openFolders(root);
    plant(root, record("disabled", process.pid));

    removeOwnHostActivationOverrides();

    expect(existsSync(hostActivationOverridePath(root))).toBe(false);
  });

  it("does not throw without a workspace", () => {
    workspaceFolders.value = undefined;
    expect(() => removeOwnHostActivationOverrides()).not.toThrow();
  });
});

describe("registerHostActivation", { timeout: UNIT_TIMEOUT_MS }, () => {
  it("syncs once at registration and again on a tokenlighten.enabled change or a workspace-folder change, and nowhere else", () => {
    const first = makeFolder({ managed: true });
    openFolders(first);
    enabledByFolder.set(first, false);
    const context = { subscriptions: [] as unknown[] };

    registerHostActivation(context as never);

    // The initial sync ran.
    expect(overrideOf(first)?.["state"]).toBe("disabled");
    // The two listeners, and the heartbeat's disposable.
    expect(context.subscriptions).toHaveLength(3);
    const onConfiguration = (mockConfigurationChanged.mock.calls as unknown[][])[0]?.[0] as
      (event: { affectsConfiguration(section: string): boolean }) => void;
    const onFolders = (mockWorkspaceFoldersChanged.mock.calls as unknown[][])[0]?.[0] as () => void;

    // An unrelated setting: no sync (the file is not even re-read).
    enabledByFolder.set(first, true);
    onConfiguration({ affectsConfiguration: (section) => section === "editor.fontSize" });
    expect(overrideOf(first)?.["state"]).toBe("disabled");
    // The setting that matters.
    onConfiguration({ affectsConfiguration: (section) => section === "tokenlighten.enabled" });
    expect(overrideOf(first)).toBeUndefined();

    // A folder added to the window.
    const second = makeFolder({ managed: true });
    enabledByFolder.set(second, false);
    openFolders(first, second);
    onFolders();
    expect(overrideOf(second)?.["state"]).toBe("disabled");
  });
});

// Follow-up (2026-10-02): "owner pid alive" is satisfied by ANY live pid — init, an
// unrelated process, a reused pid, the pid a teammate's committed file names — so
// an override is live only while its file is also FRESH. The extension keeps its
// own file fresh with a heartbeat; these tests pin both halves of that, on fake
// timers and a fake clock (no waiting out the 90 s TTL).
describe("heartbeat and TTL — an override is only as good as its last refresh", { timeout: UNIT_TIMEOUT_MS }, () => {
  const T0 = Date.parse("2026-10-02T09:00:00.000Z");
  const DAY_MS = 24 * 60 * 60 * 1000;
  const iso = (ms: number): string => new Date(ms).toISOString();
  const newContext = () => ({ subscriptions: [] as Array<{ dispose(): void }> });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    removeOwnHostActivationOverrides();
    vi.useRealTimers();
  });

  it("rewrites this window's own file with a fresh updatedAt on the heartbeat, once the file is older than half the TTL", () => {
    // The heartbeat is due before half the TTL, and twice over it is past half the TTL.
    expect(HOST_ACTIVATION_HEARTBEAT_MS).toBeLessThanOrEqual(HOST_ACTIVATION_TTL_MS / 2);
    expect(2 * HOST_ACTIVATION_HEARTBEAT_MS).toBeGreaterThan(HOST_ACTIVATION_TTL_MS / 2);
    const root = makeFolder({ managed: true });
    openFolders(root);
    enabledByFolder.set(root, false);
    registerHostActivation(newContext() as never);
    const file = hostActivationOverridePath(root);
    expect(overrideOf(root)?.["updatedAt"]).toBe(iso(T0));
    const firstInode = statSync(file).ino;

    // One heartbeat in: the file is a heartbeat old, not yet half the TTL, and is left alone.
    vi.advanceTimersByTime(HOST_ACTIVATION_HEARTBEAT_MS);
    expect(overrideOf(root)?.["updatedAt"]).toBe(iso(T0));
    expect(statSync(file).ino).toBe(firstInode);

    // Two heartbeats in: past half the TTL, so this heartbeat rewrites it, atomically, with the current time.
    vi.advanceTimersByTime(HOST_ACTIVATION_HEARTBEAT_MS);
    expect(overrideOf(root)).toMatchObject({
      schemaVersion: 1,
      client: "vscode",
      state: "disabled",
      ownerPid: process.pid,
      updatedAt: iso(T0 + 2 * HOST_ACTIVATION_HEARTBEAT_MS),
    });
    expect(statSync(file).ino).not.toBe(firstInode);
    expect(readdirSync(join(root, ".tokenlighten"))).toEqual(["host-activation.json"]);
  });

  it("keeps the file inside the TTL for as long as the window runs: its age never reaches the TTL over ten minutes of heartbeats", () => {
    const root = makeFolder({ managed: true });
    openFolders(root);
    enabledByFolder.set(root, false);
    registerHostActivation(newContext() as never);

    for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += HOST_ACTIVATION_HEARTBEAT_MS) {
      vi.advanceTimersByTime(HOST_ACTIVATION_HEARTBEAT_MS);
      const ageMs = Date.now() - Date.parse(overrideOf(root)?.["updatedAt"] as string);
      expect(ageMs, `after ${elapsed + HOST_ACTIVATION_HEARTBEAT_MS} ms`).toBeLessThan(HOST_ACTIVATION_TTL_MS);
    }
  });

  it.each<[string, string, number]>([
    ["just written", "left alone", 0],
    ["a heartbeat old", "left alone", HOST_ACTIVATION_HEARTBEAT_MS],
    ["exactly half the TTL old", "left alone", HOST_ACTIVATION_TTL_MS / 2],
    ["a millisecond past half the TTL", "rewritten", HOST_ACTIVATION_TTL_MS / 2 + 1],
    ["past the TTL itself", "rewritten", HOST_ACTIVATION_TTL_MS + 1],
    ["stamped exactly the skew ahead of the clock", "left alone", -HOST_ACTIVATION_FUTURE_SKEW_MS],
    ["stamped a millisecond beyond the skew ahead of the clock (the clock stepped back)", "rewritten", -(HOST_ACTIVATION_FUTURE_SKEW_MS + 1)],
  ])("a sync leaves nothing to chance: this window's own file, %s, is %s", (_age, action, ageMs) => {
    const root = makeFolder({ managed: true });
    openFolders(root);
    enabledByFolder.set(root, false);
    const file = plant(root, record("disabled", process.pid, iso(T0 - ageMs)));
    const before = { text: readFileSync(file, "utf8"), ino: statSync(file).ino };

    syncHostActivationOverrides();

    if (action === "rewritten") {
      expect(overrideOf(root)).toMatchObject({ state: "disabled", ownerPid: process.pid, updatedAt: iso(T0) });
      expect(statSync(file).ino).not.toBe(before.ino);
    } else {
      expect({ text: readFileSync(file, "utf8"), ino: statSync(file).ino }).toEqual(before);
    }
  });

  it.each<[string, string, number]>([
    ["fresh", "kept", 0],
    ["exactly the TTL old", "kept", HOST_ACTIVATION_TTL_MS],
    ["a millisecond past the TTL", "removed", HOST_ACTIVATION_TTL_MS + 1],
    ["a day old", "removed", DAY_MS],
    ["stamped exactly the skew ahead of the clock", "kept", -HOST_ACTIVATION_FUTURE_SKEW_MS],
    ["stamped a millisecond beyond the skew ahead of the clock", "removed", -(HOST_ACTIVATION_FUTURE_SKEW_MS + 1)],
  ])("a file of another LIVE process, %s, is %s when this window wants TokenLighten on", (_age, outcome, ageMs) => {
    const root = makeFolder({ managed: true });
    openFolders(root); // tokenlighten.enabled stays true: this window wants nothing
    // The parent of the test process: alive, and not this process.
    expect(process.ppid).not.toBe(process.pid);
    expect(() => process.kill(process.ppid, 0)).not.toThrow();
    const file = plant(root, record("disabled", process.ppid, iso(T0 - ageMs)));

    syncHostActivationOverrides();

    expect(existsSync(file)).toBe(outcome === "kept");
  });

  it("removes such an aged-out file of a live process from a folder that is not managed, too", () => {
    const root = makeFolder({ managed: false });
    openFolders(root);
    const file = plant(root, record("native", process.ppid, iso(T0 - HOST_ACTIVATION_TTL_MS - 1)));

    syncHostActivationOverrides();

    expect(existsSync(file)).toBe(false);
  });

  it("never removes an aged-out file when this window itself wants TokenLighten off: it replaces it", () => {
    const root = makeFolder({ managed: true });
    openFolders(root);
    enabledByFolder.set(root, false);
    plant(root, record("native", process.ppid, iso(T0 - DAY_MS)));

    syncHostActivationOverrides();

    expect(overrideOf(root)).toMatchObject({ state: "disabled", ownerPid: process.pid, updatedAt: iso(T0) });
  });

  it("puts the file back on the next heartbeat when another window removed it", () => {
    const root = makeFolder({ managed: true });
    openFolders(root);
    enabledByFolder.set(root, false);
    registerHostActivation(newContext() as never);
    const file = hostActivationOverridePath(root);
    expect(existsSync(file)).toBe(true);

    // Window B, on the same folder, closes and removes the file that window A (this one) still wants.
    rmSync(file);
    vi.advanceTimersByTime(HOST_ACTIVATION_HEARTBEAT_MS - 1);
    expect(existsSync(file)).toBe(false); // not before the heartbeat is due

    vi.advanceTimersByTime(1);
    expect(overrideOf(root)).toMatchObject({
      state: "disabled",
      ownerPid: process.pid,
      updatedAt: iso(T0 + HOST_ACTIVATION_HEARTBEAT_MS),
    });
  });

  it("takes the file back on the next heartbeat when another live window overwrote it (last writer wins, every heartbeat)", () => {
    const root = makeFolder({ managed: true });
    openFolders(root);
    enabledByFolder.set(root, false);
    registerHostActivation(newContext() as never);

    plant(root, record("native", process.ppid, iso(T0)));
    expect(overrideOf(root)).toMatchObject({ state: "native", ownerPid: process.ppid });

    vi.advanceTimersByTime(HOST_ACTIVATION_HEARTBEAT_MS);
    expect(overrideOf(root)).toMatchObject({ state: "disabled", ownerPid: process.pid });
  });

  it("runs the heartbeat only while some managed folder wants a state, and never twice", () => {
    const managed = makeFolder({ managed: true });
    const unmanaged = makeFolder({ managed: false });
    openFolders(managed, unmanaged);
    registerHostActivation(newContext() as never);
    expect(vi.getTimerCount()).toBe(0); // nothing is wanted: no timer

    enabledByFolder.set(unmanaged, false);
    syncHostActivationOverrides();
    expect(vi.getTimerCount()).toBe(0); // an unmanaged folder is not this window's to keep fresh

    enabledByFolder.set(managed, false);
    syncHostActivationOverrides();
    expect(vi.getTimerCount()).toBe(1);
    syncHostActivationOverrides();
    syncHostActivationOverrides();
    expect(vi.getTimerCount()).toBe(1); // one heartbeat, however many syncs

    enabledByFolder.set(managed, true);
    syncHostActivationOverrides();
    expect(vi.getTimerCount()).toBe(0); // wanting nothing again ends it

    mockBypass.mockReturnValue(true); // the native-session bypass is a wanted state too
    syncHostActivationOverrides();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("re-reads the window's state on every beat: a missed settings event is repaired and the heartbeat ends itself", () => {
    const root = makeFolder({ managed: true });
    openFolders(root);
    enabledByFolder.set(root, false);
    registerHostActivation(newContext() as never);
    expect(overrideOf(root)).toBeDefined();
    expect(vi.getTimerCount()).toBe(1);

    enabledByFolder.set(root, true); // no onDidChangeConfiguration event is delivered
    vi.advanceTimersByTime(HOST_ACTIVATION_HEARTBEAT_MS);

    expect(existsSync(hostActivationOverridePath(root))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is cleared when the registered disposable runs, and when the window deactivates", () => {
    const root = makeFolder({ managed: true });
    openFolders(root);
    enabledByFolder.set(root, false);
    const context = newContext();
    registerHostActivation(context as never);
    expect(vi.getTimerCount()).toBe(1);

    // Disposing the subscriptions (the extension host shutting down) clears the interval.
    for (const subscription of context.subscriptions) subscription.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * HOST_ACTIVATION_HEARTBEAT_MS);
    expect(vi.getTimerCount()).toBe(0);

    // deactivate() clears it too, whichever of the two runs first.
    syncHostActivationOverrides();
    expect(vi.getTimerCount()).toBe(1);
    removeOwnHostActivationOverrides();
    expect(vi.getTimerCount()).toBe(0);
    expect(existsSync(hostActivationOverridePath(root))).toBe(false);
  });
});

// The two halves share no code, so the numbers they must agree on are compared
// from the server's source text (the server's own spec does the same against
// this file).
describe("the timing constants — in step with the server's copies", { timeout: UNIT_TIMEOUT_MS }, () => {
  const serverSource = readFileSync(
    resolve(__dirname, "..", "..", "..", "mcp-server", "src", "mcp", "hostActivation.ts"),
    "utf8",
  );
  function serverConstant(name: string): number {
    const match = new RegExp(`export const ${name} = ([0-9_]+);`).exec(serverSource);
    if (match === null) throw new Error(`${name} is not exported as a plain number from packages/mcp-server/src/mcp/hostActivation.ts`);
    return Number(match[1]!.replaceAll("_", ""));
  }

  it.each<[string, number]>([
    ["HOST_ACTIVATION_HEARTBEAT_MS", HOST_ACTIVATION_HEARTBEAT_MS],
    ["HOST_ACTIVATION_TTL_MS", HOST_ACTIVATION_TTL_MS],
    ["HOST_ACTIVATION_FUTURE_SKEW_MS", HOST_ACTIVATION_FUTURE_SKEW_MS],
  ])("%s is the same number on both sides", (name, extensionValue) => {
    expect(serverConstant(name)).toBe(extensionValue);
  });
});
