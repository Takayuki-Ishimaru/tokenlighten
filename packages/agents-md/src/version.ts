// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// The AGENTS.md/CLAUDE.md managed-block version stamp, split out of
// render.ts on purpose: render.ts computes TEMPLATE_DIR from
// fileURLToPath(import.meta.url) at module load time to locate ./templates
// on disk, which is fine under Node's native ESM loader but throws the
// instant a CJS bundler (e.g. esbuild --format=cjs, as vscode-extension's
// esbuild.config.mjs runs) requires the module — import.meta.url is empty
// under CJS, and fileURLToPath(undefined) throws immediately. A consumer
// that only needs the version stamp (no template rendering, no filesystem
// access) must be able to import it without pulling that path resolution in
// at all. render.ts re-exports this constant unchanged for its existing
// consumers (injectAll.ts, index.ts) — this file is the source of truth.

/** Current version string. Bump when prose changes materially. */
export const INSTRUCTIONS_VERSION = "2026-08-23-v76-guide-consolidation";
