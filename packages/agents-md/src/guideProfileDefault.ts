// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// P2-3(1) (v0.14.1 hands-on report) surface -> default profile coupling,
// split out of render.ts on purpose — same reason version.ts is split out
// (see that file's header comment): render.ts computes TEMPLATE_DIR from
// fileURLToPath(import.meta.url) at module load time to locate ./templates
// on disk, which is fine under Node's native ESM loader but throws the
// instant a CJS bundler (e.g. esbuild --format=cjs, as vscode-extension's
// esbuild.config.mjs runs) requires the module — import.meta.url is empty
// under CJS, and fileURLToPath(undefined) throws immediately. A consumer
// that only needs this pure defaulting rule (no template rendering, no
// filesystem access) must be able to import it without pulling that path
// resolution in at all. render.ts re-exports this function unchanged for
// its existing consumers (packages/cli, packages/agents-md/index.ts); this
// file is the source of truth.
//
// `GuideProfile` is imported type-only from render.ts (erased at compile
// time, so it creates no runtime circular dependency between the two
// modules) rather than duplicated here, to keep a single canonical
// definition.

import type { ToolSurface } from "@tokenlighten/types";
import type { GuideProfile } from "./render.js";

/**
 * The single source of truth for "what guide profile should apply when a
 * caller picked a tool surface but left the guide profile unspecified".
 * `--tool-surface code` implies a minimal-footprint, code-only setup, so
 * its sane default is the compact guide (see DESIGN-v0.15's guide/
 * tool-surface pairing analysis — compact and medium are already
 * tool-surface-neutral, so nothing code-relevant is lost by defaulting to
 * the smallest one); every other surface, including `"full"` and the
 * historical default of no surface at all, keeps today's `"full"` default
 * untouched.
 *
 * Before this function existed, three independent call sites (the `tl`
 * CLI's `workspace setup`, the VS Code extension's setup command, and —
 * transitively, since it shells out to the CLI — the desktop app) each
 * hardcoded their own `"full"` fallback with no coupling to `toolSurface`,
 * so `tl workspace setup --tool-surface code` silently wrote the full 12 KB
 * guide. Centralizing the coupling here means a caller only has to apply
 * this function's result instead of re-deriving the rule; an explicit
 * profile supplied by the caller (CLI flag, VS Code setting, ...) must
 * always win over this default — apply it ONLY when nothing else was
 * given.
 */
export function defaultGuideProfileForSurface(
  toolSurface: ToolSurface | undefined,
): GuideProfile {
  return toolSurface === "code" ? "compact" : "full";
}
