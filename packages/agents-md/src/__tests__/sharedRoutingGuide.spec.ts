import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectAll } from "../injectAll.js";
import { INSTRUCTIONS_VERSION } from "../render.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Test the installed instruction route, including Claude's import and user
// text preservation. Wording delivery cannot certify live model adoption.
describe("r12: shared routing reaches Codex and Claude without a second guide copy", () => {
  for (const locale of ["en", "jp"] as const) {
    for (const profile of ["full", "medium", "compact"] as const) {
      for (const toolSurface of ["full", "code"] as const) {
        it(`${locale}/${profile}/${toolSurface}: delivers verbatim discovery and exact-source reuse`, async () => {
          const root = mkdtempSync(join(tmpdir(), "tl-shared-routing-"));
          roots.push(root);
          writeFileSync(join(root, "AGENTS.md"), "# Project rules\nKeep my build command.\n");
          writeFileSync(join(root, "CLAUDE.md"), "# Claude preferences\nKeep my language preference.\n");
          const options = { repoRoot: root, locale, profile, toolSurface, targets: ["claude" as const] };
          await injectAll(options);
          const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
          const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
          expect(agents).toContain("Keep my build command.");
          expect(claude).toContain("Keep my language preference.");
          expect(claude).toContain("@AGENTS.md");
          expect(claude).toContain(INSTRUCTIONS_VERSION);
          expect(claude).not.toContain("evidence[].body");
          expect(agents).not.toContain("mcp__tokenlighten_");
          expect(agents).toContain("task:{epoch:\"new\"}");
          expect(agents).toContain("evidence[].body");
          expect(agents).toContain("targets:[");
          expect(agents).toContain("task.force_serve:true");
          expect(agents).toContain("native-bypass");
          expect(agents).toContain("SAFE-STOP");
          if (locale === "en") {
            expect(agents).toContain("<entire user request, verbatim>");
            expect(agents).toContain("keywords");
            expect(agents).toContain("citation/constraint sentences");
            expect(agents).toContain("omit `targets`");
            expect(agents).toContain("paths/line ranges");
            expect(agents).toMatch(/without re-reading served bytes|no re-read/);
            expect(agents).toContain("the user requests native");
          } else {
            expect(agents).toContain("<依頼全文を逐語で>");
            expect(agents).toContain("キーワード化・引用/制約文の省略禁止");
            expect(agents).toMatch(/`targets`(?:を省略|省略)/);
            expect(agents).toContain("path/行範囲");
            expect(agents).toContain("再読せず");
            expect(agents).toMatch(/user(?:がnativeを明示指定|のnative明示指定)/);
          }
          expect((await injectAll(options)).wrote).toEqual([]);
        });
      }
    }
  }
});
