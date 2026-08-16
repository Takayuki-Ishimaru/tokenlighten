import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildCompactTree } from "../tools/exploreTree.js";
import { buildFindResponse, scanLiteral } from "../tools/findText.js";
import {
  discoverArtifactFiles,
  locateTaskContext,
  resetRootResolverCache,
} from "../tools/locateTaskContext.js";
import {
  buildTaskPack,
  isArtifactTaskPackSurface,
  resetPackDedupeCache,
  resetRoleInventoryCache,
  type TaskPackResultSurface,
} from "../tools/readCodeTaskPack.js";
import {
  ARTIFACT_EXTS,
  resetTokenlightenIgnoreCache,
  walkCodeFiles,
} from "../tools/walkRepo.js";
import { handleTable, shaOfBytes } from "../util/handles.js";
import { languageForPath } from "../util/languages.js";

const workspaces: string[] = [];

function workspace(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tl-artifact-${tag}-`));
  workspaces.push(dir);
  return dir;
}

function writeText(root: string, rel: string, text: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

function writeBytes(root: string, rel: string, bytes: Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

afterEach(() => {
  resetPackDedupeCache();
  resetRoleInventoryCache();
  resetRootResolverCache();
  resetTokenlightenIgnoreCache();
  for (const dir of workspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("WS4 artifact inventory", () => {
  it("keeps artifact extensions separate and tags directory and single-file opt-in walks", () => {
    const ws = workspace("walk");
    writeText(ws, "src/index.ts", "export const value = 1;\n");
    writeBytes(ws, "docs/rates.xlsx", Buffer.from("xlsx-bytes"));
    writeBytes(ws, "docs/spec.docx", Buffer.from("docx-bytes"));
    writeBytes(ws, "docs/slides.pptx", Buffer.from("pptx-bytes"));
    writeBytes(ws, "docs/report.pdf", Buffer.from("%PDF-1.4"));

    expect(ARTIFACT_EXTS).toEqual([".docx", ".xlsx", ".pptx", ".pdf", ".csv", ".tsv"]);
    expect(walkCodeFiles(ws).map((file) => file.relPath)).toEqual(["src/index.ts"]);

    const discovered = walkCodeFiles(ws, { includeArtifacts: true });
    expect(discovered.filter((file) => file.kind === "artifact").map((file) => file.ext)).toEqual([
      ".xlsx",
      ".pdf",
      ".pptx",
      ".docx",
    ]);
    expect(discovered.filter((file) => file.kind === "artifact").every((file) => file.language === "default")).toBe(true);

    const single = walkCodeFiles(ws, {
      subPath: "docs/rates.xlsx",
      includeArtifacts: true,
    });
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({
      relPath: "docs/rates.xlsx",
      ext: ".xlsx",
      language: "default",
      kind: "artifact",
    });

    expect(languageForPath("docs/rates.xlsx")).toBeUndefined();
  });

  it("tree includes find-level text files and office/PDF artifacts", () => {
    const ws = workspace("tree");
    writeText(ws, "docs/README.md", "# Guide\n");
    writeText(ws, "config/settings.yaml", "enabled: true\n");
    writeText(ws, "data/model.json", "{\"ok\":true}\n");
    writeBytes(ws, "docs/rate-table.xlsx", Buffer.from("xlsx-binary"));
    writeBytes(ws, "docs/brief.pdf", Buffer.from("%PDF-1.4"));

    const out = buildCompactTree(ws, undefined, 5);
    expect(out.tree).toContain("README.md");
    expect(out.tree).toContain("settings.yaml");
    expect(out.tree).toContain("model.json");
    expect(out.tree).toContain("rate-table.xlsx");
    expect(out.tree).toContain("brief.pdf");
  });

  it("find surfaces artifact filenames but never scans artifact bytes as UTF-8 content", () => {
    const ws = workspace("find");
    const trap = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe]),
      Buffer.from("BINARY_ARTIFACT_TRAP"),
    ]);
    writeBytes(ws, "docs/rate-table.xlsx", trap);
    writeText(ws, "src/index.ts", "export const ordinarySource = true;\n");

    expect(scanLiteral("BINARY_ARTIFACT_TRAP", ws, { includeArtifacts: true })).toEqual([]);

    const filenameResult = buildFindResponse({ query: "rate-table" }, ws);
    expect(filenameResult.total_matches).toBe(0);
    expect(filenameResult.did_you_mean).toContain("docs/rate-table.xlsx");

    const contentResult = buildFindResponse({ query: "BINARY_ARTIFACT_TRAP" }, ws);
    expect(contentResult.total_matches).toBe(0);
    expect(contentResult.files).toEqual([]);
  });

  it("dir-seeded and augmented task packs emit the strict artifact surface and reuse artifact file handles", async () => {
    const ws = workspace("pack");
    const bytes = Buffer.from("PK\u0003\u0004-rate-table-binary");
    writeBytes(ws, "docs/design/rate-table.xlsx", bytes);
    writeText(ws, "src/rating.ts", "export function calculateRate(): number { return 42; }\n");

    const seeded = await buildTaskPack(
      { query: "rate table workbook", paths: ["docs/design"] },
      ws,
    );
    const seededSurfaces = seeded.surfaces as TaskPackResultSurface[];
    const artifact = seededSurfaces.find(isArtifactTaskPackSurface);
    expect(artifact).toBeDefined();
    expect(Object.keys(artifact!).sort()).toEqual([
      "artifactKind",
      "basename",
      "extract",
      "handle",
      "kind",
      "path",
      "size",
    ]);
    expect(artifact).toEqual({
      path: "docs/design/rate-table.xlsx",
      basename: "rate-table.xlsx",
      kind: "artifact",
      artifactKind: "xlsx",
      size: bytes.byteLength,
      handle: artifact!.handle,
      extract: "read_file mode=artifact path=docs/design/rate-table.xlsx",
    });
    expect("code" in artifact!).toBe(false);

    const handle = handleTable.get(artifact!.handle);
    expect(handle).toMatchObject({
      kind: "file",
      path: "docs/design/rate-table.xlsx",
      workspaceRoot: ws,
      sha: shaOfBytes(bytes),
    });
    expect(handle?.range).toBeUndefined();

    const augmented = await buildTaskPack(
      { query: "change rate table workbook calculation" },
      ws,
    );
    const augmentedArtifact = (augmented.surfaces as TaskPackResultSurface[])
      .find(isArtifactTaskPackSurface);
    expect(augmentedArtifact?.path).toBe("docs/design/rate-table.xlsx");

    expect(discoverArtifactFiles(ws, { query: "rate table" }).map((file) => file.relPath))
      .toEqual(["docs/design/rate-table.xlsx"]);

    // Generic task vocabulary must not match infrastructure directories.
    // Before this guard, "pack" matched packages/ and attached this PDF.
    writeBytes(ws, "packages/mcp-server/src/__tests__/fixtures/encrypted-minimal.pdf", Buffer.from("%PDF-noise"));
    expect(discoverArtifactFiles(ws, { query: "trace task pack coverage" })).toEqual([]);
    // Query-token substrings must not admit semantically unrelated artifacts:
    // `closure` is not `disclosure`, and `handle` is not `handling`.
    writeBytes(ws, "docs/claim-handling-standards.pdf", Buffer.from("%PDF-noise"));
    writeBytes(ws, "docs/regulatory-disclosure.pdf", Buffer.from("%PDF-noise"));
    expect(discoverArtifactFiles(ws, {
      query: "trace task_pack content_sufficiency handle-first closure behavior",
    })).toEqual([]);
    const codeOnly = await buildTaskPack(
      { query: "fix task pack coverage behavior", paths: ["."] },
      ws,
    );
    expect((codeOnly.surfaces as TaskPackResultSurface[]).some(isArtifactTaskPackSurface)).toBe(false);
  });

  it("artifact prose that repeats real symbols does not perturb locator ranking", async () => {
    const plain = workspace("rank-plain");
    const withArtifact = workspace("rank-artifact");
    for (const ws of [plain, withArtifact]) {
      writeText(
        ws,
        "src/rating.ts",
        "export function calculatePremium(age: number): number { return age * 2; }\n",
      );
      writeText(
        ws,
        "src/other.ts",
        "export function unrelatedHelper(): number { return 0; }\n",
      );
    }
    writeBytes(
      withArtifact,
      "docs/calculatePremium.pdf",
      Buffer.from("%PDF-1.4 calculatePremium calculatePremium unrelatedHelper"),
    );

    const input = { action: "locate" as const, query: "calculatePremium", limit: 8 };
    const before = await locateTaskContext(plain, input);
    const after = await locateTaskContext(withArtifact, input);
    const normalize = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value, (key, item) => key === "handle" ? undefined : item));

    expect(normalize(after)).toEqual(normalize(before));
  });
});
