// startupWarmup.ts — pre-pay a fresh server process's first-task-pack costs in
// the idle time after the MCP handshake.
//
// WHY (measured 2026-10-10, built CLI over stdio, first tools/call in a fresh
// process, the two-file math.ts fixture): the first `read.task_pack` of a
// process took ~150 ms against ~26 ms for the same pack once the process had
// served one other. The gap is one-time cost, not work the pack needs: V8
// compiling the pipeline's functions and regular expressions on their first
// use, the tree-sitter runtime and a grammar instantiated and the parser's
// WASM functions compiled on the first parse, and the ICU collator
// initialised by the first `localeCompare`.
//
// WHAT. One pass, once per process, started from handleRequest's
// `notifications/initialized` (server.ts) — the client already holds the
// `initialize` result by then, so the handshake is never delayed:
//   1. ICU collation and normalisation (`localeCompare` orders every request
//      fingerprint; `normalize` every served path);
//   2. the tree-sitter runtime, then, for each of the workspace's (at most
//      three) most common tree-sitter languages, the grammar plus one parse
//      and symbol walk of a fixed snippet. The languages come from a bounded,
//      read-only listing of the workspace's directories (names only — no file
//      is opened, no symlink followed);
//   3. the request analyses a task pack runs on its query — profile binding,
//      facet and request-item extraction, identifier extraction — on fixed
//      sample requests.
//
// SAFETY. Nothing here can change a response byte. The snippets and requests
// are constants, and every function called is pure or a pure memo of a
// constant (the tree-sitter runtime and grammar caches, the request-item
// module's lazily built word sets). Nothing writes the state store, a journal,
// a ledger, a handle table, a usage or telemetry record or any file, and
// nothing is printed. Steps run one per macrotask (setImmediate between
// them), so a request that arrives mid-pass waits for at most one step, and
// the pass ends for good when the process's first tools/call begins: that
// call's own first use takes over wherever the pass stopped, sharing any
// tree-sitter load still in flight (skeleton/treeSitter.ts). A step's failure
// is swallowed — a warm-up error is never an outcome.
//
// TL_STARTUP_WARMUP=0 (util/flags.ts `startupWarmupEnabled`) turns it off.

import * as fs from "node:fs";
import * as path from "node:path";

import { startupWarmupEnabled } from "./flags.js";
import { languageForPath } from "./languages.js";
import { collectSymbols, symbolCollectorSupports } from "../symbols/collectSymbols.js";
import { getParserCtor } from "../skeleton/treeSitter.js";
import { autoBoundTaskProfile } from "../features/task-pack/readCodeTaskPack.js";
import { extractFacetRequirements, isStructuralOnlyRequest } from "../features/task-pack/requestFacets.js";
import { extractRequestItems } from "../features/task-pack/requestItems.js";
import { extractIdentifiers } from "../features/locator/locateTaskContext.js";

/** One unit of warm-up work; the pass yields to the event loop between steps. */
export interface WarmupStep {
  readonly name: string;
  readonly run: () => unknown;
}

/** At most this many languages get a grammar and a parse. */
export const WARMUP_MAX_LANGUAGES = 3;
/** The language listing stops after this many directory entries in total… */
export const WARMUP_MAX_LISTED_ENTRIES = 2000;
/** …and descends at most this many directory levels below the root. */
export const WARMUP_MAX_DEPTH = 3;

/** Directories that hold no source a request is about (and can be huge). */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules", "vendor", "dist", "build", "out", "target", "coverage",
  "__pycache__", "venv", "bin", "obj",
]);

/**
 * Fixed snippets: a declaration of each kind the symbol walker visits. A
 * language without one here parses a one-line comment-free stub, which still
 * instantiates its grammar and compiles the parser's entry functions.
 */
const SNIPPETS: Readonly<Record<string, string>> = {
  typescript: "import { join } from \"node:path\";\nexport const LIMIT = 3;\nexport interface Shape { size: number }\nexport class Box {\n  get(n: number): number { return n + LIMIT; }\n}\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n",
  typescriptreact: "import { join } from \"node:path\";\nexport const LIMIT = 3;\nexport function View(props: { n: number }) {\n  return <div>{props.n + LIMIT}</div>;\n}\n",
  javascript: "import { join } from \"node:path\";\nexport const LIMIT = 3;\nexport class Box {\n  get(n) { return n + LIMIT; }\n}\nexport function add(a, b) {\n  return a + b;\n}\n",
  javascriptreact: "export const LIMIT = 3;\nexport function View(props) {\n  return <div>{props.n + LIMIT}</div>;\n}\n",
  python: "import os\nLIMIT = 3\n\nclass Box:\n    def get(self, n):\n        return n + LIMIT\n\ndef add(a, b):\n    return a + b\n",
  go: "package m\n\nimport \"fmt\"\n\nconst Limit = 3\n\ntype Box struct{}\n\nfunc (b Box) Get(n int) int { return n + Limit }\n\nfunc Add(a, b int) int {\n\tfmt.Println(a)\n\treturn a + b\n}\n",
  rust: "use std::fmt;\npub const LIMIT: i32 = 3;\npub struct Bx;\nimpl Bx {\n    pub fn get(&self, n: i32) -> i32 { n + LIMIT }\n}\npub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n",
  ruby: "require \"json\"\nLIMIT = 3\nclass Box\n  def get(n)\n    n + LIMIT\n  end\nend\ndef add(a, b)\n  a + b\nend\n",
  java: "import java.util.List;\npublic class Box {\n  static final int LIMIT = 3;\n  int get(int n) { return n + LIMIT; }\n}\n",
  c: "#include <stdio.h>\n#define LIMIT 3\nint add(int a, int b) {\n  return a + b + LIMIT;\n}\n",
  cpp: "#include <vector>\nconst int LIMIT = 3;\nclass Box {\n public:\n  int get(int n) { return n + LIMIT; }\n};\nint add(int a, int b) { return a + b; }\n",
  csharp: "using System;\npublic class Box {\n  const int Limit = 3;\n  public int Get(int n) { return n + Limit; }\n}\n",
  php: "<?php\nconst LIMIT = 3;\nclass Box {\n  public function get($n) { return $n + LIMIT; }\n}\nfunction add($a, $b) { return $a + $b; }\n",
  kotlin: "import kotlin.math.max\nconst val LIMIT = 3\nclass Box {\n  fun get(n: Int): Int = n + LIMIT\n}\nfun add(a: Int, b: Int): Int = a + b\n",
};

/**
 * Fixed sample requests: an answer question naming a file, a change request,
 * an explanation with a relation, and the Japanese answer question — the
 * shapes the guide steers callers to.
 */
export const WARMUP_SAMPLE_REQUESTS: readonly string[] = [
  "What does the add function in src/math.ts return?",
  "Change MAX_RETRIES in src/retry.ts from 3 to 5.",
  "Explain how retryRequest handles a timeout and which functions call it.",
  "src/math.ts の add 関数は何を返しますか？",
];

/**
 * The workspace's most common tree-sitter languages by file count, most
 * common first (ties by name), from a bounded breadth-first listing of
 * directory NAMES under `root`. Dot entries, symlinks and SKIPPED_DIRECTORIES
 * are not entered; nothing is opened but directories. Never throws.
 */
export function likelyWorkspaceLanguages(root: string, max: number = WARMUP_MAX_LANGUAGES): string[] {
  const counts = new Map<string, number>();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let listed = 0;
  while (queue.length > 0 && listed < WARMUP_MAX_LISTED_ENTRIES) {
    const { dir, depth } = queue.shift()!;
    let handle: fs.Dir | undefined;
    try {
      handle = fs.opendirSync(dir);
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        listed += 1;
        if (listed > WARMUP_MAX_LISTED_ENTRIES) break;
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) {
          if (depth < WARMUP_MAX_DEPTH && !SKIPPED_DIRECTORIES.has(entry.name)) {
            queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const language = languageForPath(entry.name);
        if (language !== undefined && symbolCollectorSupports(language)) {
          counts.set(language, (counts.get(language) ?? 0) + 1);
        }
      }
    } catch {
      // An unreadable directory contributes nothing.
    } finally {
      try { handle?.closeSync(); } catch { /* already closed */ }
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .slice(0, Math.max(0, max))
    .map(([language]) => language);
}

/** The pass for `root`, in order. Exported for the spec; production runs it via scheduleStartupWarmup. */
export function startupWarmupSteps(root: string): WarmupStep[] {
  const steps: WarmupStep[] = [
    { name: "icu", run: () => ["b", "a"].sort((left, right) => left.localeCompare(right)).join("").normalize("NFC").normalize("NFKC") },
    { name: "tree-sitter-runtime", run: () => getParserCtor() },
  ];
  // Listed lazily, inside the pass, so the listing is a step of its own.
  let languages: string[] = [];
  steps.push({ name: "languages", run: () => { languages = likelyWorkspaceLanguages(root); } });
  for (let slot = 0; slot < WARMUP_MAX_LANGUAGES; slot += 1) {
    steps.push({
      name: `grammar-${slot}`,
      run: () => {
        const language = languages[slot];
        if (language === undefined) return undefined;
        return collectSymbols(SNIPPETS[language] ?? "x\n", language);
      },
    });
  }
  for (const request of WARMUP_SAMPLE_REQUESTS) {
    steps.push(
      { name: "profile", run: () => autoBoundTaskProfile(request) },
      { name: "facets", run: () => extractFacetRequirements(request) },
      { name: "structural", run: () => isStructuralOnlyRequest(request) },
      { name: "request-items", run: () => extractRequestItems(request) },
      { name: "identifiers", run: () => extractIdentifiers(request) },
    );
  }
  return steps;
}

let scheduled = false;
let stopped = false;
let finished: Promise<void> | undefined;

/**
 * The first tools/call has begun: run no further step. Idempotent and cheap —
 * callTool (server.ts) calls it on every call.
 */
export function noteToolCallStarted(): void {
  stopped = true;
}

/**
 * Start the pass for `root` on the next macrotask, once per process. A no-op
 * when TL_STARTUP_WARMUP is off, when a tools/call has already begun, or when
 * the pass was already scheduled.
 */
export function scheduleStartupWarmup(root: string): void {
  if (scheduled || stopped) return;
  scheduled = true;
  if (!startupWarmupEnabled()) return;
  finished = runStartupWarmup(startupWarmupSteps(root));
}

const nextMacrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Run `steps` one per macrotask until the list ends or a tools/call begins. Never rejects. */
export async function runStartupWarmup(
  steps: readonly WarmupStep[],
  shouldStop: () => boolean = () => stopped,
): Promise<void> {
  for (const step of steps) {
    await nextMacrotask();
    if (shouldStop()) return;
    try {
      await step.run();
    } catch {
      // A warm-up failure is never an outcome; the real call pays as before.
    }
  }
}

/** Test seam: the pass scheduled by scheduleStartupWarmup, if any (resolves when it ends). */
export function startupWarmupSettledForTest(): Promise<void> | undefined {
  return finished;
}

/** Test seam: forget the once-per-process latch. */
export function resetStartupWarmupForTest(): void {
  scheduled = false;
  stopped = false;
  finished = undefined;
}
