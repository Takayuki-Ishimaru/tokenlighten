import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIAG_RING_MAX_CALLS,
  diagRingFilePath,
  diagWorkspaceKey,
  readDiagRingFile,
  recordDiagCall,
  type DiagRingCall,
} from "../diagRing.js";

function tmp(prefix: string): string {
  const dir = join(tmpdir(), `tokenlighten-${prefix}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const baseCall: DiagRingCall = {
  at: "2026-08-22T00:00:00.000Z",
  tool: "read_file",
  mode: "task_pack",
  kind: "read.task_pack",
  ms: 12,
  ok: true,
};

describe("diagWorkspaceKey", () => {
  it("matches sha256(realpath).slice(0,16) computed independently", () => {
    const root = tmp("key-root");
    const expected = createHash("sha256")
      .update(realpathSync.native(root), "utf8")
      .digest("hex")
      .slice(0, 16);
    expect(diagWorkspaceKey(root)).toBe(expected);
    expect(diagWorkspaceKey(root)).toHaveLength(16);
  });

  it("is stable across a symlink to the same real directory", () => {
    const parent = tmp("key-symlink");
    const real = join(parent, "real");
    const link = join(parent, "link");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    expect(diagWorkspaceKey(link)).toBe(diagWorkspaceKey(real));
  });

  it("differs for two distinct workspace roots", () => {
    const a = tmp("key-a");
    const b = tmp("key-b");
    expect(diagWorkspaceKey(a)).not.toBe(diagWorkspaceKey(b));
  });
});

describe("recordDiagCall / readDiagRingFile", () => {
  it("writes the documented shape at <directory>/<key>.json", () => {
    const root = tmp("shape-root");
    const directory = tmp("shape-diag");
    recordDiagCall({
      workspaceRoot: root,
      serverVersion: "0.11.0",
      serverBuild: "2026-08-22T08:54:46.000Z-6447649a",
      call: baseCall,
      directory,
    });

    const filePath = diagRingFilePath(root, directory);
    const onDisk = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(onDisk["v"]).toBe(1);
    expect(onDisk["workspace_key"]).toBe(diagWorkspaceKey(root));
    expect(onDisk["server_version"]).toBe("0.11.0");
    expect(onDisk["server_build"]).toBe("2026-08-22T08:54:46.000Z-6447649a");
    expect(typeof onDisk["pid"]).toBe("number");
    expect(typeof onDisk["updated_at"]).toBe("string");
    expect(onDisk["calls"]).toEqual([baseCall]);

    const parsed = readDiagRingFile(root, directory);
    expect(parsed).toEqual(onDisk);
  });

  it("caps the ring at DIAG_RING_MAX_CALLS, evicting the oldest first", () => {
    const root = tmp("cap-root");
    const directory = tmp("cap-diag");
    const total = DIAG_RING_MAX_CALLS + 5;
    for (let i = 0; i < total; i += 1) {
      recordDiagCall({
        workspaceRoot: root,
        serverVersion: "0.11.0",
        directory,
        call: { ...baseCall, at: `2026-08-22T00:00:${String(i).padStart(2, "0")}.000Z`, ms: i },
      });
    }
    const ring = readDiagRingFile(root, directory);
    expect(ring?.calls).toHaveLength(DIAG_RING_MAX_CALLS);
    // The oldest 5 (ms 0..4) were evicted; the ring keeps the most recent run.
    expect(ring?.calls[0]?.ms).toBe(total - DIAG_RING_MAX_CALLS);
    expect(ring?.calls[ring.calls.length - 1]?.ms).toBe(total - 1);
  });

  it("never embeds the workspace root path or free-text call fields on disk", () => {
    const root = tmp("secret-customer-repository-path");
    const directory = tmp("privacy-diag");
    recordDiagCall({
      workspaceRoot: root,
      serverVersion: "0.11.0",
      directory,
      call: {
        ...baseCall,
        // Simulate a caller that failed to sanitize upstream — these must be
        // dropped, not embedded verbatim, once they exceed the short-token cap.
        kind: `read.task_pack-${"x".repeat(200)}`,
        error_code: `refusal-code-${"y".repeat(200)}`,
      },
    });
    const raw = readFileSync(diagRingFilePath(root, directory), "utf8");
    expect(raw).not.toContain(root);
    expect(raw).not.toContain("secret-customer-repository-path");
    expect(raw).not.toContain("x".repeat(200));
    expect(raw).not.toContain("y".repeat(200));
  });

  it("retains only token-like retry and argument-name field metadata", () => {
    const root = tmp("retry-field-root");
    const directory = tmp("retry-field-diag");
    recordDiagCall({
      workspaceRoot: root,
      serverVersion: "0.11.0",
      directory,
      call: { ...baseCall, ok: false, retry: "new-task", field: "edits[2].search" },
    });
    expect(readDiagRingFile(root, directory)?.calls[0]).toMatchObject({
      retry: "new-task",
      field: "edits[2].search",
    });
  });

  it("writes atomically at mode 0600 and leaves no tmp file behind", () => {
    const root = tmp("atomic-root");
    const directory = tmp("atomic-diag");
    recordDiagCall({ workspaceRoot: root, serverVersion: "0.11.0", call: baseCall, directory });
    const filePath = diagRingFilePath(root, directory);
    const stat = statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
    const entries = readdirSync(directory);
    expect(entries.filter((name) => name.includes(".tmp"))).toHaveLength(0);
  });

  it("readDiagRingFile returns null for a missing or corrupt file, never throws", () => {
    const root = tmp("missing-root");
    const directory = tmp("missing-diag");
    expect(readDiagRingFile(root, directory)).toBeNull();

    mkdirSync(directory, { recursive: true });
    writeFileSync(diagRingFilePath(root, directory), "{ not json", { mode: 0o600 });
    expect(readDiagRingFile(root, directory)).toBeNull();
  });

  it("recordDiagCall swallows a non-existent workspace root instead of throwing", () => {
    const directory = tmp("nonexistent-diag");
    expect(() =>
      recordDiagCall({
        workspaceRoot: join(directory, "does-not-exist"),
        serverVersion: "0.11.0",
        call: baseCall,
        directory,
      }),
    ).not.toThrow();
  });
});
