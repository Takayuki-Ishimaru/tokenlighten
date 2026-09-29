/**
 * evaluation0927.r9aCallers.spec.ts — R9-A (round-9 wave, 2026-09-29):
 * regression coverage for review-findings-fable-r8.md's P1-4
 * (defaultExportedGeneratorCaller/defaultExportedLongJsdocCaller/
 * defaultExportedCloserLineCaller: `focalIsSoleDefaultExport` must recognize
 * a generator's own default export, skip a doc comment of ANY length bounded
 * by the focal's own `endLine` rather than a flat 40-line cap, and test a
 * closer-line header from its own code, never the raw `*\/ export default...`
 * line — plus a decorator argument STRING must not derail the header walk's
 * paren/bracket balancing), P1-5 (pyFstringTripleLineStartCaller: an
 * f-string triple quote's interior is never a confident docstring — `{…}`
 * fields are code), P1-6 (rustRawStringSlashStarCaller: a Rust raw string's
 * own `/*` never opens a real block comment, in both the file-level and
 * single-line scans) and P1-9 (rustMatchArmConstConditionWhen: "When does
 * X …" / "How does X …" / "Why does X …" / "What default … does X use"
 * phrasings must resolve the SAME declaring focal as "Under what condition
 * does X …", never a caller elsewhere that merely mentions X's name).
 *
 * THE ROUND-9 LESSON: root-caused, not shape-patched. P1-9's actual cause
 * lives in `features/locator/locateTaskContext.ts`, not in anything
 * Rust- or phrasing-specific: Layer 3's exact-text search for a name that
 * ALSO has a Layer-2 symbol hit at the SAME line (almost always the name's
 * OWN declaration) loses that occurrence to the same-line dedup
 * (`candidates.some(c => c.path === m.path && c.line === m.line)`), so
 * `uniqueExactText`/`distinctivePrimary` can read "this text occurs in
 * exactly one place in the workspace" when it truly occurs in two — an
 * unrelated file whose only connection is an incidental CALL/mention of the
 * same text then wins the "unique exact text" shortcut outright, and the
 * file that actually DECLARES the name is never even considered (never
 * disclosed, never `related`). Fixed by counting matched PATHS from the raw
 * match list (before the same-line dedup), never from the post-dedup
 * candidate pool — the locator's layering has no per-language branch, so
 * this is reproduced here in two languages, five phrasings each.
 *
 * Every fixture is written FRESH against the DESCRIBED defect class —
 * `processJob`/`MAX_RETRIES`/`ProcessJob`, never the reviewer's own
 * `request`/`RETRY_LIMIT`/`formatBytes` identifiers or file names.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  followNextToEnd,
  startDevServer,
  type ChainResult,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";
import { focalIsSoleDefaultExport } from "../features/task-pack/readCodeTaskPack.js";
import {
  blockCommentLineStates,
  maskNonCode,
  findCallOccurrences,
} from "../features/task-pack/callerExpansion.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
});
afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

// =====================================================================
// PART 1 -- pure unit matrix (no server)
// =====================================================================

describe("A1 -- focalIsSoleDefaultExport: generator exports, an endLine-bounded doc comment, a closer-line header, a string-bearing decorator argument", () => {
  const M = "processJob";

  it("`export default function* M` (generator) is recognized", () => {
    const lines = ["export default function* processJob() {", "  yield 1;", "}"];
    expect(focalIsSoleDefaultExport(lines, 1, M)).toBe(true);
  });
  it("`export default async function* M` (async generator) is recognized", () => {
    const lines = ["export default async function* processJob() {", "  yield 1;", "}"];
    expect(focalIsSoleDefaultExport(lines, 1, M)).toBe(true);
  });
  it("`function *M` (space before the star, none after) is recognized", () => {
    const lines = ["export default function *processJob() {", "}"];
    expect(focalIsSoleDefaultExport(lines, 1, M)).toBe(true);
  });
  it("CJS `module.exports = function* M` (generator) is recognized", () => {
    const lines = ["module.exports = function* processJob() {", "  yield 1;", "};"];
    expect(focalIsSoleDefaultExport(lines, 1, M)).toBe(true);
  });
  it("a JSDoc longer than the old 40-line bound is fully skippable when it fits the focal's own endLine", () => {
    const doc = ["/**", " * Processes one queued job.", " *"];
    for (let i = 1; i <= 50; i++) doc.push(` * @example line ${i}: a reviewer note`);
    doc.push(" */");
    const lines = [...doc, "export default function processJob(job) {", "  return job;", "}"];
    expect(focalIsSoleDefaultExport(lines, 1, M, lines.length)).toBe(true);
  });
  it("a closer line carrying the header itself (`*/ export default function M`) is tested from its own code", () => {
    const lines = ["/**", " * Processes one queued job.", " */ export default function processJob(job) {", "  return job;", "}"];
    expect(focalIsSoleDefaultExport(lines, 1, M)).toBe(true);
  });
  it("a decorator argument STRING containing `)` does not derail the header walk (string-aware balancing)", () => {
    const lines = ["@Logged(", "  \")\"", ")", "export default class ProcessJob {", "}"];
    expect(focalIsSoleDefaultExport(lines, 1, "ProcessJob")).toBe(true);
  });
  it("a decorator argument STRING containing `(` also does not derail it", () => {
    const lines = ["@Logged('(')", "export default class ProcessJob {", "}"];
    expect(focalIsSoleDefaultExport(lines, 1, "ProcessJob")).toBe(true);
  });
  it("control -- an ordinary multi-line decorator with no string argument still balances correctly (unaffected)", () => {
    const lines = ["@Component({", "  selector: 'x',", "})", "export default class ProcessJob {", "}"];
    expect(focalIsSoleDefaultExport(lines, 1, "ProcessJob")).toBe(true);
  });
  it("control -- CJS `module.exports = function M` behind a doc comment is unaffected", () => {
    const lines = ["/**", " * doc", " */", "module.exports = function processJob(job) {", "  return job;", "};"];
    expect(focalIsSoleDefaultExport(lines, 1, M)).toBe(true);
  });
  it("control -- a documented declaration of a DIFFERENT name never matches", () => {
    const lines = ["/** doc */", "export default function otherJob(job) {", "  return job;", "}"];
    expect(focalIsSoleDefaultExport(lines, 1, M)).toBe(false);
  });
  it("control -- an ordinary NAMED export is never mistaken for a default export", () => {
    const lines = ["export function processJob(job) {", "  return job;", "}"];
    expect(focalIsSoleDefaultExport(lines, 1, M)).toBe(false);
  });
  it("an unresolved header (no code line within the focal's own short endLine) is UNPROVEN, never a false non-default", () => {
    const lines = [
      "/**",
      " * doc that never closes within this focal's own short range",
      "export default function processJob(job) {",
      "  return job;",
      "}",
    ];
    // endLine=2 -- the doc comment's own closer never appears within the
    // focal's own recorded range, so declarationHeaderLine finds no header
    // at all. The safe direction is `true` (never proven non-default), not
    // the old `false` (which used to certify a false
    // `request-item-empty:callers`).
    expect(focalIsSoleDefaultExport(lines, 1, M, 2)).toBe(true);
  });
  it("still never walks PAST the focal's own endLine into an unrelated declaration below it (no internal cap does not mean no cap at all)", () => {
    const lines = [
      "/**",
      " * Some unrelated doc paragraph.",
      " */",
      "function unrelatedHelper() {}",
      "",
      "export default function processJob(job) {",
      "  return job;",
      "}",
    ];
    // The focal's OWN range ends at line 4 (`unrelatedHelper`, a SEPARATE
    // declaration) -- even with no internal line cap, the scan must never
    // walk past the caller-supplied endLine.
    expect(focalIsSoleDefaultExport(lines, 1, M, 4)).toBe(false);
  });
  it("a long run of unrelated leading `//` comments, with NO endLine bound supplied, now resolves the real header below them (round-9 change: no internal 40-line cap)", () => {
    const filler = Array.from({ length: 45 }, (_, i) => `// filler line ${i}`);
    const lines = [...filler, "export default function processJob(job) {", "  return job;", "}"];
    // `endLine` defaults to `lines.length` -- the WHOLE array is, as far as
    // this call knows, the focal's own range, so walking through 45 lines
    // of harmless comment noise to reach the real declaration is correct
    // (see the PREVIOUS test for the actual protection this module keeps:
    // an explicit, smaller `endLine` still stops the walk cold).
    expect(focalIsSoleDefaultExport(lines, 1, M)).toBe(true);
  });
});

describe("A2 -- an f-string triple quote's interior is never a confident docstring (interpolated code, not prose)", () => {
  it("`f\"\"\"` at line start: the interior line is masked but NOT confident (kept as a mention, never dropped)", () => {
    const lines = ["x = (", "    f\"\"\"", "    {process_job(total)}", "    \"\"\"", ")"];
    const st = blockCommentLineStates(lines, "app/report.py");
    expect(st.masked[2]).toBe(true);
    expect(st.confident[2]).toBe(false);
  });
  it("`rf\"\"\"` (raw f-string, r-then-f order) interior is equally non-confident", () => {
    const lines = ["x = (", "    rf\"\"\"", "    {process_job(total)}", "    \"\"\"", ")"];
    const st = blockCommentLineStates(lines, "app/report.py");
    expect(st.confident[2]).toBe(false);
  });
  it("`Fr'''` (f-then-r order, mixed case) interior is equally non-confident", () => {
    const lines = ["x = (", "    Fr'''", "    {process_job(total)}", "    '''", ")"];
    const st = blockCommentLineStates(lines, "app/report.py");
    expect(st.confident[2]).toBe(false);
  });
  it("`FR\"\"\"` (both uppercase) interior is equally non-confident", () => {
    const lines = ["x = (", "    FR\"\"\"", "    {process_job(total)}", "    \"\"\"", ")"];
    const st = blockCommentLineStates(lines, "app/report.py");
    expect(st.confident[2]).toBe(false);
  });
  it("control -- a bare (non-f) `r\"\"\"` raw triple-quote interior stays CONFIDENT (inert text, no interpolation)", () => {
    const lines = ["x = (", "    r\"\"\"", "    literal process_job(total) text", "    \"\"\"", ")"];
    const st = blockCommentLineStates(lines, "app/report.py");
    expect(st.confident[2]).toBe(true);
  });
  it("control -- an unprefixed `\"\"\"` docstring interior stays CONFIDENT (unaffected)", () => {
    const lines = ["def f():", "    \"\"\"", "    Usage: process_job(total)", "    \"\"\"", "    pass"];
    const st = blockCommentLineStates(lines, "app/report.py");
    expect(st.confident[2]).toBe(true);
  });
  it("control -- a MID-line f-string opener (`msg = f\"\"\"`) was already non-confident before this fix", () => {
    const lines = ["msg = f\"\"\"", "    {process_job(total)}", "\"\"\""];
    const st = blockCommentLineStates(lines, "app/report.py");
    expect(st.confident[1]).toBe(false);
  });
});

describe("A3 -- a Rust raw string's own `/*` never opens a real block comment (interior masked, never confidently dropped)", () => {
  it("a line-start `/*` inside a hash-delimited raw string never masks the rest of the file", () => {
    const lines = [
      "const TEMPLATE: &str = r#\"",
      "/* generated, do not edit",
      "\"#;",
      "pub fn process_job() -> i32 { compute_total(2) }",
    ];
    const st = blockCommentLineStates(lines, "src/report.rs");
    expect(st.masked[1]).toBe(true);
    expect(st.confident[1]).toBe(false); // interior: a mention, never dropped
    expect(st.masked[3]).toBe(false); // real code after the closer: fully classifiable
  });
  it("a MID-line `/*` inside the same shape behaves identically (real code after the closer stays classifiable)", () => {
    const lines = [
      "const TEMPLATE: &str = r#\"",
      "x /* generated, do not edit",
      "\"#;",
      "pub fn process_job() -> i32 { compute_total(2) }",
    ];
    const st = blockCommentLineStates(lines, "src/report.rs");
    expect(st.masked[1]).toBe(true);
    expect(st.masked[3]).toBe(false);
  });
  it("a `br#\"...\"#` byte-raw string with a `/*` inside is inert across lines too", () => {
    const lines = ["const T: &[u8] = br#\"", "/* not a comment */", "\"#;", "fn process_job() { compute_total(2); }"];
    const st = blockCommentLineStates(lines, "src/report.rs");
    expect(st.masked[3]).toBe(false);
  });
  it("a hash-delimited raw string with an EMBEDDED bare quote does not leak its content as a false call site (single-line scan)", () => {
    // Rust raw strings have NO escapes: `r#"...`'s content can hold a bare
    // `"` freely -- only `"#` closes it. The OLD generic (escape-unaware,
    // hash-blind) quote mechanism closed at the FIRST bare `"`, leaking
    // `compute_total(9)` (still inside the string) as live, unblanked code.
    const masked = maskNonCode('let s = r#"say "compute_total(9)""#; compute_total(2);', false, "src/report.rs");
    const occ = findCallOccurrences(masked, "compute_total");
    expect(occ.length).toBe(1); // only the REAL call after the string
  });
  it("a zero-hash raw string `r\"...\"` still closes at the first bare quote (no hash needed)", () => {
    const masked = maskNonCode('let s = r"a /* b"; compute_total(2);', false, "src/report.rs");
    const occ = findCallOccurrences(masked, "compute_total");
    expect(occ.length).toBe(1);
  });
  it("control -- an ordinary Rust char literal (`'a'`) and a lifetime (`'static`) are both unaffected by the new `r`/`b` opener check", () => {
    const masked = maskNonCode("let c: char = 'a'; let x: &'static str = compute_total(2);", false, "src/report.rs");
    const occ = findCallOccurrences(masked, "compute_total");
    expect(occ.length).toBe(1);
  });
  it("control -- Go's own backtick raw string (a DIFFERENT extension gate) is unaffected by the Rust-only opener check", () => {
    const lines = ["q := `", "select 1", "` + computeTotal(1)"];
    const st = blockCommentLineStates(lines, "src/report.go");
    expect(st.masked[2]).toBe(false);
  });
});

// =====================================================================
// PART 2 -- end-to-end wiring (one server per workspace / language)
// =====================================================================

function makeWorkspace(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r9a-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function spawnedServer(ws: string): Promise<ServerHandle> {
  const s = startDevServer(ws, "default");
  servers.push(s);
  await s.initialize();
  return s;
}

async function askOn(s: ServerHandle, ws: string, query: string, hopCap = 20): Promise<ChainResult> {
  return followNextToEnd(s, { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } }, { cwd: ws, hopCap });
}

async function ask(ws: string, query: string, hopCap = 20): Promise<ChainResult> {
  const s = await spawnedServer(ws);
  return askOn(s, ws, query, hopCap);
}

function finalDecisionKind(chain: ChainResult): unknown {
  const finalHop = chain.hops[chain.hops.length - 1]!;
  return (finalHop.response?.["decision"] as Record<string, unknown> | undefined)?.["kind"];
}

/** Every served body (evidence + top-level content) across every hop, concatenated. */
function allBodies(chain: ChainResult): string {
  const parts: string[] = [];
  for (const h of chain.hops) {
    const body = h.response as Record<string, unknown> | undefined;
    if (typeof body?.["content"] === "string") parts.push(body["content"] as string);
    for (const e of (body?.["evidence"] as Array<Record<string, unknown>> | undefined) ?? []) {
      if (typeof e["body"] === "string") parts.push(e["body"] as string);
    }
  }
  return parts.join("\n");
}

describe("A1 end-to-end -- a generator's own default export is served, never dropped to empty", () => {
  it("`export default function* processJob` reached via its importer's OWN binding name", async () => {
    const ws = makeWorkspace("a1-generator");
    writeFile(ws, "package.json", '{ "name": "r9a-a1-gen", "private": true, "type": "module" }\n');
    writeFile(ws, "src/jobs.ts", "export default function* processJob() {\n  yield 1;\n}\n");
    writeFile(ws, "src/main.ts", "import run from \"./jobs\";\n\nexport function main(): unknown {\n  return run();\n}\n");
    const chain = await ask(ws, "Who calls processJob?");
    expect(["act.answer", "discover"]).toContain(finalDecisionKind(chain));
    const gaps = chain.hops.map((h) => JSON.stringify((h.response?.["decision"] as Record<string, unknown> | undefined)?.["certificate"] ?? {})).join(" | ");
    expect(gaps).not.toContain("request-item-empty:callers:processJob (0 call sites");
  });
});

describe("A2 end-to-end -- a real call inside an f-string triple-quote field is disclosed, never certified empty", () => {
  it("`f\"\"\"{process_job(total)}\"\"\"` at line start", async () => {
    const ws = makeWorkspace("a2-fstring");
    writeFile(ws, "pyproject.toml", "[project]\nname = \"app\"\n");
    writeFile(ws, "app/__init__.py", "");
    writeFile(ws, "app/jobs.py", "def process_job(n):\n    return n * 2\n\n\ndef helper1(n):\n    return n + 1\n");
    writeFile(ws, "app/report.py", "from .jobs import process_job\n\n\ndef summarize(total):\n    return (\n        f\"\"\"\n        Total: {process_job(total)}\n        \"\"\"\n    )\n");
    writeFile(ws, "app/main.py", "from .report import summarize\n\nprint(summarize(2048))\n");
    const chain = await ask(ws, "Who calls process_job?");
    const gaps = chain.hops.map((h) => JSON.stringify((h.response?.["decision"] as Record<string, unknown> | undefined)?.["certificate"] ?? {})).join(" | ");
    expect(gaps).not.toContain("request-item-empty:callers:process_job (0 call sites");
    expect(["act.answer", "discover"]).toContain(finalDecisionKind(chain));
  });
});

describe("A3 end-to-end -- a real call after a Rust raw string containing `/*` is disclosed, never certified empty", () => {
  it("`r#\"\\n/* generated\\n\"#` followed by the real call", async () => {
    const ws = makeWorkspace("a3-rawstring");
    writeFile(ws, "Cargo.toml", "[package]\nname = \"cli\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    writeFile(ws, "src/main.rs", "mod jobs;\nmod report;\n\nfn main() {\n    println!(\"{}\", report::summarize(2048));\n}\n");
    writeFile(ws, "src/jobs.rs", "pub fn process_job(n: u64) -> String {\n    format!(\"{}\", n * 2)\n}\n");
    writeFile(ws, "src/report.rs", "use crate::jobs::process_job;\n\nconst TEMPLATE: &str = r#\"\n/* generated file\n   do not edit\n\"#;\n\npub fn summarize(total: u64) -> String {\n    format!(\"{}{}\", TEMPLATE, process_job(total))\n}\n");
    const chain = await ask(ws, "Who calls process_job?");
    const gaps = chain.hops.map((h) => JSON.stringify((h.response?.["decision"] as Record<string, unknown> | undefined)?.["certificate"] ?? {})).join(" | ");
    expect(gaps).not.toContain("request-item-empty:callers:process_job (0 call sites");
    expect(["act.answer", "discover"]).toContain(finalDecisionKind(chain));
  });
});

// ---------------------------------------------------------------------------
// A4 -- the focal a question NAMES must win for every facet phrasing, in
// two languages (Rust and Go), never lose to an incidental caller/mention
// file via the locator's "unique exact text" shortcut.
// ---------------------------------------------------------------------------

const A4_PHRASINGS = [
  "When does {fn} stop retrying?",
  "How does {fn} decide to stop retrying?",
  "Why does {fn} give up?",
  "Under what condition does {fn} give up?",
  "What default retry limit does {fn} use?",
];

describe("A4 -- the function a question NAMES wins the focal for every phrasing (never the caller file)", () => {
  it("Rust: main.rs merely CALLS process_job; jobs.rs DECLARES it and holds MAX_RETRIES", async () => {
    const ws = makeWorkspace("a4-rust");
    writeFile(ws, "Cargo.toml", "[package]\nname = \"cli\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    writeFile(ws, "src/main.rs", "mod jobs;\n\nfn main() {\n    println!(\"{:?}\", jobs::process_job(\"/p/1\"));\n}\n");
    writeFile(
      ws,
      "src/jobs.rs",
      "const MAX_RETRIES: u32 = 4;\n\npub fn process_job(url: &str) -> Option<String> {\n    let mut attempt = 0;\n    loop {\n        match attempt {\n            MAX_RETRIES => return None,\n            _ => attempt += 1,\n        }\n        if !url.is_empty() {\n            return Some(url.to_string());\n        }\n    }\n}\n",
    );
    const s = await spawnedServer(ws);
    for (const template of A4_PHRASINGS) {
      const query = template.replace("{fn}", "process_job");
      const chain = await askOn(s, ws, query);
      // The declaring file's own constant is the proof the RIGHT focal was
      // reached -- main.rs (the caller) never mentions MAX_RETRIES at all,
      // so its presence in the served bodies can only come from jobs.rs.
      expect(allBodies(chain)).toContain("MAX_RETRIES");
    }
  });

  it("Go: cmd/main.go merely CALLS ProcessJob; pkg/jobs declares it and holds MaxRetries", async () => {
    const ws = makeWorkspace("a4-go");
    writeFile(ws, "go.mod", "module example.com/r9a\n\ngo 1.22\n");
    writeFile(
      ws,
      "cmd/main.go",
      "package main\n\nimport (\n\t\"fmt\"\n\n\t\"example.com/r9a/pkg/jobs\"\n)\n\nfunc main() {\n\tfmt.Println(jobs.ProcessJob(\"/p/1\"))\n}\n",
    );
    writeFile(
      ws,
      "pkg/jobs/jobs.go",
      "package jobs\n\nconst MaxRetries = 4\n\nfunc ProcessJob(url string) string {\n\tattempt := 0\n\tfor {\n\t\tif attempt == MaxRetries {\n\t\t\treturn \"\"\n\t\t}\n\t\tattempt++\n\t\tif url != \"\" {\n\t\t\treturn url\n\t\t}\n\t}\n}\n",
    );
    const s = await spawnedServer(ws);
    for (const template of A4_PHRASINGS) {
      const query = template.replace("{fn}", "ProcessJob");
      const chain = await askOn(s, ws, query);
      expect(allBodies(chain)).toContain("MaxRetries");
    }
  });
});
