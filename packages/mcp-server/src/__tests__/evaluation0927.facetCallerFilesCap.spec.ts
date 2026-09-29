/**
 * evaluation0927.facetCallerFilesCap.spec.ts — eval-0927 review-r3 P2-13's
 * residual (genericMethodManyCallers / multilineSigManyCallers): once the
 * declaration resolved, 45 one-call caller files still ended the callers
 * facet `undetermined` with nothing left to read, because both facet caller
 * scans classified at most the shared 40-file MAX_CALLER_FILES_EXAMINED.
 *
 * The facet scans now classify up to MAX_FACET_CALLER_FILES_CLASSIFIED (128)
 * files, counted over WORD-BOUNDED mentions only, so a file that merely
 * contains the letters (`load` inside `download`) never spends the cap.
 * Past the cap the scan still reports `filesCapped`.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  callSitesForFocalMember,
  plainFunctionCallerSites,
  FileReadCache,
  FACET_CLOSURE_EMERGENCY_BUDGET_MS,
} from "../features/task-pack/readCodeTaskPack.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeWorkspace(): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-callcap-"));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function deadline(): number {
  return Date.now() + FACET_CLOSURE_EMERGENCY_BUDGET_MS;
}

/** A plain top-level `load` and `callers` files that each call it once. */
function plainLoadWorkspace(callers: number, substringOnly = 0): { ws: string; focalPath: string } {
  const ws = makeWorkspace();
  const focalPath = "src/loader.ts";
  writeFile(ws, focalPath, "export function load(key: string): string {\n  return key;\n}\n");
  for (let i = 0; i < callers; i++) {
    writeFile(ws, `src/callers/c${i}.ts`, `import { load } from "../loader";\n\nexport function use${i}(): string {\n  return load("k${i}");\n}\n`);
  }
  // Files that contain the LETTERS `load` but never the word: a substring
  // scan counted every one of them against the file cap.
  for (let i = 0; i < substringOnly; i++) {
    writeFile(ws, `src/other/o${i}.ts`, `export function download${i}(url: string): string {\n  return overload(url);\n}\nfunction overload(u: string): string { return u; }\n`);
  }
  return { ws, focalPath };
}

describe("P2-13 residual — facet caller scans classify past the shared 40-file bound", () => {
  it("45 one-call caller files of a plain function: every site is found, nothing capped", () => {
    const { ws, focalPath } = plainLoadWorkspace(45);
    const result = plainFunctionCallerSites("load", focalPath, {}, ws, new FileReadCache(), false, deadline());
    expect(result.complete).toBe(true);
    expect(result.filesCapped).toBeUndefined();
    expect(result.sites.length).toBe(45);
  });

  it("45 one-call caller files of a generic method (`http.fetchJson<T>(`): every site is found, nothing capped", () => {
    const ws = makeWorkspace();
    const focalPath = "src/http.ts";
    writeFile(ws, focalPath, "export class HttpClient {\n  async fetchJson<T>(pathname: string): Promise<T> {\n    return (await fetch(pathname)).json() as Promise<T>;\n  }\n}\n");
    for (let i = 0; i < 45; i++) {
      writeFile(ws, `src/features/f${i}.ts`, `import { HttpClient } from "../http";\n\nconst httpClient = new HttpClient();\n\nexport function load${i}(): Promise<string> {\n  return httpClient.fetchJson<string>("/v${i}");\n}\n`);
    }
    const result = callSitesForFocalMember(
      { path: focalPath, typeName: "HttpClient", member: "fetchJson" },
      {},
      ws,
      new FileReadCache(),
      false,
      deadline(),
    );
    expect(result.complete).toBe(true);
    expect(result.filesCapped).toBeUndefined();
    expect(result.sites.length).toBe(45);
  });

  it("files that only contain the letters (`download`, `overload`) never spend the cap: 3 real callers beside 140 substring-only files are all found, nothing capped", () => {
    const { ws, focalPath } = plainLoadWorkspace(3, 140);
    const result = plainFunctionCallerSites("load", focalPath, {}, ws, new FileReadCache(), false, deadline());
    expect(result.filesCapped).toBeUndefined();
    expect(result.sites.map((site) => site.path).sort()).toEqual(["src/callers/c0.ts", "src/callers/c1.ts", "src/callers/c2.ts"]);
  });

  it("more word-bounded caller files than the facet cap: still reported as filesCapped (disclosed undetermined), never silently complete", () => {
    const { ws, focalPath } = plainLoadWorkspace(130);
    const result = plainFunctionCallerSites("load", focalPath, {}, ws, new FileReadCache(), false, deadline());
    expect(result.filesCapped).toBe(true);
    expect(result.sites.length).toBe(128);
  });

  it("a member that is not plain ASCII word characters keeps the substring scan (Unicode identifier)", () => {
    const ws = makeWorkspace();
    const focalPath = "src/maße.ts";
    writeFile(ws, focalPath, "export function größe(n: number): number {\n  return n;\n}\n");
    writeFile(ws, "src/use.ts", "import { größe } from \"./maße\";\n\nexport const x = größe(3);\n");
    const result = plainFunctionCallerSites("größe", focalPath, {}, ws, new FileReadCache(), false, deadline());
    expect(result.sites.map((site) => `${site.path}:${site.line}`)).toEqual(["src/use.ts:3"]);
  });
});
