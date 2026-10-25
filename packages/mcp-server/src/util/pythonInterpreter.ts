/**
 * pythonInterpreter.ts — which Python interpreter can run a Python edit's
 * checks (2026-10-20, decision window 6t-7 forensics,
 * bench/workflows/runs/2026-10-20-v016-decision-6t-7, T10 arm A).
 *
 * On that window's host the python3 on PATH was the Xcode shim's 3.9.6, while
 * the edited project (bench/fixtures/policyarc/actuary) declared
 * requires-python >=3.10 and openpyxl. Every arm-A cell spent 4-7 Bash turns
 * finding /opt/homebrew/bin/python3.12 (a failing import, a venv search, pip
 * show, ls of /opt/homebrew/bin, which -a), and one first wrote an 8.4 KB fake
 * openpyxl package. Neither the first pack nor the edit kit named an
 * interpreter. This module names one from the project's own manifests and a
 * probe of the PATH's python3 and python3.14 ... python3.8;
 * verificationPack.ts pythonSyntaxCheck turns the answer into the command the
 * edit kit and the first pack carry.
 *
 * Four rules hold throughout. A binary inside the workspace is never run (a
 * project venv is named, never probed). Each interpreter is probed at most
 * once per server process, cached by its resolved path. A probe that fails or
 * times out makes no claim. And when python3 already satisfies the project,
 * nothing is said.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

/** A directory holding any of these is a Python project root. */
const PY_PROJECT_MARKERS = ["pyproject.toml", "setup.cfg", "setup.py", "requirements.txt"];
/** PATH names tried after python3, newest first. */
export const PY_VERSIONED_CANDIDATES: readonly string[] = [
  "python3.14", "python3.13", "python3.12", "python3.11", "python3.10", "python3.9", "python3.8",
];
/**
 * A project venv's interpreter, relative to the project root (the convention
 * verificationPack.ts PY_RUNNER_MARKERS follows). Named when python3 falls
 * short of the project; never run.
 */
const PY_VENV_INTERPRETERS = [".venv/bin/python", "venv/bin/python", ".venv/Scripts/python.exe", "venv/Scripts/python.exe"];
/** One probe's ceiling. */
const PROBE_TIMEOUT_MS = 2000;
/** Probe time one choice may start; probes are cached, so a later choice resumes where this one stopped. */
const PROBE_CALL_BUDGET_MS = 4000;
/** Declared modules one probe asks about. */
const MAX_PROBED_MODULES = 32;
/** Files one import walk reads. */
const MAX_IMPORT_SCAN_FILES = 64;
/** Manifests and sources larger than this are not parsed. */
const MAX_PARSED_FILE_BYTES = 256 * 1024;

/** Distributions whose import name is not the lowercased, '-'-to-'_' form; keys PEP 503-normalized. */
const IMPORT_NAME_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  ["pyyaml", "yaml"],
  ["python-docx", "docx"],
  ["python-pptx", "pptx"],
  ["beautifulsoup4", "bs4"],
  ["pillow", "PIL"],
  ["scikit-learn", "sklearn"],
  ["python-dateutil", "dateutil"],
  ["opencv-python", "cv2"],
  ["opencv-python-headless", "cv2"],
]);

/**
 * Run as `<interpreter> -E -c PROBE_SCRIPT <module>...` from os.tmpdir(). It
 * prints `tlprobe <X.Y.Z> <found>...`: the interpreter's version and which of
 * the argv module names importlib.util.find_spec locates. find_spec on a
 * top-level name imports nothing. The module names ride argv, never the
 * script text, and the script parses on Python 3.4 and later.
 */
const PROBE_SCRIPT = [
  "import sys",
  "from importlib.util import find_spec",
  "def found(name):",
  "    try:",
  "        return find_spec(name) is not None",
  "    except Exception:",
  "        return False",
  "print('tlprobe', '%d.%d.%d' % tuple(sys.version_info[:3]), *[n for n in sys.argv[1:] if found(n)])",
].join("\n");

// ---------------------------------------------------------------------------
// requires-python
// ---------------------------------------------------------------------------

export interface VersionClause {
  op: "~=" | "==" | "!=" | "<=" | ">=" | "<" | ">";
  release: number[];
  /** `==X.Y.*` / `!=X.Y.*`. */
  wildcard: boolean;
}

/**
 * PEP 440 specifiers as requires-python uses them: `>=`, `>`, `<=`, `<`, `~=`,
 * and `==`/`!=` with or without a trailing `.*`, comma-joined. Undefined when
 * any clause is something else (a pre-release, `===`, a typo): this module
 * claims nothing about a constraint it cannot read.
 */
export function parseRequiresPython(spec: string): VersionClause[] | undefined {
  const clauses: VersionClause[] = [];
  for (const raw of spec.split(",")) {
    const text = raw.trim();
    if (text === "") continue;
    const match = /^(~=|==|!=|<=|>=|<|>)\s*v?(\d+(?:\.\d+)*)(\.\*)?$/.exec(text);
    if (match === null) return undefined;
    const op = match[1] as VersionClause["op"];
    const wildcard = match[3] !== undefined;
    const release = match[2]!.split(".").map(Number);
    if (wildcard && op !== "==" && op !== "!=") return undefined;
    if (op === "~=" && release.length < 2) return undefined;
    clauses.push({ op, release, wildcard });
  }
  return clauses.length > 0 ? clauses : undefined;
}

function compareRelease(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function hasReleasePrefix(version: readonly number[], prefix: readonly number[]): boolean {
  return prefix.every((part, i) => (version[i] ?? 0) === part);
}

/** PEP 440 semantics over release numbers: `==3.10` is 3.10.0 only, `~=3.10` is >=3.10 and ==3.*. */
export function versionSatisfies(version: readonly number[], clauses: readonly VersionClause[]): boolean {
  return clauses.every((clause) => {
    const cmp = compareRelease(version, clause.release);
    switch (clause.op) {
      case ">=": return cmp >= 0;
      case ">": return cmp > 0;
      case "<=": return cmp <= 0;
      case "<": return cmp < 0;
      case "~=": return cmp >= 0 && hasReleasePrefix(version, clause.release.slice(0, -1));
      case "==": return clause.wildcard ? hasReleasePrefix(version, clause.release) : cmp === 0;
      case "!=": return clause.wildcard ? !hasReleasePrefix(version, clause.release) : cmp !== 0;
      default: return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Declared dependencies
// ---------------------------------------------------------------------------

const REQUIREMENT_RE = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?(.*)$/s;

/**
 * A PEP 508 requirement's distribution name, or undefined when it carries an
 * environment marker: markers are not evaluated here, so such a dependency is
 * not counted as required.
 */
export function requirementName(requirement: string): string | undefined {
  const match = REQUIREMENT_RE.exec(requirement.trim());
  if (match === null || match[2]!.includes(";")) return undefined;
  return match[1];
}

/** The top-level module a distribution installs, by convention: lowercased with '-' as '_', or IMPORT_NAME_EXCEPTIONS. */
export function importNameOf(distribution: string): string | undefined {
  const known = IMPORT_NAME_EXCEPTIONS.get(distribution.toLowerCase().replace(/[-_.]+/g, "-"));
  if (known !== undefined) return known;
  // A dotted distribution ("zope.interface") installs into its first segment's namespace.
  const name = distribution.split(".")[0]!.toLowerCase().replace(/-/g, "_");
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : undefined;
}

/** Distribution names in a requirements.txt: options, URLs, VCS links, paths and archives are skipped. */
function requirementsTxtNames(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line === "" || line.startsWith("-")) continue;
    const first = line.split(/\s+/)[0]!;
    if (first.includes("://") || /^(?:git|hg|svn|bzr)\+/i.test(first) || /^[.~/\\]/.test(first)) continue;
    if (/\.(?:whl|zip|tar\.gz|tgz)$/i.test(first)) continue;
    const name = requirementName(line);
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** The body of one `[table]` of a TOML file (not `[table.sub]`, not `[[array]]`), or undefined when absent. */
function tomlTableBody(text: string, table: string): string | undefined {
  const body: string[] = [];
  let inside = false;
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[(\[)?\s*([^[\]]*?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header !== null) {
      inside = header[1] === undefined && header[2] === table;
      found ||= inside;
      continue;
    }
    if (inside) body.push(line);
  }
  return found ? body.join("\n") : undefined;
}

/** `requires-python` in a `[project]` body: a basic or literal TOML string. */
function tomlRequiresPython(body: string): string | undefined {
  const match = /^\s*requires-python\s*=\s*(?:"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)')/m.exec(body);
  if (match === null) return undefined;
  return match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2];
}

/** The strings of a `dependencies = [...]` array in a `[project]` body; comments are skipped. */
function tomlDependencies(body: string): string[] {
  const start = /^\s*dependencies\s*=\s*\[/m.exec(body);
  if (start === null) return [];
  const out: string[] = [];
  let i = start.index + start[0].length;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === "]") break;
    if (ch === "#") {
      const eol = body.indexOf("\n", i);
      i = eol < 0 ? body.length : eol + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let value = "";
      let j = i + 1;
      while (j < body.length && body[j] !== ch && body[j] !== "\n") {
        if (ch === '"' && body[j] === "\\" && j + 1 < body.length) {
          value += body[j + 1];
          j += 2;
          continue;
        }
        value += body[j];
        j += 1;
      }
      if (body[j] !== ch) break;
      out.push(value);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/** `python_requires` in setup.cfg's `[options]`. */
function setupCfgPythonRequires(text: string): string | undefined {
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header !== null) {
      inside = header[1]!.trim() === "options";
      continue;
    }
    if (!inside) continue;
    const match = /^\s*python[_-]requires\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (match !== null) return match[1]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Workspace facts
// ---------------------------------------------------------------------------

/** `rel` as a normalized workspace-relative POSIX path ("" = the root), or undefined when it leaves the workspace. */
function normalizeRel(rel: string): string | undefined {
  const posix = path.posix.normalize(rel.replace(/\\/g, "/"));
  if (posix === ".") return "";
  if (posix === ".." || posix.startsWith("../") || path.posix.isAbsolute(posix)) return undefined;
  return posix;
}

function parentRel(dir: string): string {
  const parent = path.posix.dirname(dir);
  return parent === "." ? "" : parent;
}

function joinRel(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

function statAt(workspace: string, rel: string): fs.Stats | undefined {
  try {
    return fs.statSync(path.join(workspace, rel));
  } catch {
    return undefined;
  }
}

function readText(workspace: string, rel: string): string | undefined {
  const stat = statAt(workspace, rel);
  if (stat === undefined || !stat.isFile() || stat.size > MAX_PARSED_FILE_BYTES) return undefined;
  try {
    return fs.readFileSync(path.join(workspace, rel), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The nearest directory, from `rel`'s own up to the workspace root (""),
 * holding pyproject.toml, setup.cfg, setup.py or requirements.txt; undefined
 * when none does. `rel` need not exist yet (a pack's create target).
 */
export function pythonProjectRoot(workspace: string, rel: string): string | undefined {
  const file = normalizeRel(rel);
  if (file === undefined || file === "") return undefined;
  for (let dir = parentRel(file); ; dir = parentRel(dir)) {
    if (PY_PROJECT_MARKERS.some((marker) => statAt(workspace, joinRel(dir, marker))?.isFile() === true)) return dir;
    if (dir === "") return undefined;
  }
}

export interface PythonRequirements {
  /** requires-python with its whitespace removed, present only when every clause parsed. */
  requiresPython?: string;
  clauses?: VersionClause[];
  /** Import names of the declared top-level dependencies, sorted. */
  modules: string[];
}

/**
 * The project's requires-python (pyproject `[project]`, else setup.cfg
 * `[options]` python_requires) and its declared top-level dependencies
 * (pyproject `[project].dependencies` plus requirements.txt) as import names.
 */
export function readPythonRequirements(workspace: string, root: string): PythonRequirements {
  const pyproject = readText(workspace, joinRel(root, "pyproject.toml"));
  const project = pyproject === undefined ? undefined : tomlTableBody(pyproject, "project");
  let spec = project === undefined ? undefined : tomlRequiresPython(project);
  if (spec === undefined) {
    const setupCfg = readText(workspace, joinRel(root, "setup.cfg"));
    if (setupCfg !== undefined) spec = setupCfgPythonRequires(setupCfg);
  }
  const distributions = [
    ...(project === undefined ? [] : tomlDependencies(project).map(requirementName)),
    ...requirementsTxtNames(readText(workspace, joinRel(root, "requirements.txt")) ?? ""),
  ];
  const modules = [...new Set(distributions
    .map((name) => (name === undefined ? undefined : importNameOf(name)))
    .filter((name): name is string => name !== undefined))]
    .sort()
    .slice(0, MAX_PROBED_MODULES);
  const requiresPython = spec?.replace(/\s+/g, "");
  const clauses = requiresPython === undefined || requiresPython === "" ? undefined : parseRequiresPython(requiresPython);
  return clauses === undefined ? { modules } : { requiresPython, clauses, modules };
}

const IMPORT_LINE_RE = /^[ \t]*import[ \t]+([^\n#;]+)/gm;
const FROM_LINE_RE = /^[ \t]*from[ \t]+(\.*)([A-Za-z_][\w.]*)?[ \t]+import[ \t]+\(?([^\n#;]*)/gm;
const DOTTED_NAME_RE = /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/;

/**
 * Top-level names of the modules outside the project that `files` import,
 * following their imports of the project's own modules (relative ones, and
 * absolute ones rooted at the project root or its `src/`), at most
 * MAX_IMPORT_SCAN_FILES files. Read from source text, so a function-level or
 * conditional import counts; callers only ever intersect the result with the
 * declared dependencies.
 */
export function importedExternalModules(workspace: string, root: string, files: readonly string[]): Set<string> {
  const bases = [root, joinRel(root, "src")];
  const localBase = (top: string): string | undefined => bases.find((base) => {
    const rel = joinRel(base, top);
    return statAt(workspace, `${rel}.py`)?.isFile() === true || statAt(workspace, rel)?.isDirectory() === true;
  });
  const queue: string[] = [];
  const seen = new Set<string>();
  const enqueue = (rel: string): void => {
    if (seen.has(rel) || seen.size >= MAX_IMPORT_SCAN_FILES || statAt(workspace, rel)?.isFile() !== true) return;
    seen.add(rel);
    queue.push(rel);
  };
  // Every package __init__ on the way, then the module itself, as importing it runs them.
  const enqueueModule = (baseDir: string, dotted: string): void => {
    let dir = baseDir;
    for (const part of dotted.split(".")) {
      dir = joinRel(dir, part);
      enqueue(`${dir}/__init__.py`);
    }
    enqueue(`${dir}.py`);
  };
  const external = new Set<string>();
  const absolute = (dotted: string, names: readonly string[]): void => {
    const top = dotted.split(".")[0]!;
    const base = localBase(top);
    if (base === undefined) {
      external.add(top);
      return;
    }
    enqueueModule(base, dotted);
    for (const name of names) enqueueModule(base, `${dotted}.${name}`);
  };
  for (const rel of files) enqueue(rel);
  while (queue.length > 0) {
    const rel = queue.shift()!;
    const text = readText(workspace, rel);
    if (text === undefined) continue;
    for (const match of text.matchAll(IMPORT_LINE_RE)) {
      for (const item of match[1]!.split(",")) {
        const dotted = item.trim().split(/\s+/)[0] ?? "";
        if (DOTTED_NAME_RE.test(dotted)) absolute(dotted, []);
      }
    }
    for (const match of text.matchAll(FROM_LINE_RE)) {
      const level = match[1]!.length;
      const dotted = match[2] ?? "";
      const names = match[3]!.split(",")
        .map((item) => item.trim().split(/\s+/)[0] ?? "")
        .filter((name) => /^[A-Za-z_]\w*$/.test(name));
      if (level === 0) {
        if (DOTTED_NAME_RE.test(dotted)) absolute(dotted, names);
        continue;
      }
      let dir = parentRel(rel);
      for (let up = 1; up < level; up++) dir = parentRel(dir);
      if (dotted !== "" && DOTTED_NAME_RE.test(dotted)) enqueueModule(dir, dotted);
      for (const name of names) enqueueModule(dir, dotted === "" ? name : `${dotted}.${name}`);
    }
  }
  return external;
}

/** A project venv interpreter at `root`, then at the workspace root, workspace-relative; named, never run. */
function projectVenvInterpreter(workspace: string, root: string): { rel: string; marker: string } | undefined {
  for (const dir of root === "" ? [""] : [root, ""]) {
    for (const marker of PY_VENV_INTERPRETERS) {
      const rel = joinRel(dir, marker);
      // statSync follows the venv's symlink to its base interpreter; a dangling link is no venv.
      if (statAt(workspace, rel)?.isFile() === true) return { rel, marker };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

export interface PythonProbeRun {
  status: number | null;
  stdout: string;
}

/** Test seam: replaces the PATH lookup, the process start and the realpath used as the cache key. */
export interface PythonInterpreterSeam {
  /** Where `name` resolves on PATH, or undefined. */
  locate?: (name: string) => string | undefined;
  /** One probe run; undefined = it could not start, timed out, or was killed. */
  run?: (bin: string, args: readonly string[], timeoutMs: number) => PythonProbeRun | undefined;
  realpath?: (file: string) => string;
}

let seam: PythonInterpreterSeam | undefined;

interface ProbeResult {
  version: number[];
  versionText: string;
  found: ReadonlySet<string>;
  asked: ReadonlySet<string>;
}

/** One entry per resolved interpreter path for the life of the process; null = the probe failed. */
const probeCache = new Map<string, ProbeResult | null>();

/** Pin the PATH lookup and the probe (`undefined` restores the real ones); clears the probe cache either way. */
export function setPythonInterpreterSeamForTest(next: PythonInterpreterSeam | undefined): void {
  seam = next;
  probeCache.clear();
}

export function pythonInterpreterSeamInstalled(): boolean {
  return seam !== undefined;
}

/**
 * Forget every probe (testing/sessionReset.ts): a pooled test server re-rooted
 * at another workspace probes again, as a fresh process would, instead of
 * holding answers for the previous workspace's declared modules.
 */
export function resetPythonProbeCacheForTest(): void {
  probeCache.clear();
}

function runProbe(bin: string, args: readonly string[], timeoutMs: number): PythonProbeRun | undefined {
  const result = spawnSync(bin, [...args], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  if (result.error !== undefined || result.signal !== null) return undefined;
  return { status: result.status, stdout: result.stdout ?? "" };
}

function parseProbe(stdout: string, asked: readonly string[]): ProbeResult | undefined {
  const line = stdout.split(/\r?\n/).reverse().find((candidate) => candidate.startsWith("tlprobe "));
  if (line === undefined) return undefined;
  const [, versionText, ...names] = line.trim().split(/\s+/);
  if (versionText === undefined || !/^\d+\.\d+\.\d+$/.test(versionText)) return undefined;
  const askedSet = new Set(asked);
  return {
    version: versionText.split(".").map(Number),
    versionText,
    found: new Set(names.filter((name) => askedSet.has(name))),
    asked: askedSet,
  };
}

function realpathOf(file: string): string | undefined {
  try {
    return (seam?.realpath ?? fs.realpathSync.native)(file);
  } catch {
    return undefined;
  }
}

function insideWorkspace(workspace: string, file: string, real: string | undefined): boolean {
  const within = (root: string, target: string): boolean => {
    const rel = path.relative(root, target);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  };
  if (within(path.resolve(workspace), file)) return true;
  const realWorkspace = realpathOf(workspace);
  return real !== undefined && realWorkspace !== undefined && within(realWorkspace, real);
}

type CandidateState =
  | { kind: "absent" }
  /** Resolves inside the workspace: never run. */
  | { kind: "workspace" }
  /** The probe failed or timed out, the call's probe budget ran out, or the cached probe never asked about these modules. */
  | { kind: "unknown" }
  | { kind: "probed"; path: string; probe: ProbeResult };

function candidateState(
  workspace: string,
  name: string,
  modules: readonly string[],
  locate: (name: string) => string | undefined,
  clock: { spentMs: number },
): CandidateState {
  const located = locate(name);
  if (located === undefined) return { kind: "absent" };
  const absolute = path.resolve(located);
  const real = realpathOf(absolute);
  if (insideWorkspace(workspace, absolute, real)) return { kind: "workspace" };
  const key = real ?? absolute;
  if (!probeCache.has(key)) {
    if (clock.spentMs >= PROBE_CALL_BUDGET_MS) return { kind: "unknown" };
    const started = Date.now();
    const run = (seam?.run ?? runProbe)(absolute, ["-E", "-c", PROBE_SCRIPT, ...modules], PROBE_TIMEOUT_MS);
    clock.spentMs += Date.now() - started;
    probeCache.set(key, run !== undefined && run.status === 0 ? parseProbe(run.stdout, modules) ?? null : null);
  }
  const probe = probeCache.get(key);
  if (probe === undefined || probe === null || modules.some((module) => !probe.asked.has(module))) return { kind: "unknown" };
  return { kind: "probed", path: absolute, probe };
}

// ---------------------------------------------------------------------------
// The note
// ---------------------------------------------------------------------------

interface NoteFacts {
  python3:
    | { kind: "absent" | "unknown" }
    | { kind: "probed"; version: string; failsVersion: boolean; lacking: string[] };
  requiresPython?: string;
  /** The PATH name ("python3.12") or the venv's marker path. */
  label: string;
  venv: boolean;
  /** Declared modules the chosen interpreter was required to have: every one, or the ones the edited code reaches. */
  required: string[];
  everyDeclared: boolean;
  /** Declared modules the chosen interpreter lacks (only when `everyDeclared` is false). */
  lacks: string[];
}

interface NoteShape {
  /** Module names listed before "+N more"; 0 = a count instead of names. */
  listCap: number;
  chosenLacks: boolean;
  requiresText: boolean;
  fromRoot: boolean;
}

/** Tried in order; the first that fits the caller's byte budget wins. */
const NOTE_SHAPES: readonly NoteShape[] = [
  { listCap: 3, chosenLacks: true, requiresText: true, fromRoot: true },
  { listCap: 3, chosenLacks: true, requiresText: true, fromRoot: false },
  { listCap: 3, chosenLacks: false, requiresText: true, fromRoot: false },
  { listCap: 0, chosenLacks: false, requiresText: true, fromRoot: false },
  { listCap: 0, chosenLacks: false, requiresText: false, fromRoot: false },
];

function moduleList(names: readonly string[], cap: number): string {
  if (cap === 0) return `${names.length} declared module${names.length === 1 ? "" : "s"}`;
  return names.length <= cap ? names.join(", ") : `${names.slice(0, cap).join(", ")} +${names.length - cap} more`;
}

function noteText(facts: NoteFacts, shape: NoteShape): string {
  const requires = facts.requiresPython === undefined
    ? ""
    : shape.requiresText ? ` (requires-python ${facts.requiresPython})` : " (below requires-python)";
  const python3 = facts.python3;
  let first: string | undefined;
  let chosen: string;
  if (python3.kind === "probed") {
    const lacks = python3.lacking.length > 0 ? `lacks ${moduleList(python3.lacking, shape.listCap)}` : "";
    first = python3.failsVersion
      ? `python3 is ${python3.version}${requires}${lacks === "" ? "" : ` and ${lacks}`}`
      : `python3 ${lacks}`;
    chosen = python3.failsVersion && lacks !== ""
      ? `${facts.label} satisfies both`
      : python3.failsVersion
        ? `${facts.label} satisfies it`
        : `${facts.label} has ${python3.lacking.length === 1 ? "it" : "them"}`;
  } else {
    first = python3.kind === "absent" ? "no python3 on PATH" : undefined;
    const parts = [
      facts.requiresPython === undefined ? undefined : `meets requires-python${shape.requiresText ? ` ${facts.requiresPython}` : ""}`,
      facts.required.length === 0
        ? undefined
        : `has ${facts.everyDeclared ? "every declared module" : moduleList(facts.required, shape.listCap)}`,
    ].filter((part): part is string => part !== undefined);
    chosen = parts.length > 0 ? `${facts.label} ${parts.join(" and ")}` : `${facts.label} runs`;
  }
  if (facts.venv) chosen = `the project's ${facts.label} is preferred (not probed)`;
  else if (shape.chosenLacks && facts.lacks.length > 0) chosen += ` but lacks ${moduleList(facts.lacks, shape.listCap)}`;
  const tail = `run smoke checks with it${shape.fromRoot ? " from the workspace root" : ""}`;
  return [first, chosen, tail].filter((part): part is string => part !== undefined).join("; ");
}

function buildNote(facts: NoteFacts, maxBytes: number): string {
  for (const shape of NOTE_SHAPES) {
    const text = noteText(facts, shape);
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  }
  return facts.venv
    ? `the project's ${facts.label} is preferred (not probed); run smoke checks with it`
    : `python3 does not fit this project; ${facts.label} does; run smoke checks with it`;
}

// ---------------------------------------------------------------------------
// The choice
// ---------------------------------------------------------------------------

export interface PythonInterpreterChoice {
  /** What the command runs: an absolute PATH hit, or a workspace-relative venv interpreter. */
  interpreter: string;
  /** The files covered: those under the same Python project root as the first. */
  files: string[];
  /** Why, in one line within `noteMaxBytes` (the caller appends any platform clause). */
  note: string;
}

/**
 * The interpreter to state for `files` (workspace-relative .py paths; the
 * first one's project decides), or undefined when nothing should be said.
 *
 * python3 that meets requires-python and finds every declared module: nothing
 * (the common case adds no bytes). An activated project venv (python3 inside
 * the workspace): nothing, as it is the project's own choice and is never run.
 * Otherwise a project venv, named unprobed; else the first of python3.14 ...
 * python3.8 that meets requires-python and finds every declared module. When
 * none finds every one (the T10 host: python3.12 had openpyxl, not flask,
 * pandas or requests), the same order again, against the declared modules the
 * edited code reaches (`importedExternalModules`, plus `extraModules`), again
 * saying nothing when python3 meets that; the note then names what the chosen
 * one lacks. Nothing found: no claim.
 */
export function choosePythonInterpreter(
  workspace: string,
  files: readonly string[],
  options: {
    /** PATH lookup: where a name resolves. The test seam's `locate` wins over it. */
    locate: (name: string) => string | undefined;
    /** Modules the caller knows the target needs (openpyxl for an .xlsx source); only declared ones count. */
    extraModules?: readonly string[];
    noteMaxBytes: number;
  },
): PythonInterpreterChoice | undefined {
  const rels = files
    .map(normalizeRel)
    .filter((rel): rel is string => rel !== undefined && rel !== "");
  if (rels.length === 0) return undefined;
  const root = pythonProjectRoot(workspace, rels[0]!);
  const covered = [...new Set(rels.filter((rel) => pythonProjectRoot(workspace, rel) === root))];
  const requirements: PythonRequirements = root === undefined ? { modules: [] } : readPythonRequirements(workspace, root);
  const declared = requirements.modules;
  const locate = seam?.locate ?? options.locate;
  // Nothing declared to satisfy: a python3 on PATH answers for itself, unprobed.
  if (requirements.clauses === undefined && declared.length === 0 && locate("python3") !== undefined) return undefined;
  const clock = { spentMs: 0 };
  const stateOf = (name: string): CandidateState => candidateState(workspace, name, declared, locate, clock);
  const fits = (probe: ProbeResult, modules: readonly string[]): boolean =>
    (requirements.clauses === undefined || versionSatisfies(probe.version, requirements.clauses))
    && modules.every((module) => probe.found.has(module));
  const python3 = stateOf("python3");
  if (python3.kind === "workspace" || (python3.kind === "probed" && fits(python3.probe, declared))) return undefined;
  const python3Facts = (modules: readonly string[]): NoteFacts["python3"] => python3.kind === "probed"
    ? {
      kind: "probed",
      version: python3.probe.versionText,
      failsVersion: requirements.clauses !== undefined && !versionSatisfies(python3.probe.version, requirements.clauses),
      lacking: modules.filter((module) => !python3.probe.found.has(module)),
    }
    : { kind: python3.kind };
  const choice = (interpreter: string, facts: Omit<NoteFacts, "python3" | "requiresPython">): PythonInterpreterChoice => ({
    interpreter,
    files: covered,
    note: buildNote({
      ...facts,
      python3: python3Facts(facts.required),
      ...(requirements.requiresPython !== undefined ? { requiresPython: requirements.requiresPython } : {}),
    }, options.noteMaxBytes),
  });
  const venv = root === undefined ? undefined : projectVenvInterpreter(workspace, root);
  if (venv !== undefined) {
    return choice(venv.rel, { label: venv.marker, venv: true, required: declared, everyDeclared: true, lacks: [] });
  }
  for (const name of PY_VERSIONED_CANDIDATES) {
    const state = stateOf(name);
    if (state.kind === "probed" && fits(state.probe, declared)) {
      return choice(state.path, { label: name, venv: false, required: declared, everyDeclared: true, lacks: [] });
    }
  }
  const reached = importedExternalModules(workspace, root ?? "", covered);
  for (const module of options.extraModules ?? []) reached.add(module);
  const needed = declared.filter((module) => reached.has(module));
  if (needed.length === declared.length || (python3.kind === "probed" && fits(python3.probe, needed))) return undefined;
  for (const name of PY_VERSIONED_CANDIDATES) {
    const state = stateOf(name);
    if (state.kind !== "probed" || !fits(state.probe, needed)) continue;
    return choice(state.path, {
      label: name,
      venv: false,
      required: needed,
      everyDeclared: false,
      lacks: declared.filter((module) => !state.probe.found.has(module)),
    });
  }
  return undefined;
}
