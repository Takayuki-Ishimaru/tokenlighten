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
          // v119-v128: compact says "TL unavailable/bypassed" (JP "TL不在・bypass"); full/medium keep "native-bypass".
          expect(agents).toMatch(/native-bypass|unavailable\/bypassed|TL不在・bypass/);
          expect(agents).toContain("SAFE-STOP");
          if (locale === "en") {
            expect(agents).toContain("<entire user request, verbatim>");
            // Compact first lookup uses the entire request verbatim, retaining its keywords, citations, and constraints.
            expect(agents).toContain("omit `targets`");
            // compact: "`evidence[].body` exact source: act on path/range, no reread."
            expect(agents).toMatch(/paths\/line ranges|act on path\/range/);
            expect(agents).toMatch(/without re-reading served bytes|no re-?read/);
            // v115: compact says "Native only if the user asks"; full/medium keep the older wording.
            // v119-v128: compact drops the article ("Native only if user asks").
            expect(agents).toMatch(/the user requests native|Native only if (?:the )?user asks/);
          } else {
            expect(agents).toContain("<依頼全文を逐語で>");
            // v119-v128: compact "引用/制約込みでquery逐語" replaces "キーワード化・引用/制約文の省略禁止".
            expect(agents).toMatch(/キーワード化・引用\/制約文の省略禁止|引用\/制約込みでquery逐語/);
            expect(agents).toMatch(/`targets`(?:を省略|省略)/);
            // compact: "`evidence[].body`正確なsource: path/rangeで行動、再読禁止"
            expect(agents).toMatch(/path\/行範囲|path\/rangeで行動/);
            expect(agents).toMatch(/再読せず|再読禁止/);
            expect(agents).toMatch(/user(?:がnativeを明示指定|のnative明示指定)|nativeはuser(?:の明示指定|明示)/);
          }
          expect((await injectAll(options)).wrote).toEqual([]);
        });
      }
    }
  }
});
