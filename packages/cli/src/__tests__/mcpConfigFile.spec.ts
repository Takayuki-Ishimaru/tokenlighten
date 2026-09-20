import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  readManagedEntry,
  removeManagedEntry,
  writeManagedEntry,
} from "../mcpConfigFile.js";

function tmpFile(name = "mcp-config.json"): string {
  const dir = join(tmpdir(), `tl-mcp-config-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

const MANAGED_ENTRY = {
  type: "local",
  command: "/tl/bin/node",
  args: ["/tl/bin/tl.js", "mcp", "start", "--stdio", "--allow-write"],
  env: { TOKENLIGHTEN_MANAGED: "1" },
  tools: ["*"],
};

describe("mcpConfigFile", () => {
  describe("writeManagedEntry", () => {
    it("creates the file and rootKey when neither exists", () => {
      const file = tmpFile();
      const result = writeManagedEntry({
        file,
        rootKey: "mcpServers",
        name: "tokenlighten",
        entry: MANAGED_ENTRY,
      });
      expect(result.ok).toBe(true);
      expect(result).toMatchObject({ ok: true, action: "created" });
      const written = JSON.parse(readFileSync(file, "utf8"));
      expect(written.mcpServers.tokenlighten).toEqual(MANAGED_ENTRY);
      // 2-space indent + trailing newline.
      const raw = readFileSync(file, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw).toContain('  "mcpServers"');
    });

    it("preserves other keys, their order, and updates an existing managed entry in place", () => {
      const file = tmpFile();
      writeFileSync(
        file,
        `${JSON.stringify(
          { zAlpha: 1, mcpServers: { other: { command: "foo" }, tokenlighten: { ...MANAGED_ENTRY, args: ["old"] } }, aBeta: 2 },
          null,
          2,
        )}\n`,
      );
      const result = writeManagedEntry({
        file,
        rootKey: "mcpServers",
        name: "tokenlighten",
        entry: MANAGED_ENTRY,
      });
      expect(result).toMatchObject({ ok: true, action: "updated" });
      const raw = readFileSync(file, "utf8");
      const doc = JSON.parse(raw);
      expect(Object.keys(doc)).toEqual(["zAlpha", "mcpServers", "aBeta"]);
      expect(Object.keys(doc.mcpServers)).toEqual(["other", "tokenlighten"]);
      expect(doc.mcpServers.other).toEqual({ command: "foo" });
      expect(doc.mcpServers.tokenlighten).toEqual(MANAGED_ENTRY);
    });

    it("refuses a file that fails strict JSON.parse (comments/trailing commas)", () => {
      const file = tmpFile();
      writeFileSync(file, '{\n  // a comment\n  "mcpServers": {},\n}\n');
      const result = writeManagedEntry({
        file,
        rootKey: "mcpServers",
        name: "tokenlighten",
        entry: MANAGED_ENTRY,
      });
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ refused: true, code: "invalid-json" });
      // Refusal must not touch the file.
      expect(readFileSync(file, "utf8")).toContain("// a comment");
    });

    it("refuses to overwrite a non-managed same-name entry without force", () => {
      const file = tmpFile();
      writeFileSync(file, `${JSON.stringify({ mcpServers: { tokenlighten: { command: "someone-elses" } } }, null, 2)}\n`);
      const result = writeManagedEntry({
        file,
        rootKey: "mcpServers",
        name: "tokenlighten",
        entry: MANAGED_ENTRY,
      });
      expect(result).toMatchObject({ ok: false, refused: true, code: "foreign-entry" });
      const doc = JSON.parse(readFileSync(file, "utf8"));
      expect(doc.mcpServers.tokenlighten).toEqual({ command: "someone-elses" });
    });

    it("overwrites a foreign entry when force is true", () => {
      const file = tmpFile();
      writeFileSync(file, `${JSON.stringify({ mcpServers: { tokenlighten: { command: "someone-elses" } } }, null, 2)}\n`);
      const result = writeManagedEntry({
        file,
        rootKey: "mcpServers",
        name: "tokenlighten",
        entry: MANAGED_ENTRY,
        force: true,
      });
      expect(result).toMatchObject({ ok: true, action: "updated" });
      const doc = JSON.parse(readFileSync(file, "utf8"));
      expect(doc.mcpServers.tokenlighten).toEqual(MANAGED_ENTRY);
    });

    it("checks the args prefix, not just the marker, when expectedArgsPrefix is given", () => {
      const file = tmpFile();
      writeFileSync(
        file,
        `${JSON.stringify({
          mcpServers: { tokenlighten: { command: "/old/node", args: ["/old/tl.js", "mcp", "start"], env: { TOKENLIGHTEN_MANAGED: "1" } } },
        }, null, 2)}\n`,
      );
      const refused = writeManagedEntry({
        file,
        rootKey: "mcpServers",
        name: "tokenlighten",
        entry: MANAGED_ENTRY,
        expectedArgsPrefix: ["/tl/bin/tl.js", "mcp", "start", "--stdio"],
      });
      // The TOKENLIGHTEN_MANAGED marker alone is not enough when an
      // expectedArgsPrefix is supplied: a shorter/different args array
      // (stale identity) must still refuse as foreign, not silently pass.
      expect(refused).toMatchObject({ ok: false, refused: true, code: "foreign-entry" });
    });

    it("backs up the file once, before the first write, and never again", () => {
      const file = tmpFile();
      const original = `${JSON.stringify({ mcpServers: {}, keep: "me" }, null, 2)}\n`;
      writeFileSync(file, original);
      const backupPath = `${file}.tl-backup`;

      const first = writeManagedEntry({ file, rootKey: "mcpServers", name: "tokenlighten", entry: MANAGED_ENTRY });
      expect(first).toMatchObject({ ok: true, backupFile: backupPath });
      expect(existsSync(backupPath)).toBe(true);
      expect(readFileSync(backupPath, "utf8")).toBe(original);

      const second = writeManagedEntry({
        file,
        rootKey: "mcpServers",
        name: "tokenlighten",
        entry: { ...MANAGED_ENTRY, args: [...MANAGED_ENTRY.args, "--tool-surface", "code"] },
      });
      expect(second).toMatchObject({ ok: true, action: "updated" });
      expect("backupFile" in second ? second.backupFile : undefined).toBeUndefined();
      // The pristine backup must still reflect the ORIGINAL file, not the
      // first managed write.
      expect(readFileSync(backupPath, "utf8")).toBe(original);
    });

    it("does not back up a file that did not exist before this write", () => {
      const file = tmpFile();
      const result = writeManagedEntry({ file, rootKey: "mcpServers", name: "tokenlighten", entry: MANAGED_ENTRY });
      expect(result).toMatchObject({ ok: true, action: "created" });
      expect(existsSync(`${file}.tl-backup`)).toBe(false);
    });

    it("reports code:'symlink-target' (not 'unsafe-path') when the parent directory is a symlink", () => {
      if (process.platform === "win32") return;
      const realDir = join(tmpdir(), `tl-mcp-config-real-${randomUUID()}`);
      mkdirSync(realDir, { recursive: true });
      const linkedDir = join(tmpdir(), `tl-mcp-config-link-${randomUUID()}`);
      symlinkSync(realDir, linkedDir, "dir");
      const file = join(linkedDir, "mcp-config.json");
      const result = writeManagedEntry({ file, rootKey: "mcpServers", name: "tokenlighten", entry: MANAGED_ENTRY });
      expect(result).toMatchObject({ ok: false, refused: true, code: "symlink-target" });
    });

    it("reports code:'not-json' when the rootKey already holds a non-object value", () => {
      const file = tmpFile();
      writeFileSync(file, JSON.stringify({ mcpServers: "not-an-object" }));
      const result = writeManagedEntry({ file, rootKey: "mcpServers", name: "tokenlighten", entry: MANAGED_ENTRY });
      expect(result).toMatchObject({ ok: false, refused: true, code: "not-json" });
    });

    it("reports code:'parent-missing' when an ancestor path segment is a regular file, not a directory", () => {
      const blockerDir = join(tmpdir(), `tl-mcp-config-blocker-${randomUUID()}`);
      mkdirSync(blockerDir, { recursive: true });
      const blockerFile = join(blockerDir, "not-a-directory");
      writeFileSync(blockerFile, "x");
      const file = join(blockerFile, "sub", "mcp-config.json");
      const result = writeManagedEntry({ file, rootKey: "mcpServers", name: "tokenlighten", entry: MANAGED_ENTRY });
      expect(result).toMatchObject({ ok: false, refused: true, code: "parent-missing" });
    });
  });

  describe("readManagedEntry", () => {
    it("reports exists:false when the file is absent", () => {
      const file = tmpFile();
      const result = readManagedEntry({ file, rootKey: "mcpServers", name: "tokenlighten" });
      expect(result).toEqual({ exists: false, managed: false });
    });

    it("flags parseError instead of throwing on invalid JSON", () => {
      const file = tmpFile();
      writeFileSync(file, "{not json,}");
      const result = readManagedEntry({ file, rootKey: "mcpServers", name: "tokenlighten" });
      expect(result.parseError).toBe(true);
    });

    it("distinguishes managed from foreign by the TOKENLIGHTEN_MANAGED marker", () => {
      const file = tmpFile();
      writeFileSync(file, `${JSON.stringify({ mcpServers: { tokenlighten: MANAGED_ENTRY } }, null, 2)}\n`);
      expect(readManagedEntry({ file, rootKey: "mcpServers", name: "tokenlighten" })).toMatchObject({
        exists: true,
        managed: true,
      });

      const foreignFile = tmpFile();
      writeFileSync(foreignFile, `${JSON.stringify({ mcpServers: { tokenlighten: { command: "foo" } } }, null, 2)}\n`);
      expect(readManagedEntry({ file: foreignFile, rootKey: "mcpServers", name: "tokenlighten" })).toMatchObject({
        exists: true,
        managed: false,
      });
    });
  });

  describe("removeManagedEntry", () => {
    it("reports action:'absent' when there is nothing to remove", () => {
      const file = tmpFile();
      const result = removeManagedEntry({ file, rootKey: "mcpServers", name: "tokenlighten" });
      expect(result).toMatchObject({ ok: true, action: "absent" });
    });

    it("removes a managed entry and preserves sibling keys", () => {
      const file = tmpFile();
      writeFileSync(
        file,
        `${JSON.stringify({ mcpServers: { other: { command: "foo" }, tokenlighten: MANAGED_ENTRY } }, null, 2)}\n`,
      );
      const result = removeManagedEntry({ file, rootKey: "mcpServers", name: "tokenlighten" });
      expect(result).toMatchObject({ ok: true, action: "removed" });
      const doc = JSON.parse(readFileSync(file, "utf8"));
      expect(doc.mcpServers).toEqual({ other: { command: "foo" } });
    });

    it("refuses to remove a foreign entry without force", () => {
      const file = tmpFile();
      writeFileSync(file, `${JSON.stringify({ mcpServers: { tokenlighten: { command: "someone-elses" } } }, null, 2)}\n`);
      const result = removeManagedEntry({ file, rootKey: "mcpServers", name: "tokenlighten" });
      expect(result).toMatchObject({ ok: false, refused: true, code: "foreign-entry" });
      const doc = JSON.parse(readFileSync(file, "utf8"));
      expect(doc.mcpServers.tokenlighten).toEqual({ command: "someone-elses" });
    });

    it("removes a foreign entry when force is true", () => {
      const file = tmpFile();
      writeFileSync(file, `${JSON.stringify({ mcpServers: { tokenlighten: { command: "someone-elses" } } }, null, 2)}\n`);
      const result = removeManagedEntry({ file, rootKey: "mcpServers", name: "tokenlighten", force: true });
      expect(result).toMatchObject({ ok: true, action: "removed" });
    });

    it("refuses on invalid JSON instead of throwing", () => {
      const file = tmpFile();
      writeFileSync(file, "{not json,}");
      const result = removeManagedEntry({ file, rootKey: "mcpServers", name: "tokenlighten" });
      expect(result).toMatchObject({ ok: false, refused: true, code: "invalid-json" });
    });
  });
});
