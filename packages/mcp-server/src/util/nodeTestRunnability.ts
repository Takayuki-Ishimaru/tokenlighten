/**
 * nodeTestRunnability.ts — can a package's `npm test` run in this checkout WITHOUT installing anything?
 *
 * Rule: a test script is runnable when an installed node_modules tree (or a Yarn PnP loader — the caller
 * treats both as "installed") is reachable — the caller walks the package directory and its ancestors
 * inside the workspace, so hoisted monorepo installs count — or when the package declares nothing to
 * install AND every command the script invokes is available from plain Node / shell builtins, resolving
 * `npm run <x>` / `npm test` / `yarn [run] <x>` / `pnpm [run] <x>` chains to the script they actually run
 * rather than treating the runner itself as a builtin regardless of its target.
 *
 * WHY NOT "node_modules exists": that was the previous rule (verificationPack.ts `detectTestEntry` and
 * readCodeTaskPack.ts `buildVerificationVerdict`). A zero-dependency package whose script is
 * `node --test tests/runtime.test.mjs` runs fine with no install at all, yet was reported as
 * "dependencies not installed — verify by diff review" (external v0.14.3 evaluation, 2026-09-27 §6.2):
 * the agent was told not to run a test that passes. "Not run yet" and "cannot run" are different facts.
 *
 * WHY "not-determinable" exists (same evaluation, finding #18(c)): the ancestor walk is bounded to the
 * workspace by construction (this module never sees the filesystem at all — see below — and its caller
 * never reads outside the pinned workspace). A monorepo member opened directly as the workspace root hides
 * its install one level above that boundary; asserting "dependencies not installed" there is a second false
 * claim of the same shape the zero-dependency fix above corrects, just pointed the other way. The caller
 * signals this with `ambiguousAboveWorkspaceRoot`, computed from one bounded, content-free existence peek
 * at the workspace root's own parent (verificationPack.ts `installEvidenceJustAboveWorkspaceRoot`).
 *
 * Conservative by construction: an executable this module does not recognise (a pipe into `tee`, a
 * global `vitest`, `npx …`) keeps the old "not runnable without install" verdict unless node_modules is
 * reachable. Pure: no fs, no process, no env; never throws.
 *
 * `sh`/`bash` are NOT blanket builtins (external v0.14.3 evaluation round 2, finding P2-14): `sh -c
 * "<cmd>"` / `bash -c "<cmd>"` classify the inner command the same way an `npm run` target is resolved
 * below, but `sh script.sh` / `bash build.sh` / a bare `./x.sh` execute file contents this module never
 * reads — that is "indeterminate", not "no install needed" (the previous bug: both forms were plain
 * BUILTIN entries, so ANY sh/bash invocation, including one wrapping an uninstalled package binary, was
 * certified install-free) and not "dependencies not installed" either (a confident negative this module
 * cannot back up). `classifyNodeTestRunnability` folds per-segment verdicts with `combineAll`: any
 * indeterminate segment makes the whole script indeterminate rather than a false confident verdict in
 * either direction.
 *
 * First drafted as an EVO-X2 work package (2026-09-27), reviewed and adapted here.
 */

export interface NodePackageManifestLike {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
}

export type NodeTestRunnabilityReason =
  | "node-modules-present"
  | "no-install-needed"
  | "dependencies-not-installed"
  | "not-determinable"
  | "no-test-script";

export interface NodeTestRunnability {
  runnable: boolean;
  reason: NodeTestRunnabilityReason;
}

/** Shell builtins / always-present commands. `node`, `npm`, `env`, `sh` and `bash` are handled by
 * `classifyExecutable` before this set is ever consulted. */
const BUILTIN: ReadonlySet<string> = new Set([
  "echo", "true", "false", "exit", "cd", "test", "printf", "set", "export",
]);
/** A path ending in a shell-script extension, invoked directly (`./build.sh`, `scripts/test.sh`, a bare
 * `test.sh` on PATH) — contents this module never reads, so it is indeterminate rather than builtin. */
const SHELL_SCRIPT_EXT_RE = /\.(?:sh|bash)$/i;
/** `npm <sub>` that only runs scripts of this package — never an install/download (`ci`, `install`, `exec`) — used only as the fallback when `scriptChainTarget` cannot name a resolvable script (e.g. bare `npm run` with no argument). */
const NPM_SCRIPT_SUBCOMMANDS: ReadonlySet<string> = new Set(["test", "t", "run", "run-script"]);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A lone `(`, `)`, `{` or `}` word (or a run of them) at a segment's edge — shell grouping, never a real executable. */
const PURE_GROUPING_RE = /^[(){}]+$/;
/** Cycle/depth guard for `npm run`/`yarn`/`pnpm` script-chain resolution — generous for any real package.json. */
const MAX_SCRIPT_CHAIN_DEPTH = 8;

/** Split on unquoted `&&`, `||`, `;`, `|` (quotes, with backslash escapes inside double quotes, respected). */
function splitSegments(script: string): string[] {
  const out: string[] = [];
  let seg = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    if (quote === "'") {
      seg += ch;
      if (ch === "'") quote = null;
    } else if (quote === '"') {
      if (ch === "\\" && i + 1 < script.length) seg += ch + script[++i];
      else {
        seg += ch;
        if (ch === '"') quote = null;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      seg += ch;
    } else if (ch === "\\" && i + 1 < script.length) {
      seg += ch + script[++i];
    } else if ((ch === "&" && script[i + 1] === "&") || (ch === "|" && script[i + 1] === "|")) {
      out.push(seg);
      seg = "";
      i++;
    } else if (ch === ";" || ch === "|") {
      out.push(seg);
      seg = "";
    } else seg += ch;
  }
  out.push(seg);
  return out;
}

/** Whitespace-separated words with quotes/escapes resolved. */
function tokenize(segment: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
    } else if (quote === '"') {
      if (ch === "\\" && i + 1 < segment.length) word += segment[++i];
      else if (ch === '"') quote = null;
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === "\\" && i + 1 < segment.length) {
      word += segment[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      word += ch;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/** Basename without extension: `./node_modules/.bin/vitest` -> `vitest`, `node.exe` -> `node`. */
function basenameNoExt(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Basename WITH extension kept: `./scripts/run.sh` -> `run.sh` (for `SHELL_SCRIPT_EXT_RE`). */
function rawBasename(command: string): string {
  return command.split(/[\\/]/).pop() ?? command;
}

function isOption(word: string): boolean {
  return word.startsWith("-") && word.length > 1;
}

/** The words of one command segment starting at its executable (leading `NAME=value` and `(`/`{` stripped). */
function commandWords(segment: string): string[] {
  const words = tokenize(segment);
  if (words.length > 0) {
    const stripped = words[0]!.replace(/^[({]+/, "");
    if (stripped === "") words.shift();
    else words[0] = stripped;
  }
  // Shell grouping (`{ cmd; }`, `( cmd )`) tokenizes its closing brace/paren as its own trailing word once
  // `splitSegments` lands it alone or at a segment's tail — never a real executable (external v0.14.3
  // evaluation, 2026-09-27 §6.2, finding #18(d): `{ node --test; }` reported `}` as an "executable").
  while (words.length > 0 && PURE_GROUPING_RE.test(words[words.length - 1]!)) words.pop();
  let i = 0;
  while (i < words.length && ENV_ASSIGN.test(words[i]!)) i++;
  return i < words.length ? words.slice(i) : words;
}

/**
 * The executables (first word of each command segment) the test script invokes, in order, after stripping
 * leading `NAME=value` assignments; an `env` wrapper reports the command it wraps. Exported for tests.
 */
export function scriptExecutables(script: string): string[] {
  const executables: string[] = [];
  for (const segment of splitSegments(script)) {
    let words = commandWords(segment);
    if (words.length > 0 && basenameNoExt(words[0]!) === "env") {
      let j = 1;
      while (j < words.length && (ENV_ASSIGN.test(words[j]!) || isOption(words[j]!))) j++;
      words = j < words.length ? words.slice(j) : ["env"];
    }
    if (words.length > 0) executables.push(basenameNoExt(words[0]!));
  }
  return executables;
}

/**
 * `npm test`/`npm t`/`npm run <x>`/`npm run-script <x>`/`yarn [run] <x>`/`pnpm [run] <x>` -> the
 * package.json script name it would invoke, else `undefined` (not a script-chain shape at all — `npm ci`,
 * `yarn install`, `pnpm add foo`). Existence in `manifest.scripts` is checked once, uniformly, by the
 * caller (`classifyExecutable`) rather than here, so `yarn <name>` where `<name>` is not a declared script
 * falls through the same way it always did (never builtin) instead of gaining a second, differently-shaped
 * check.
 */
function scriptChainTarget(words: readonly string[]): string | undefined {
  const command = basenameNoExt(words[0] ?? "");
  if (command === "npm") {
    const sub = words[1];
    if (sub === "test" || sub === "t") return "test";
    if ((sub === "run" || sub === "run-script") && typeof words[2] === "string") return words[2];
    return undefined;
  }
  if (command === "yarn" || command === "pnpm") {
    const name = words[1] === "run" ? words[2] : words[1];
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

/** One command segment's classification: `builtin` needs no install, `not-builtin` conservatively does
 * (an unrecognised executable, or a resolvable chain target that fails outright), `indeterminate` means
 * this module cannot tell either way (opaque script-file contents) — never collapsed into `not-builtin`,
 * which would be a confident negative it cannot back up. */
type ExecVerdict = "builtin" | "not-builtin" | "indeterminate";

/** Folds a command chain's (or a resolved script's) per-segment verdicts: any segment whose content is
 * unknown makes the WHOLE chain indeterminate — never a confident "not installed" just because one
 * segment happened to also fail the builtin check — otherwise every segment must be builtin. */
function combineAll(verdicts: readonly ExecVerdict[]): ExecVerdict {
  if (verdicts.some((v) => v === "indeterminate")) return "indeterminate";
  return verdicts.every((v) => v === "builtin") ? "builtin" : "not-builtin";
}

/**
 * `visited` seeds with the top-level script name being classified (always `"test"`, from
 * `classifyNodeTestRunnability`) so a chain that loops back to it — directly or through any number of
 * intermediate scripts — is rejected as non-builtin instead of recursing forever; `depth` is a second,
 * independent bound for a long acyclic chain. External v0.14.3 evaluation, 2026-09-27 §6.2, finding
 * #18(a): `npm run <x>` / `yarn <x>` / `pnpm <x>` were previously treated as builtin unconditionally,
 * without checking what `<x>` actually runs — so a script requiring an uninstalled package (`vitest run`)
 * behind an `npm run` indirection was reported as needing no install at all.
 */
function classifyExecutable(
  words: readonly string[],
  scripts: Readonly<Record<string, unknown>> | undefined,
  visited: ReadonlySet<string>,
  depth: number,
): ExecVerdict {
  const raw = words[0] ?? "";
  const command = basenameNoExt(raw);
  if (command === "node") return "builtin";
  if (command === "env") {
    for (let i = 1; i < words.length; i++) {
      if (!ENV_ASSIGN.test(words[i]!) && !isOption(words[i]!)) return classifyExecutable(words.slice(i), scripts, visited, depth);
    }
    return "builtin"; // bare `env` only prints the environment
  }
  if (command === "sh" || command === "bash") {
    // `sh -c "<cmd>"` / `bash -c "<cmd>"` run the given string as a script — classify what it actually
    // invokes, the same way an `npm run` target is resolved below (round-2 evaluation finding P2-14).
    // Anything else (`sh build.sh`, `bash scripts/test.sh`, and a bare `./x.sh` caught by
    // `SHELL_SCRIPT_EXT_RE` further down) executes a file this module never reads: honestly
    // indeterminate. Previously `sh`/`bash` were unconditional BUILTIN entries, so ANY invocation —
    // including one wrapping an uninstalled package binary — was certified install-free.
    const cIndex = words.indexOf("-c");
    const inline = cIndex >= 0 ? words[cIndex + 1] : undefined;
    if (typeof inline !== "string") return "indeterminate";
    return combineAll(
      splitSegments(inline).map((segment) => {
        const segmentWords = commandWords(segment);
        return segmentWords.length === 0 ? "builtin" : classifyExecutable(segmentWords, scripts, visited, depth + 1);
      }),
    );
  }
  if (command === "npm" || command === "yarn" || command === "pnpm") {
    const target = scriptChainTarget(words);
    if (target === undefined) {
      // No resolvable script-chain target (`npm ci`, `yarn install`, bare `npm run`): npm's own
      // script-running subcommands keep their old unconditional allowance; yarn/pnpm without a target
      // name are never builtin, same as before this function knew about script chains at all.
      return command === "npm" && words[1] !== undefined && NPM_SCRIPT_SUBCOMMANDS.has(words[1]) ? "builtin" : "not-builtin";
    }
    if (visited.has(target) || depth >= MAX_SCRIPT_CHAIN_DEPTH) return "not-builtin"; // cycle or too-deep — conservative
    const targetScript = scripts?.[target];
    if (typeof targetScript !== "string" || targetScript.trim() === "") return "not-builtin"; // undeclared/blank — this would fail at runtime, not run for free
    const nextVisited = new Set(visited);
    nextVisited.add(target);
    return combineAll(
      splitSegments(targetScript).map((segment) => {
        const segmentWords = commandWords(segment);
        return segmentWords.length === 0 ? "builtin" : classifyExecutable(segmentWords, scripts, nextVisited, depth + 1);
      }),
    );
  }
  if (SHELL_SCRIPT_EXT_RE.test(rawBasename(raw))) return "indeterminate"; // a shell script invoked directly
  return BUILTIN.has(command) ? "builtin" : "not-builtin";
}

function declaresNothing(manifest: NodePackageManifestLike): boolean {
  return [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies]
    .every((section) => section === undefined || section === null || typeof section !== "object" || Object.keys(section).length === 0);
}

export function classifyNodeTestRunnability(
  manifest: NodePackageManifestLike,
  nodeModulesReachable: boolean,
  ambiguousAboveWorkspaceRoot = false,
): NodeTestRunnability {
  const test = manifest.scripts?.["test"];
  if (typeof test !== "string" || test.trim() === "") return { runnable: false, reason: "no-test-script" };
  if (nodeModulesReachable) return { runnable: true, reason: "node-modules-present" };
  const verdict = combineAll(
    splitSegments(test).map((segment) => {
      const words = commandWords(segment);
      return words.length === 0 ? "builtin" : classifyExecutable(words, manifest.scripts, new Set(["test"]), 0);
    }),
  );
  if (verdict === "builtin" && declaresNothing(manifest)) return { runnable: true, reason: "no-install-needed" };
  // Finding #18(c): the ancestor walk that produced `nodeModulesReachable` never looks past the workspace
  // boundary. A monorepo member opened directly as the workspace root hides its install exactly one level
  // above that boundary — asserting "not installed" there is a confident claim this module has no way to
  // back up, so the caller's bounded peek downgrades it to an honest "not-determinable" instead. An
  // indeterminate segment (P2-14: opaque `sh`/`bash` script-file content) downgrades the same way, for the
  // same reason — this module never claims "dependencies not installed" when it simply could not look.
  if (verdict === "indeterminate" || ambiguousAboveWorkspaceRoot) return { runnable: false, reason: "not-determinable" };
  return { runnable: false, reason: "dependencies-not-installed" };
}
