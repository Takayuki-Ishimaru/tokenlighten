/**
 * candidateBundleDesk.ts — a synthetic workspace whose FIRST pack publishes the
 * discovery bundle: `decision.next` = `{qref, targets:[{path}, …], cwd, task}`, a
 * re-pack by qref over WHOLE FILES (generality audit 2026-10-24 §3.7, the shape
 * pathprobe measured on four npm packages and one Python class).
 *
 * Three directories each define a class `Registry` (the same name, so the
 * request is ambiguous between three candidates) with a helper module beside
 * it. The pack serves a window of each candidate and asks to be re-packed over
 * the files the candidates relate to (canonicalDecision.ts `discoveryBundleNext`).
 * Those targets carry a path and no window, so the next is no plan a read cursor
 * can stand for (protocol/readCallContinuation.ts `targetPaths`): it ships as
 * the call it is, which until then meant with the workspace's absolute path as
 * `cwd`. Measured with TOKENLIGHTEN_CLIENT_ID=copilot-cli (2026-10-24): a first
 * reply of about 6.6 KB, then a discover and the act.answer; with the state store
 * off the same chain, the follow-ups restated.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const CANDIDATE_BUNDLE_DESK_DIRS = ["a", "b", "c"] as const;
export const CANDIDATE_BUNDLE_DESK_QUERY = "Explain what the Registry class does and how it calls lookup, validate and normalize, and in what order - briefly, as a map of its structure (under 40 lines). No code changes.";
export const CANDIDATE_BUNDLE_DESK_METHODS = 12;

/** One `Registry` module: a constructor and `CANDIDATE_BUNDLE_DESK_METHODS` operations, each calling the three helpers in order. */
export function candidateBundleRegistrySource(): string {
  const operations: string[] = [];
  for (let index = 0; index < CANDIDATE_BUNDLE_DESK_METHODS; index += 1) {
    const calls = ["lookup", "validate", "normalize"].map((helper, step) => `    const v${step} = ${helper}(this.state, ${step});`);
    operations.push(`  op${index}(input) {\n${calls.join("\n")}\n    this.state.count += ${index};\n    return this.state;\n  }\n`);
  }
  return `'use strict'\nconst { lookup, validate, normalize } = require('./helpers')\nclass Registry {\n  constructor() { this.state = { count: 0, items: [] } }\n${operations.join("")}}\nmodule.exports = { Registry }\n`;
}

const HELPERS = "'use strict'\nfunction lookup(state, key) { return state.items[key] }\nfunction validate(state, key) { return key >= 0 }\nfunction normalize(state, key) { return key | 0 }\nmodule.exports = { lookup, validate, normalize }\n";

/** Writes the three `Registry` modules and their helpers under `root`. */
export function writeCandidateBundleDesk(root: string): void {
  for (const dir of CANDIDATE_BUNDLE_DESK_DIRS) {
    const folder = path.join(root, "src", dir);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "registry.js"), candidateBundleRegistrySource());
    fs.writeFileSync(path.join(folder, "helpers.js"), HELPERS);
  }
}
