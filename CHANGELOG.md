# Changelog

All notable public changes to TokenLighten are documented here.

## 0.13.1

Reliability update for concurrent agents and canonical v0.13 request shapes.
The MCP surface and advertised schemas are unchanged.

### Fixed

- Isolated task state between concurrent agent lanes so one lane cannot reuse
  another lane's readiness or edit context.
- Corrected ranged multi-target reads and mixed batches that create files while
  editing existing files.
- Prevented completed continuations and pathless tree fallbacks from being
  proposed repeatedly.
- Required checklist-style tasks in English and Japanese to prove or disclose
  every item before reporting completion.
- Made mixed archive/plain-target reads and workspace-coherence failures return
  explicit, recoverable refusals instead of incomplete-looking successes.
- Reduced unnecessary context for explicit new-file creation and uniquely
  identified literal edits.

### Changed

- Local savings accounting now aggregates complete tasks, including exploration
  calls. Usage events use `schemaVersion: 2`; version-1 logs remain readable.
- Local diagnostics gained additional count- and hash-only attribution events;
  tool responses are unchanged.

## 0.13.0

Correctness and client-compatibility release centered on proof-carrying task
completion, a canonical MCP request surface, smaller replay responses, and
automatic VS Code schema-cache recovery.

### Added

- Proof-carrying completion tracks monotone task obligations, authoritative
  absence, executed continuations, and bounded one-hop evidence expansion.
  Exhaustive requests cannot report `act.answer` while an obligation remains
  unproved or undisclosed.
- Replay v2 stores compact structured edit outcomes while keeping legacy retry
  keys fail-safe. Four measured replay cases shrank from 5,247 to 391 bytes in
  aggregate; fresh apply responses remain unchanged.
- A schema stamp now follows the advertised tool schema through the CLI,
  generated client configuration, and VS Code MCP provider version. VS Code
  refreshes definitions when that stamp changes.
- Guide profile selection is available through the CLI and VS Code. Managed
  guide v80 documents the canonical v0.13 call surface in English and Japanese.

### Changed

- The advertised request schemas now use the canonical `query`, `targets`,
  `content`, `select`, `budget`, `task`, `scope`, `edits`, and
  `artifact` structures. The server advertises six canonical call shapes
  across exactly three MCP tools.
- Legacy v0.12 request fields remain dispatch-compatible for v0.13.x but are no
  longer advertised and are scheduled for removal in v0.14.
- `TL_PROOF_COMPLETION` is enabled by default as a correctness safeguard.
  Experimental `TL_SCHEMA_DEFS` remains disabled by default and fails closed.
- JSON-stringified canonical object parameters are accepted only after strict
  structural validation, improving compatibility with schema-blind clients.
  Advertised arrays now declare item schemas for VS Code and OpenAI
  function-calling validators.

### Validation and benchmark disclosure

- At-head protocol validation passed the baseline follower, Tier-3 follower,
  and proof-completion-OFF follower suites at 8/8 each, plus the 7/7 release
  rehearsal.
- The v0.13 developer benchmark produced a TokenLighten/native aggregate cost
  ratio of **0.735**, a point estimate of **26.5% lower** task cost. v0.12.1
  introduced no performance change; the comparable v0.12.0 point estimate was
  approximately 28% lower, and v0.11.1 was approximately 21% lower.
- Task-level median costs were 42.5% lower for cross-module telemetry-health
  wiring, 20.3% lower for a related multi-bug fix, 12.0% lower for a
  cross-path priority feature, and 18.0% lower for spreadsheet-driven rating
  rules. A localized explanation task cost 4.1% more and a narrow calculation
  fix cost 1.1% more, showing that small known-location work remains the weak
  area. These cross-release comparisons are descriptive, and developer-run
  observations do not guarantee savings or quality on other repositories,
  clients, models, or evaluation windows.

### Known limitations

- Some multi-target range-read shapes can re-serve prior ranges or be refused;
  use separate single-target range reads as a workaround.
- A single edit batch that mixes creation with edits to existing files can be
  refused; apply the creation and existing-file edits in separate batches.
- Concurrent lanes sharing one workspace can expose stale edit-frontier state
  in a known edge case. Avoid concurrent write lanes until this is corrected.

## 0.12.1

Maintenance and security-quality patch on top of v0.12.0. This release
addresses the 12 Dependabot and 38 CodeQL Security and quality findings
inventoried before release. It does not introduce a new performance feature
or change the v0.12.0 benchmark interpretation.

### Fixed

- Updated or overrode vulnerable development and transitive dependencies,
  including esbuild, Vite, Vitest, UUID, and unzipper; both the runtime and
  full dependency audits now report zero vulnerabilities.
- Replaced CodeQL-identified superlinear regular expressions with bounded
  scanners or direct string operations across task routing, source fallback
  parsing, Markdown handling, tokenization, path processing, and secret-path
  checks.
- Rejected `__proto__` segments in CLI dot-path configuration to prevent
  prototype pollution while preserving legitimate `constructor` and
  `prototype` keys.
- Removed modulo bias from random handle generation using 64-bit rejection
  sampling.
- Hardened DOCX/OOXML text extraction, Markdown/table rendering, license
  rendering, and generated preload code with single-pass or explicit
  escaping paths.
- Consolidated stable SHA-256 content identifiers behind shared helpers and
  narrowly scoped static-analysis annotations without changing their wire
  values.
- Added regression coverage for the exact parser, sanitizer, configuration,
  path, secret-scan, test-marker, content-hash, and handle-generation shapes
  changed by this patch.

### Dependency ownership

- Removed the unused S3 bundler helper and unused public development
  dependencies.
- Declared `exceljs` directly in the CLI package that imports it.
- Regenerated the private and public workspace lockfiles from the corrected
  dependency graph.

### Benchmark disclosure

No new benchmark result or performance claim is introduced in v0.12.1. The
reviewed v0.12.0 observations and caveats remain unchanged.

## 0.12.0

Four implementation waves against `DESIGN-v0.12-plan.md`'s adjudicated
scope: serving/contract correctness fixes, response compaction, one new
default-OFF byte-economy flag, an advisory extension to Task Reasoning IR
v2, and delivery/distribution updates. Three v0.11 experimental
read-economy flags are retired at default OFF. The final pre-release wave
was driven by an external v0.11.1 real-device evaluation and two VS Code
field reports.

The retained v0.12 decision run is now adjudicated. Across 16 matched
verified pairs, aggregate verified task cost with TokenLighten was
approximately 28% lower than with native tools only, compared with
approximately 21% lower in the retained v0.11.1 run. See **Release
benchmark summary** below for representative results and caveats.

### Added

- Small known-location fast path: a query naming one existing path plus
  an identifier and its value change — in natural phrasing, including
  arrows (`X 0.12→0.15`), "set X to B", and Japanese 「XをAからBに」 —
  short-circuits candidate collection and returns a single
  identifier-centered `act.edit` pack with a ready `fast_path` (~3.9 KB
  measured on dense code).
- `read_file` honors `maxBytes`/`maxTokens` for `mode=task_pack`,
  `handles=[...]` batches, and `mode=full paths=[...]` batches, so a
  caller can keep any single response under its host's tool-result
  ceiling. Precedence: explicit argument >
  `TOKENLIGHTEN_TASK_PACK_MAX_BYTES` > client-profile default > type
  default. VS Code-identified clients (via the `initialize` handshake's
  `clientInfo.name`) get a conservative 14,336 B default task-pack
  ceiling, below the ~16 KB threshold at which VS Code spills tool
  results to a file.
- Machine-readable replay: an `edit_file` retry under the same
  `operation_id` returns `replayed: true` on the replayed `edit.applied`;
  fresh applies omit the field.
- A `queries[]`-over-5 refusal carries `remaining_queries` (the tail
  terms, verbatim) alongside the first-five `next`; handles-batch entries
  served from a bare file handle carry `synthesized_range: true` to
  distinguish a whole-file default from a caller-sliced range.
- `tl doctor` runs runtime-capability checks by default and moves
  development-only concerns (license tooling, the bench-only python
  prerequisite, dist-staleness strictness) behind `tl doctor
  --development`; parser/exceljs checks probe the runtime's actual import
  mechanism instead of `require.resolve`, so packaged (VSIX) installs no
  longer false-fail, and a missing `git` degrades to a warning naming the
  shadow-checkpoint feature it affects.
- `tl logs summary` always shows the measured side — TL call count, total
  response bytes, estimated response tokens (bytes/4, labeled), and a
  per-tool breakdown — while baseline/savings lines stay fail-closed
  ("unavailable") exactly as before.
- Guide: `compact` is a first-class profile (413/409 est. tokens en/jp)
  alongside `full`/`medium`, with new Japanese variants for medium and
  compact, budget-guard specs, and `--profile compact` accepted by both
  `tl-agents` and `tl agents update`. The default profile is unchanged
  (`full`).
- Japanese-language retrieval: the query tokenizers (BM25F, query-shape,
  and the locator's candidate heuristics) extract Han/kana runs and
  bigrams via a shared `cjkSpans` module, so Japanese prose queries rank
  candidates instead of being invisible; concern anchoring deliberately
  stays identifier-grounded (`isConcernAnchorable`), so CJK prose can
  satisfy but never veto coverage.
- Field-eval regression fixtures: `fieldEvalFixtures.spec.ts` pins the
  cross-cutting false-complete gate, absence stability, new-task
  recognition without `taskEpoch:"new"`, and single-mutation replay; the
  replay corpus gains five `qc` cases for lossless continuation and
  epoch-requirement monotonicity.
- `TL_DELTA_CONTEXT` (new flag, default OFF): carries the served-range
  ledger across the server's own edits. A read that follows one of the
  server's own writes now serves only the file's unheld byte ranges as a
  full body, with already-held ranges carried as `prior` — instead of
  re-serving the whole file — using prefix/suffix hunk geometry (not a
  diff) to compute the post-edit ranges. A base-content mismatch,
  `force_serve:true`, or a delta larger than the plain content all fall
  back to a full serve. Measured on a representative case, the post-edit
  re-read shrank from 6214 B to 415 B (-93.3%).
- Task Reasoning IR v2 (`TL_REASONING_IR_V2`, still default OFF, still
  advisory/trace-only) can now close an obligation from the server's own
  proof that an edit succeeded, so its trace-only Shadow Stop candidates
  become reachable on change tasks, not only read-only answer tasks. Wire
  behavior is unchanged and the flag's OFF path stays byte-identical. A
  companion change forwards the flag and tracing through the bench
  harness so live engagement data can be collected across every bench arm
  at no extra run cost, feeding the Stop/Replan enforcement decision.
- `tl workspace status` reports whether the managed TokenLighten guide
  block is present among a workspace's onboarding files.

### Changed

- Tool schemas: shared task-state property descriptions and the largest
  single descriptions were shortened without removing or hiding any
  capability — `tools/list` shrinks 8,905→8,532 B minified (spec ceiling
  lowered to 8,597 B).
- Managed guide v78 ("wire-facts") teaches the wave's nine new wire facts
  (lossless continuations, requirement monotonicity, per-item edit
  targets, `remaining_queries`, `replayed:true`, `maxBytes` bounding,
  `synthesized_range`, natural fast-path phrasings, bounded
  `remaining_ranges`) while the full profile got smaller in both locales
  (en 9,988→9,979 B; jp 9,885→9,884 B).
- `edit.applied` responses are more compact: the top-level `applied_note`
  shrinks from 238 B to 49 B, the create note from 96 B to 64 B, and the
  read-back note from 83 B to 37 B, and a per-file `head` from 3 lines to
  1 — while remaining semantically equivalent, since `slice_sha`, `range`,
  and `enclosing_symbol` still prove the rest. Measured median across 5
  representative scenarios: -19.9% response bytes (the create scenario
  alone: -10.2%). Rolled-back and state-unknown responses are
  deliberately left uncompacted (byte-parity pinned at 398 B / 693 B
  respectively), since those are exactly the outcomes where a caller most
  needs the full picture. In the ongoing Phase-3a protocol-v1-candidate-
  vs-frozen-baseline wire-byte report (tracking migration cost
  neutrality, not a decision-run result), this change alone re-pins the
  shared `edit.applied.create` shape from 934 B / 240 o200k-tokens to
  856 B / 221 o200k-tokens, flipping that report's frequency-weighted
  total across its 11 shared shapes from +834 o200k-tokens (candidate
  costlier than the frozen baseline) to -306 o200k-tokens (candidate now
  cheaper).
- Natural-autoload delivery — the managed guide plus workspace MCP
  configuration, without manual prompt injection — is documented as the
  production setup path. `getting-started.md` and the README (EN/JA) carry
  the delivery-parity evidence and the controlled no-guide regression
  caveat.
- `SERVER_INSTRUCTIONS` (the MCP `initialize` instructions text — the
  only channel that reaches a host with no managed guide file) gains four
  stop-discipline sentences: stop after verification passes instead of a
  ceremonial re-read or diff sweep; a non-direct-proof verification gap
  does not close by re-running the entry it is attached to; a
  `receipt`/`prior` body is already held and should not be re-fetched;
  and a prepared certificate means discovery is closed and independent
  edits should batch into one `edits[]` call. Tool schemas are
  byte-unchanged; the instructions body grows from 753 B to 1,134 B
  (+80 o200k-tokens), a deliberate one-time investment in the one channel
  that reaches a guide-less host.
- Guide v77 (EN/JA) documents the compact `edit.applied` shape above
  (1-line `head`; `slice_sha`+`range`+`enclosing_symbol` prove the rest; a
  create's `applied_note` reads "=content sent"; read-back is a ready
  slice template) and the verification-honesty wording below (a
  per-target unproven gap, and a non-direct-proof label that never closes
  the task on its own). EN grows by 431 B / 111 tokens and JA by 408 B /
  123 tokens, an increase kept after auditing for a same-message cut
  elsewhere; the compact profile is effectively unchanged (-1 B net,
  after also removing some leftover pre-v75 wording).
- `AGENTS.md`'s non-managed contributor sections (repository table,
  verification, conventions, bench-archive safety) were reconciled
  against current behavior and tightened for length with no normative
  content lost — the archive-safety section alone shrinks by 135 B / 17
  tokens across 13 audited wording spots — and two accuracy fixes: the
  "Active designs" list now names `DESIGN-v0.12-plan.md` as the active
  plan of record, and the decision-run rep count now cites the v0.12
  figure (5, up from 3).

### Fixed

- The false-complete defect family reported by the external v0.11.1
  field evaluation: task-continuation `next` hints no longer truncate the
  query mid-word (all five `slice(0,60-80)` sites removed — a
  continuation carries the whole query, or a `qref` that restores it);
  the requirement model (surface roles and concern tokens) persists per
  task epoch in `taskContractStore` and is monotone until
  `taskEpoch:"new"`, so a narrowed same-epoch re-pack can no longer
  certify `complete` against the shrunken query; the primary
  certificate's action frontier incorporates same-epoch
  previously-served evidence; and `priorPackStore` now actually resets on
  `taskEpoch:"new"`.
- Stale-task bleed: the prepared-fence same-task test accepted ANY single
  shared token (protocol vocabulary included), so a substantively
  different follow-up could receive the previous task's certificate as a
  `decision-unchanged` receipt with no recovery call. The test now
  requires shared content tokens (≥2 and ≥0.5 of the smaller set), a
  shared signature token (identifier/path/quoted span), or a cross-form
  phrase match; projected receipts always retain an executable recovery
  `next_call`.
- False absence proofs on non-UTF-8 text: `find`/`queries[]`/`tree`/
  `references` sniff UTF-16/UTF-8 BOMs and exclude undecodable
  (NUL-riddled) files from scanned coverage, disclosing them via
  `omitted.undecodable` and withholding absence certificates over them —
  a UTF-16LE `.ps1`'s functions are now found where they were previously
  certified absent.
- Write-path corruption is structurally impossible for UTF-16/undecodable
  files: range edits, search/replace, multi-edit batches, read-and-edit,
  and rename refuse with `unsupported-encoding` (rename skips per file),
  and `writeExistingFileAtomic` refuses raw-NUL content as a last-resort
  backstop; specs prove refused files stay byte-identical on disk.
- `tl <command> <sub> --help` executed the real action in nine CLI
  commands (`workspace setup` performed a full setup, `setup` launched
  the interactive OS-package installer, `mcp start` started a real
  server, `logs reset` cleared usage state, `install-hooks` wrote git
  hooks, plus `agents update`, `skeleton build`, `clients activate`,
  `config`). A shared guard now prints usage on `--help`/`-h` anywhere in
  the argument vector, before any side effect.
- Verification kits no longer attach cross-language mock headers: the
  `mock_headers` candidate scan is gated on the edit itself being native
  C/C++, closing the reported case of a ~10 KB firmware HAL mock riding
  pure-TypeScript edits.
- Large-file exact routing: task_pack's internal text scan walked files
  only up to 1 MB while `search_files` scanned up to 8 MB, so a unique
  identifier deep in a large file was found by search but not by
  task_pack (which then served the file head). The locator now runs an
  additive wide scan for the 1-8 MB band, and `remaining_ranges` chunks
  are bounded (≤200 lines per side) so a `next` never names a
  7,000-line zoom.
- `classifySurface` recognizes top-level `shared/`, `types/`,
  `schema(s)/`, `openapi/`, and `proto/` directories as contract surfaces
  (previously only nested forms matched); the locator's role-diversity
  fill no longer resurrects comment-only-penalized candidates.
- Batch read projection keeps `note`, `concern_note`, `synthesized_range`
  and — for non-downgraded truncated slices — `remaining_ranges` and
  `next` on handles-batch entries; the wire allowlist silently dropped
  them.
- A construction-hub edit pack now serves the exact byte region a caller
  is expected to land a replacement in, verbatim, whenever the pack's
  already-served evidence doesn't cover it — instead of leaving the
  caller to copy an anchor from nearby text that could carry an elision
  marker and trip the write guard's `elided-content` refusal. The added
  window is small, capped, and unflagged; a representative case needed
  627 extra bytes to remove a 3-attempt recovery loop.
- Verification recipes now name, per edit target, an action with no
  workspace-proven syntax check, and label an entry that is not a direct
  proof of what it's attached to — using the existing `recipe.gaps`
  vocabulary — instead of silently implying every target and every listed
  check carries the same proof weight.
- A large Markdown file's `mode=skeleton` request no longer returns an
  empty "(no signatures detected)" dead end: it now serves a headings
  outline (up to 300 entries / 6000 B, with honest truncation) the same
  way a Markdown slice response already does.
- `search_files` (`find`/`tree`/`references`/`symbols`) no longer returns
  a fabricated empty/absent result for a path-scoped search made while a
  prepared answer or edit certificate is active. The certificate's
  read-residency receipt was intercepting these calls ahead of the
  existing certificate-bypass path and returning a receipt shape
  `search_files` doesn't speak, which a downstream step then read as "0
  matches."
- A `task_pack` call in the same session as an earlier prepared
  certificate now re-checks that certificate against obligations
  disclosed by a prior pack before treating it as still valid, and
  demotes a stale one instead of reusing it. The decision logic was not
  consulting the marker that records an obligation as unserved.

### Defaults

Every new v0.12 capability ships default OFF, matching v0.11:
`TL_DELTA_CONTEXT` is a class-(B) experiment flag in `util/flags.ts`, the
same posture as the rest of that class. Following a dedicated
live-engagement measurement probe, three v0.11 experimental read-economy
flags — `TL_POST_READY_TRIM`, `TL_OVERLAP_TRIM`, and
`TL_INTERFACE_AUTHORITY` (all already default OFF) — are retired: each
measurement round showed either the targeted solver shape not occurring
in the tested distribution, or no measurable live contribution once
ordinary packs already served the same evidence. Code and integration
tests for all three are kept as regression assets; none is an active
investigation line going forward.

### Release benchmark summary

The retained six-task decision archive produced 16 matched pairs in which
both arms passed verification (17 of 18 scheduled repetitions verified in
each arm). Aggregate verified task cost with TokenLighten was approximately
**28% lower** than with native tools only.

For comparison, the retained v0.11.1 run showed an approximately **21%**
lower aggregate cost, also across 16 matched verified pairs. The observed
reduction therefore widened by about 7 percentage points. The two runs used
the same six task classes, but different source revisions and evaluation
windows, so this is a descriptive release comparison rather than a causal
before/after experiment.

Among the clearer positive results, the artifact-driven rating-engine task
showed an approximately **57% lower** median cost and the multi-bug on-call
task showed an approximately **30% lower** median cost, across three verified
pairs each.

The narrowly scoped calculation task was close to parity. Results were more
variable when the two arms did not reach the same verification outcome, so
those cases are excluded from the numeric comparisons. Small known-location
tasks can also see less benefit because fixed MCP and guide overhead accounts
for a larger share of the work. These developer-run observations are not
guaranteed savings; results vary by repository, task, client, model behavior,
evaluation window, and provider pricing, and local estimates are not provider
billing records.

## 0.11.1


Two v0.12 pull-forward fixes on top of 0.11.0 (wave D), plus the v0.11
release-prep wave (reported issues #1-#4: task-profile binding, first-pack
precision, choose-candidate, host tool routing/discovery). The same wave's
hands-on testing also turned up and fixed five more defects: a stuck
task-pack receipt shortcut, a three-way answer-pack wiring disagreement, a
silent oversize-file drop in `search_files`, a broken `tl agents update`,
and imprecise answer-path evidence focus.

A VSIX field-report wave (2026-08-22, real use of the 0.11.0 extension with
Claude Code on a C# workspace) then fixed five more findings: create-intent
packs demoted to `discover` with unrelated siblings as likely edits,
workspace-name noise in `concern_note`, a terminal-signal-free `edit.applied`
on new files, dead-end discovery hops (dead same-file zoom, undocumented
`queries[]`/candidate bundling), and a status-bar click that only toasted.

Codex wave-13 (TL-CODEX-W13-WAVE-2026-08-22.md, same day) then closed the
tester's second report, made with the NEW server confirmed by `server_build`:
create-only `task_pack` on non-code files, the two argument refusals
(`mode=skeleton paths[]`, Markdown `sections` beyond the cap), a P0 internal
error on `paths` given as a string, concern tokens from hyphenated compound
identifiers, an invisible server build identity, and the usage panel's bare
"—". Version 0.11.1.

### Public release summary

Compared with the v0.9 public beta, v0.11.1 adds restart-safe task handles,
content-hash freshness and evidence-honesty disclosures, modern MCP transport,
bounded verification-aware edits, optional graph/retrieval/packing/reasoning/
wire experiments, paired attribution and calibration, and a diagnostics-focused
VS Code control surface. Experimental cores remain off by default unless a flag
or the Defaults section below says otherwise.

### Release benchmark summary

Across 16 matched, verified task pairs in the latest six-task developer decision
run, TokenLighten reduced aggregate verified task cost by approximately **21%**.
A cross-module telemetry-wiring task showed an approximately **33%** lower median
cost across three verified repetitions. A multi-bug task spanning flight control,
mixer behavior, and mode transitions showed an approximately **29%** lower median
cost across its two matched verified repetitions; a mixed-outcome repetition was
excluded.

Benefits were more modest for narrowly scoped calculation fixes and artifact-
driven implementations whose target package was already constrained. Small
known-location tasks can still pay more fixed MCP and guide overhead. These are
developer-run observations, not guaranteed savings; the broader v0.11.1 suite is
not a direct before/after comparison with v0.9.x. See
`release-docs/github-release-v0.11.1.md` for the public interpretation and
required comparison caveats.

### Added

- A gated medium TokenLighten guide profile is available through
  `tl agents update --profile medium` (and `--profile full` restores the
  default). It keeps the exercised task-pack/refusal/edit/zoom/verification
  rules at no more than half the full guide bytes; the public default remains
  `full`. Bench workflows can select `natural-onboarded-medium` independently.
- Go edits now build verification kits from same-package `*_test.go` files when
  a `go.mod` is present, including a `go test ./pkg/...` candidate and
  explicit dependency availability.
- MCP `initialize` now always announces a server-level `instructions` string
  (all three transport legs: the hand-rolled JSON-RPC leg, the legacy SDK v1
  leg, and the modern SDK v2 leg) naming TL as the first stop for every
  code/doc/config task, including unknown-location and multi-file discovery.
  Hosts that surface `initialize`'s `instructions` in their system prompt
  (e.g. Claude Code's "MCP Server Instructions") now see this before any
  per-tool description or routing decision, so TL is no longer silent at the
  one announcement point that reaches the host earliest (issue #4).
- `edit_file create:true` now carries an explicit terminal proof: the
  top-level `applied_note` ("post-edit disk state is the content as sent
  (sha/bytes/total_lines) — no follow-up read needed"; the create's
  `applied[]` entry is `{path, range:"1-<total_lines>", handle}` with no
  slice echo, since the caller has the content) and, when no test/mock/
  compile fact references the edited code, an explicit
  `verification:{status:"not-applicable",reason}` marker on any edit kind
  (distinct from the silent dedup of an already-served kit; budgeted
  separately in the Phase 5 compactness caps). Field report: agents re-read
  the handle after every create because the response carried no
  verification kit, no closure and no next.
- VS Code: clicking the status-bar item now opens a QuickPick (Diagnostics ·
  Enable/Disable/Set up for this workspace · Open TokenLighten sidebar ·
  Status). Diagnostics is a webview listing extension and TL versions, the
  node executable and resolved server launch command, workspace root, write
  permission (setting vs. whether `.mcp.json`'s entry passes
  `--allow-write`), registration files (`.mcp.json`, `.vscode/mcp.json`,
  `.codex/config.toml`), installed vs. bundled guide version, and the last TL
  calls (kind/tool/mode/ms/ok/error code), with Copy and Refresh.
- The server writes a per-workspace diagnostics ring
  `~/.tokenlighten/diag/<sha256(realpath root)[:16]>.json` (last 20 calls:
  at/tool/mode/kind/ms/ok/error_code — never query text, paths, handles or
  content; atomic 0600 writes; same gate as the usage recorder, so
  `TOKENLIGHTEN_USAGE_LOG=off` disables it). Usage observations gain
  optional `kind`/`mode`/`errorCode` for this mirror only; the persisted
  NDJSON schema is unchanged.
- `search_files` schema: `queries` and `query` gained descriptions — batch
  several identifiers in ONE call, each term reporting
  `status matched|absent|unknown` (`absent` = scope-complete for that term,
  no re-grep). The only signal used to be a reactive one-shot hint after two
  single-term finds. Schema 8622 → 8840 B (ceiling re-pinned).
- `server_build` (the exact build identity, `SERVER_BUILD_ID`) now rides
  `initialize` `serverInfo._meta` on the SDK transport legs and the hand-rolled
  leg, the per-workspace diagnostics ring (plus `retry` and `field` — argument
  name only — on refusal entries), the VS Code Diagnostics panel and
  `tl --version` (`0.11.1+<build>`), so a tester can tell which server binary
  the host actually launched.
- `read_file mode=skeleton paths=[…]` serves several files' skeletons in one
  byte-capped response (the unserved remainder comes back as `remaining` plus
  an executable `next`) instead of refusing with "path is required".
- VS Code usage panel and sidebar show calibration progress ("M/N paired
  samples", medium at 12 / high at 24) and a measured fallback line instead
  of a bare "—" while the paired-calibration confidence gate is unmet.

### Changed

- Tiny whole-file reads now use a task-local structure-first governor:
  the first six tiny full reads remain `read.text`, while later reads return
  `read.map` signatures with `remaining_ranges` and an executable slice
  continuation. `TL_TINY_SKELETON_CAP=0` disables the cap and a positive
  value overrides it; the final `TINY_TASK_CAP` stopper remains.
- Guide v75 (`2026-08-22-v75-read-mode-steering`) steers callers to batch
  known whole-file reads, use slice/symbol for partial files, avoid re-packing
  after a prepared decision, and scope `find` to known subtrees.
- Markdown/doc task-pack anchors now serve a substantive section or at least
  ±20 lines, and small affordable remainders are folded into the first pack.
- `read_file` and `search_files` advertised descriptions now name
  unknown-location/multi-file discovery and repo-wide/`.gitignore`-aware
  search respectively, replacing wording that read as a plain file reader;
  `edit_file`'s description is unchanged (issue #4).
- The TokenLighten guide's opening routing sentence (AGENTS.md/CLAUDE.md and
  the other managed-block targets, EN+JA+compact) now names Explore-style
  subagents and unknown-location/multi-file discovery explicitly, and spells
  out the native-fallback condition (a non-complete scope or a verified
  absence) rather than leaving it implicit. Bumped to guide v70
  (`2026-08-21-v70-discovery-routing`).
- The guide's `edit.applied` bullet now says `core`'s `counts` are per
  FILE, not per edit item, after a field report showed an agent misreading
  a 3-item batch as partially failed. Bumped to guide v71
  (`2026-08-21-v71-counts-per-file`).
- The guide's prepared-fence and receipt bullets now say a read/search of
  unserved scope after `prepared` is still served (cheap, not a cue to
  re-pack) and a `decision-unchanged` receipt is acted on immediately —
  `taskEpoch:"new"` is reserved for a genuinely different task. The v0.11
  decision run measured solvers that explored before editing burning 5-7
  generic re-packs per cell chasing bytes a served-but-unread response
  already carried (F-R12). Bumped to guide v72
  (`2026-08-22-v72-receipt-is-not-a-repack-cue`).
- Task-profile auto-binding now tiers the DESIGN-v0.9 §14 misfire
  guardrail instead of always demoting an inferred "answer" to generic:
  under `auto`, a genuinely interrogative/comprehension-shaped query
  (widened answer-intent markers, e.g. 「〜を理解したい」, "which codec does
  the pipeline choose for a response?") binds straight to `answer` in one
  call when the query carries no defect-symptom marker (extended EN/JA
  vocabulary: missing, ignore(s|d), duplicate(s|d), timeout(s), "why
  doesn't/isn't/don't...", 抜け, 漏れ, 重複, 二重, されない, はず, etc.). Bare
  analysis/investigation wording with no interrogative marker ("assess X",
  "analyze X and propose improvements") still pays the round trip — that
  shape is exactly what the original 2026-07-25 misfire guardrail protects.
  Symptom-question phrasings on edit tasks also still fall back to the
  unchanged §14 reason and pay the declared-`taskProfile` round trip.
- A candidate-list task pack no longer asks the caller to confirm when one
  candidate strictly dominates the rest on role, evidence-match, and
  source-ness (e.g. a `filename-match` hit on an `api`-role source file next
  to a lone `exact-text` hit in an `unknown`-role script): the winner's body
  is served and the rest demote to inventory, so the pack routes through the
  normal answer/edit/discover path instead of `await_input`/`choose-candidate`.
  Genuine ties (identical role, evidence match, and source-ness) are
  unaffected and still ship `choose-candidate` with every tied candidate.
- A prepared certificate (`act.edit`/`act.answer`) no longer stonewalls
  read-only discovery of scope it never served: `search_files` (any action)
  and `read_file` in any mode other than `task_pack` now reach the ordinary,
  fence-independent serve/dedup path even while a certificate is live,
  instead of an unconditional `decision-unchanged` receipt (already-served
  ranges/handles still receipt `code-unchanged`, unchanged). `task_pack`
  itself stays gated, since a fresh pack always mints a new certificate.
  When a `decision-unchanged` receipt is still emitted (a same-epoch
  `task_pack` re-ask), its `next` is never a `taskEpoch:"new"` re-pack
  synthesised from the refused call's own inbound args — that mechanism
  re-armed the fence with a fresh certificate on every discovery call it
  stopped, fragmenting certificates across epochs (measured: 27 such
  re-packs / 290 KB in one bench run, T09 rep1 alone 8 receipts -> 8
  re-packs); the receipt's required `certificate` member is now treated as
  its own Form-1 restatement, so `next` is correctly omitted instead.
- Guide v73 (`2026-08-22-v73-create-proof-and-batched-discovery`, EN+JA,
  compact gets the search line only): several outstanding identifiers → ONE
  `search_files queries=[…]` call, never serial single finds; on a
  candidate list run a carried bundle `next` first, else an `answer` task
  re-packs ONCE with `read_file mode=task_pack paths=[<candidates>]`
  (+`qref`), a `generic` task keeps "served bodies when safe, else ask";
  `create:true`'s own `sha`/`bytes`/`total_lines` (+`applied_note`,
  `slice_sha`) IS the terminal proof — no read-back;
  `verification.status:"not-applicable"` = nothing to verify through TL.
- `@tokenlighten/agents-md` exports `INSTRUCTIONS_VERSION` from a new
  `version.ts` (`./version` and `./sentinel` subpath exports); `render.ts`
  re-exports it unchanged. A CJS bundle (the VS Code extension) can now
  import the stamp without evaluating `render.ts`'s `import.meta.url`
  template-dir resolution, which throws under esbuild CJS.
- Lenient wire shapes at the dispatch boundary: `paths` given as one string
  becomes `[string]` (any other non-array is a structured refusal, no longer
  a JSON-RPC internal error); `range` accepts `N:M` and open-ended `N-`;
  `lines` and `start`/`end` are accepted as `range` aliases; `search_files`
  `action` aliases (`grep|search→find`, `list→tree`, `definitions→symbols`,
  `usages|callers→references`), a missing `action` with `query`/`queries`/
  `symbol` infers `find`, `find` accepts `symbol` as its query, `queries` as a
  string becomes `[string]`, a `query` array becomes `queries`; numeric
  strings for `limit`/`maxTokens`/`maxBytes`/`depth` and boolean strings for
  `regex` are coerced (`"false"` no longer means true). Refusals that remain
  (`mode=slice` with several `paths`, `symbols` with nothing to scope) carry
  an executable `next`.
- Markdown `sections` requests beyond the per-call cap serve the first
  headings and return `remaining_ranges` plus a `next` for the rest instead
  of refusing.
- Guide v74 (`2026-08-22-v74-create-target-frontier`, EN+JA): `act.edit`
  with `create_target` and no `frontier` means the target is absent — call
  `edit_file create:true path=<create_target.path>` now, no existence check.
- All packages are 0.11.1 (`SERVER_PACKAGE_VERSION_FALLBACK` included). The
  POSIX managed launcher shim tries its recorded CLI path before any other
  `tl` on PATH, and `tl workspace setup` self-checks the launcher it wrote
  (reporting `server_build`).
- Guide v76 (`2026-08-23-v76-guide-consolidation`): the decision bullet no
  longer restates `taskEpoch:"new"` (the standing rule already says it), the
  search bullet's two absence glosses are merged, a `scope_inferred` clause is
  added ("a pathless query may auto-narrow to one subtree — widen with
  `paths` only if the answer lies elsewhere"), and the `create_target` /
  `create:true` clauses are trimmed; EN 9487 → 9469 B, JA 9415 → 9389 B,
  compact/medium unchanged. AGENTS.md's contributor sections now name v0.11
  and `DESIGN-v0.11-expansion-plan-reconciliation.md`; release-docs known
  limitations are labelled 0.11.1.

### Fixed

- The post-edit `unread_note` no longer fires for a single-file edit whose
  summed per-item hunk size is at most 40 lines, unless a code-shaped hunk
  identifier occurs in the flagged sibling. `TL_UNREAD_NOTE_SPECIFICITY=off`
  restores the old behavior and `TL_UNREAD_NOTE_MAX_HUNK_LINES` overrides
  the boundary; large multi-file edits retain the existing safety note.
- A pathless `task_pack` whose initial locator abstains now retries once
  through the existing seeded-pack path when the query identifies one
  high-confidence project subtree. Successful retries carry additive
  `scope_inferred:{path,reason}`; a failed retry returns the original honest
  partial pack without weakening `buildPartialPack` coverage invariants.
- A full read after a partial task pack now serves every unserved range plus
  prior provenance for the already-served range; `force_serve` bypasses the
  served ledger, and recorded task-pack ranges match the bytes actually sent.
  Prior-only outcomes are receipts with an executable slice continuation,
  never body-less `read.text` responses.
- The first `task_pack` for a multi-concept question now lands on the code
  that answers it. Inside a filename-matched file the served slice is chosen
  by which symbol carries the query tokens the NAME did not — preferring a
  top-level declaration and, among equals, the one whose own body (not its
  doc comment) is about that concept — instead of whatever declaration an
  earlier layer happened to surface first, which was routinely the file's
  first symbol. A top candidate covering strictly more distinct query
  identifiers than every runner-up now resolves the pack instead of tying
  them into a `choose-candidate` list. And the definition the primary
  delegates to — a workspace-local import its body calls — is admitted to the
  frontier even though nothing in the query names it, and even though it
  shares the primary's surface.
- A basename no longer name-matches a query token whose span exists only
  because compaction removed a word boundary: `readCodeCaps.spec.ts` compacts
  to "readcodecapsspec" and so matched (and outranked real hits on) every
  "codec" query. Matches within one name word ("repo" in `qkf-report`) and
  exact joins of consecutive words ("logrotator" for `log_rotator`) are
  unaffected.
- The wire-codec observation channel now works through real dispatch:
  read/search calls thread their resolved workspace into a dedicated
  trace-only context field, so `wire_codec_shadow` / `wire_codec_v2_cell`
  records actually land (previously structurally unreachable — the field
  they gated on was set only by edit paths, which are permanently
  codec-ineligible). Trace-only; default-path wire bytes are unchanged.
- The raw-block codec (`tl-raw-1`) can now extract `read.text`'s real body
  shape (`evidence[i].body`), making v0.11's flag-gated read.text widening
  functional instead of vacuous. Old payloads encode byte-identically; the
  JSON round-trip oracle is unchanged; nothing new is enabled by default.
- Exact-reissue task-pack receipts are now reachable for qref replays: the
  guaranteed-receipt preflight consumes the resolved query (previously raw
  pre-resolution args, so the bypass never fired on the wire's documented
  replay mechanism) and the served-pack record carries its own
  `workspace_state`, so unchanged cumulative/carry-forward replays receive
  the `pack-unchanged` receipt instead of a full rebuild that also demoted
  the caller's `prepared` certificate. Freshness proof is unchanged — any
  changed served byte or inventory drift still refuses the receipt; partial
  surfaces still decline; `taskEpoch:"new"` still clears.
- `force_serve:true` on a qref replay under a prepared fence now returns
  full bodies as PI-09 requires (it was previously answered with a receipt).
- `tl agents update` / `tl agents-md write` (the plain, non-`--for-target`
  path) now works: it called a `generate` export that `@tokenlighten/agents-md`
  has never had (confirmed back to the commit that introduced the command),
  so every invocation failed with "has no exported 'generate' function". It
  now calls the real `injectAll` API — the same one the working `tl-agents`
  bin uses — and gains `--root`, `--locale`, `--force`, and `--check`
  options mirroring that bin's already-shipped behavior.
- `search_files` `find`/`references` no longer silently drop a >1MB source
  file from the scan while asserting a complete inventory or a certified
  absence over it: the shared walk's oversize ceiling for these two
  plain-text/identifier scans is now `TEXT_SCAN_MAX_FILE_SIZE_BYTES` (8 MB,
  mirroring core2/walk.ts's already-validated bound) instead of the 1 MB
  default every other `walkCodeFiles` caller (task-pack, tree, rename,
  role/symbol indexing) keeps unchanged. For a file that is still genuinely
  oversize even under the raised ceiling, `find`'s `inventory_complete:true`
  now carries an inline caveat whenever the walk skipped anything (not just
  on the already-truncated path), `references` tracks and discloses walk
  omissions for the first time (`omitted`, same vocabulary as `find`), and
  neither action's absence certificate (nor a `queries[]` term's
  `term_results[].status`) is ever asserted `absent` while an oversize file
  could be hiding the token — it reports `unknown`/no certificate instead,
  same "unknown remainder" treatment the unreadable-directory gate already
  had. `tree`'s `scope_report.excluded_by_reason.oversize` disclosure was
  already honest and is unchanged. Field-reported live against this repo's
  own 21k-line `readCodeTaskPack.ts`.
- An answer-shaped task pack carrying the sanctioned served-zoom affordance
  (`route.action==="answer_from_handles"` with `max_additional_tl_calls:1`
  over a required surface this same response left partial) no longer
  degrades to `discover`/`inspect_handles`. Three sites disagreed about when
  the affordance holds: `reconcileContentSufficiency` downgraded the route
  to `inspect_handles` unconditionally whenever `task_profile==="answer"`;
  `buildTaskExecutionContract`'s acceptance gate still rejected the pack on
  the affordance surface's own (expected) unresolved obligation, so no
  certificate was ever minted; and `deriveCanonicalTaskDecision` re-forced
  `discover` on any `remaining_ranges` regardless of budget. All three now
  share one predicate, `hasServedZoomAffordance` (canonicalDecision.ts): a
  served-zoom-affordance pack reaches `act.answer` with a real certificate,
  exactly as "prepared+partial primary grants
  `route.max_additional_tl_calls=1`" already stated, while a genuinely
  starved OTHER required surface still blocks acceptance as before.
- The answer-profile (`taskProfile:"answer"`) evidence-focus path is now
  precise instead of being dominated by whichever same-file symbol has the
  shortest name. A locator-anchored symbol (import-edge delegation target, a
  direct query-symbol hit, a filename match refined to the outstanding
  token) is preserved instead of being demoted to a file header or an
  unrelated constant purely because the header/constant's short name covers
  a larger *fraction* of itself in the query; a real function/method/class
  is generally preferred over a header/const/type/interface when nothing was
  explicitly named, except when the query substantially names the file
  itself (its answer legitimately is the header — "what does the coverage
  packer do" — as opposed to naming the file only incidentally while asking
  about a specific behavior — "which codec does the pipeline choose"). A
  weak/common token match (a CSS `cursor:` property, a generic symbol name)
  can no longer by itself pull a style/doc surface, or a surface from a
  project root other than the one the query's strong evidence lives in, into
  an answer pack about code; when the pack's own admission filter has to
  drop such evidence, coverage now reports `partial` instead of falsely
  claiming `complete`.
- A Japanese (or other query with no ASCII whitespace) naming two or more
  symbols is no longer treated as a single-token query — token counting now
  extracts actual identifiers instead of splitting on whitespace, restoring
  the multi-identifier disambiguation path for such queries.
- The per-token symbol search widened its raw candidate fetch and now ranks
  the wider pool by declaration kind (function/method, then class, then
  other) before truncating, so a short discriminating token (e.g. "codec")
  no longer has its true target truncated out by unrelated same-token
  symbols the fetch happened to visit first.
- In a monorepo (a workspace whose own root is not itself a marked
  project), a candidate that isn't inside any real marker root no longer
  counts toward the dominant-root vote — a manifest-less directory could
  previously out-vote the actual target's real project root.
- A query naming a dotted `Class.method` (or `Class#method`) pair — e.g.
  "CommentService.create" — now resolves directly to that class's declaring
  file, anchored on the named method when it exists there, instead of
  relying on the method name alone and risking an unrelated same-named
  symbol.
- When a filename match alone already covers every query token, the served
  anchor is now the file's best substantive declaration (a function, method,
  or class over an interface, type, or const; ties broken by how much of
  the query the declaration's own name covers) instead of unconditionally
  falling back to the file's first declaration.
- `scripts/tl-probe.mjs --trace` now prints the spawned server's stderr and
  the on-disk trace file path (or a clear "no trace file" note) on a
  successful call, not only on failure.
- When two files share a matched basename and one is a pure re-export
  barrel (`export * from`/`export { x } from` with no declarations of its
  own), the barrel is now demoted below the file it re-exports, instead of
  the two competing on equal footing with file-walk visitation order
  silently deciding the winner.
- A sibling/enum-family enumeration scan can no longer be seeded by a
  low-confidence, purely textual "contract" match (a coincidental substring
  hit in an unrelated project) — the seed must be reachable through an
  actual targeted symbol/name match, and the resulting scan stays confined
  to the seed's own project root, so an unrelated file can no longer be
  force-admitted as required alongside it.
- A query mentioning a word that is also a generic CSS property name (e.g.
  "cursor") no longer pulls in unrelated stylesheets on that basis alone; a
  query-distinctive word that genuinely appears in a stylesheet's class name
  is unaffected.
- A pack-augmentation pollution defect (W4-A, R0): a task_pack query naming a
  TypeScript file and symbol could serve several unrelated C/C++ files from a
  foreign project root (e.g. a `bench/fixtures/` sibling) while never serving
  the named file at all. Root cause was a near-zero-confidence, out-of-root
  text hit (already penalized almost to nothing by the existing dominant-root
  demotion) that nonetheless survived into `related`/the surface set and was
  then trusted, unconditionally, to seed a full header/source-pair + `#include`
  closure and to win a surface-role slot on diversity grounds alone. Four
  admission points now apply the same dominant-root + targeted-evidence
  discipline: the locator's C/C++ closure expansion only seeds from a
  candidate that is both in-root and reached through a targeted (not plain
  full-text/variant/reference) match; the pack's own role-diversity surface
  selection and its C/C++ header/source-pair augmenter apply the identical
  gate; and the negative-retrieval "readiness falsification" pass — previously
  unscoped for any pathless query — now confines its counterexample search to
  the task's own trustworthy root instead of the whole workspace. A
  query-named file (an explicit `<name>.<ext>` mention) can now evict a
  weak, query-ungrounded surface to make room when the surface budget is
  already full, instead of being silently dropped; and resolving a bare
  basename query-named token (e.g. "server.ts") that exists under more than
  one project root now prefers the match inside the task's own root over an
  arbitrary alphabetically-first namesake elsewhere in the workspace.
- An uncovered-concern check or its `search_files`/`discover` follow-up call
  could report a camelCase or snake_case identifier the query itself named
  (e.g. `buildInitializeInstructions`) under a silently lowercased spelling
  (`buildinitializeinstructions`) distinct from the one actually anchored in
  the served evidence, and — independently — could report a query-named
  identifier as "uncovered" even once the exact surface anchoring it was
  served, purely from a case mismatch inside the coverage check itself. Both
  traced to one shared token-dedup helper silently lowercasing every token on
  output regardless of a caller's own case-preserving work upstream, plus two
  concern-matching helpers whose own doc comments already promised
  case-insensitive matching but implemented it inconsistently. Token
  case is now preserved end to end (dedup stays case-insensitive; the
  first-seen spelling is what is reported), and every remaining concern-token
  comparison against a lowercase-only vocabulary set is explicitly
  case-insensitive.
- The `answer`-profile task pack now inherits the locator's own verdict
  instead of re-opening its own candidate-list from independent re-ranking.
  When the locator resolves a primary — including via a new abstain
  recovery that re-anchors on a candidate the query names by its own file
  and re-locates it (path scoped to its directory, symbol pinned), rescuing
  cases where a same- or higher-confidence decoy (a bench-fixture prose
  match, a spec file quoting the query text verbatim) otherwise wins the
  raw ambiguity race — the pack now (a) keeps that primary as the pack's
  one primary, never displaced by independent re-ranking; (b) always
  carries the locator's `required` related surfaces (import-edge/
  query-symbol neighbours) into evidence, front-loaded ahead of anything
  else so a capped selection can never crowd them out; (c) serves an
  answer-path-discovered extra (a responsibility/facet hit unrelated to the
  primary, e.g. a same-topic sibling file with no import/call edge to it)
  as additional evidence below the verdict, never as a co-primary or sole
  answer — except when the "extra" names the SAME file as the primary
  (a within-file symbol-focus correction, not a competing file: the
  colloquial-identifier "semantic-responsibility" resolution this also
  covers is unaffected); (d) still returns a genuine candidate-list when
  the locator itself abstained as ambiguous. Example:
  「pipelineがどのcodecを選ぶか」previously produced a two-way
  `choose-candidate` between the primary and an unrelated facet hit,
  discarding the locator's own import-edge neighbours entirely; it now
  resolves straight to a certified answer carrying the primary plus both
  import-edge callees.
- The negative-retrieval "readiness falsification" pass's pathless-query
  fallback scope (previously fixed against a whole-workspace leak) still
  leaked outside the task's own dominant root when its trustworthy-anchor
  set mixed a nested-package code surface with a bare workspace-root
  supporting surface (e.g. a top-level design doc): `roleSearchScopePrefixes`'
  shared-ancestor branch degraded to a bare `""` prefix — ROOT-MEMBERSHIP
  semantics matching every file the workspace root does not delegate to a
  nested package (`bench/`, `scripts/`, any other top-level tree) — and
  served a 9.4KB slice of an unrelated bench harness as a "competing
  implementation". The fallback scope now anchors on the DOMINANT
  (code-bearing) trustworthy surfaces first, excluding doc/unknown-role
  anchors, and falls back to the full trustworthy set only when nothing
  code-bearing survives (a genuinely doc-only pack is unaffected). A
  counterexample now also (a) prefers a same-root test/spec surface over any
  other file; (b) never serves a role-unknown file once a same-root test
  exists; (c) caps its served body at 2KB via the same centered/
  graceful-truncation slicing every other oversize surface already uses,
  instead of an unbounded +-18-line window.
- `extractTextSearchQueries`'s flat 8-char ASCII floor never ran a Layer 3
  text search for a short (4-7 char) discriminating identifier (e.g.
  "cursor", "codec") even inside a multi-identifier query whose surrounding
  tokens already prove it is not noise. The floor now lowers to 4 characters
  for a query with >=2 extracted identifier tokens, excluding a stop-list of
  generic short programming nouns/verbs ("type", "list", "read", "call", ...).
  This surfaced a latent gap in `buildSeededTaskPack`'s confined
  directory-seeded role-fill: once more files could tie at full confidence on
  a shared short token, its role-fill sort had no preference for an
  IMPLEMENTATION file over its own declaration/header on a tie (falling
  through to a bare alphabetical tiebreak, which could pick the header), and
  a header-only pairing candidate (`why:"header-source-pair"` — a derived,
  not-directly-matched provenance) could independently win an empty role
  slot in this same confined loop and then satisfy a
  `concernGroupMatchesSurfaces` coverage check on nothing but an incidental
  path-substring match, silently starving the concern-group augmenter of the
  chance to find the real implementation. The confined role-fill now (a)
  prefers an implementation path over a declaration/header on a
  same-confidence, same-identifier-bonus tie; (b) no longer lets a
  header-source-pair candidate independently seed a role in this loop (the
  dedicated, properly scope-confined `augmentNativeSurfaceClosure` pairing
  step still covers it for whatever surface set survives here).
- An explicit `<file>.<ext>` + camelCase-identifier query (e.g. "server.ts の
  buildInitializeInstructions...") could serve an unrelated sibling file as a
  REQUIRED edit alongside the real target, or — with a few more ordinary
  English words in the query — abstain into a `choose-candidate` list among
  several such false positives. Root cause: a basename word that is merely a
  short SUBSTRING of the query's own compound identifier (e.g.
  "instructions"/"build" inside "buildInitializeInstructions") was treated as
  independent evidence, so any file whose name happened to share one common
  word with the resolved identifier (plus the query's own separate ".ts"
  filename mention matching that file's basename exactly) cleared the
  2-distinct-token admission bar. A pack-level filter now re-checks every
  "filename-match" surface once the pack's own resolved, workspace-unique
  identifier is known, dropping a fragment-only match to a DIFFERENT file
  (and, independent of that, no longer letting a single generic word — e.g.
  "issue" inside an unrelated "...Reissue..." file — carry a match on its
  own); a file's own resolved identifier still matches normally on every
  basename word it legitimately covers (the two-domain-wiring case). A "doc"
  surface (CHANGELOG/README/contract prose) also no longer inherits a
  REQUIRED-edit obligation purely from landing first in the surface list once
  a stronger false-positive ahead of it is removed.
- `search_files`-style basename/filename matching no longer treats TL's own
  managed guide block (the sentinel-delimited section AGENTS.md/CLAUDE.md and
  the per-client stub mirrors carry) as task evidence: that text is TL's own
  operating protocol, already delivered to the host, and its dense,
  protocol-describing vocabulary ("server", "always", "handle", ...)
  otherwise wins a doc-contract match against almost any two-word query. A
  markdown file's OWN prose outside the block remains eligible exactly as
  before.
- A comment-only (non-behavioral) request could still be told it needed a
  REQUIRED test-file edit: the readiness-falsification negative-retrieval
  pass classified this workspace's own `__tests__/*.spec.ts` files as
  "implementation" (its exclusion regex matched only a bare `test`/`spec`
  path segment, never the `__tests__` directory or a `.spec.`/`.test.`
  filename suffix), making any spec file eligible to out-rank, or serve as a
  false "competing implementation," the file it actually tests. Also fixed a
  second-order case the first fix exposed: the same pass could pick up a
  file's own PROSE comment about the query's identifier (e.g. a historical
  bug-fix note) as "competing" evidence; only a match in the file's real code
  (comments stripped) now counts, and only a strong (named-identifier or
  wiring-endpoint) match — never a same-file generic-word coincidence — can
  force a REQUIRED obligation.
- `edit_file`'s `unknown-arguments` refusal now says WHERE a misplaced key
  actually belongs instead of only naming it unknown: a per-item `edits[]`
  key that is really one of edit_file's TOP-LEVEL arguments (`review`,
  `operation_id`, `cwd`, `lane`, `allowPathFallback`, `intent`, `lang`,
  `mode`, `to`, …) is called out by name ("`review` is a top-level
  edit_file argument, not a per-edit key — move it up") with `did_you_mean`
  populated, and a per-item `replace_all` (the native Edit tool's
  vocabulary, not advertised at either nesting depth) is told to use
  `precondition:"unique-match"` or one `edits[]` item per site instead.
  Measured (2026-08-22-v011-decision-6t-1, T05c rep0 arm A): both shapes
  previously cost a full round trip because the refusal's `keys` list only
  ever showed the per-item advertised set, with no evidence the caller's
  key was real anywhere on the wire.
- An `edit_file` target whose handle or path is outside the current
  certificate's frontier no longer gets a bare `challenge` invitation and a
  same-frontier template it cannot use when every refused target
  independently resolves through this session's own handle registry (i.e.
  it was served by an earlier, now-superseded epoch/pack of the same task,
  not a foreign or hallucinated handle): the refusal now carries
  `retry:"call"` with a real, placeholder-free `next` that re-establishes a
  covering certificate over exactly those targets
  (`read_file mode="task_pack" taskEpoch:"new" paths:[...]`), and
  `also_admissible` names the refused handles/paths so the caller sees they
  are known rather than foreign. A batch mixed with a genuinely unresolvable
  handle, or a target this session never served, keeps today's
  frontier/challenge guidance unchanged. Measured (same transcript): even
  after the caller found this same repack on its own, it cost two more
  refusals (an unknown-argument retry, then a `not-found` range guess)
  before the edit actually landed.
- A `task_pack` that names a NEW file together with its content ("Create
  tmp/TlProbe.cs with the following content: ```csharp …```") in a
  non-empty directory no longer demotes to `discover` listing unrelated
  sibling files as evidence/likely edits. The create target was resolved
  correctly, but the post-trim content-sufficiency pass treated the first
  locator hit as a mandatory edit target and wrote `needs-followup`, which
  the create re-assertion never cleared, so the execution contract was
  refused. The create target is now the authoritative frontier
  (`content_sufficiency`, `coverage`, `missing`, `blocking_next_steps`
  replayed; the stale "concern(s) not covered: <target>" check dropped), and
  JA queries that name the target only by an extensioned path (no
  ファイル/モジュール noun) resolve it too. An empty-directory create was
  already `act.edit`; non-create packs are byte-identical.
- `concern_note` no longer names the workspace directory: the basename and
  path spans of the workspace root mentioned in a query (`m365-drive-mount`,
  `/…/m365-drive-mount/tmp/X.cs`) and a `path`-only `task_pack` used to seed
  the session's concern tokens, so an unrelated file whose identifiers
  happened to contain those words (`NativeMethods.cs`'s
  `M365DriveMountRegistryKey`) got a "session-query tokens (m365, drive,
  mount) hit outside served range" note. Harvest text is stripped of root
  basename/path spans first, `queries[]` entries that are the basename or
  contain a path separator are skipped, and tokens under 3 chars or purely
  numeric are dropped; standalone words in prose are untouched.
- Verification-kit K2 relevance gate: the edit-side identifier set was
  tokenised with a different rule (≥3 chars, no stopwords) than the kit
  side, so a hunk touching only a short identifier (`Add`) could never match
  its referencing test and the kit was silently dropped. Both sides now share
  `identifierTokens`; a hunk naming `Calculator` behaves as before.
- Discovery dead end: an answer pack focused on ONE query-named symbol
  (`coverage:"focused"`) whose other explicit identifiers stayed uncovered
  (gap `ambiguous-target`) handed the agent a `next` that zoomed the SAME
  file's remaining range (15 lines of `using` boilerplate) and then stopped —
  the remaining collaborators were left to the agent's own find+read pairs
  (the reported read_file×6 + search_files×3 for one implementation-path
  question). The gap now names ONE batched `search_files action=find
  queries=[uncovered identifiers]` (word-boundary absence in every served
  body, ≤5 tokens, never on a `complete` pack) and the decision projector
  prefers it over the served-evidence zoom. On the C# reproduction the whole
  path closes in 3 TL calls (pack → find → qref+paths re-pack, coverage
  complete) instead of one dead zoom plus a manual fan-out.
- A read-only (`answer`) candidate list in which no candidate dominates now
  arrives as `discover` carrying the bundle re-pack `next`
  (`read_file mode=task_pack qref+paths=[all candidates]`) instead of
  `await_input/choose-candidate` with no next; generic/edit profiles keep the
  ask (edit safety). On the reproduction: pack → bundle re-pack → coverage
  complete, where before the agent had to invent the re-pack itself.
- Path spans in a query no longer become identifiers: an absolute/home/
  relative/Windows-drive path or any ≥3-segment `/`-joined span mentioned in
  prose ("In /Users/me/git/repo/packages/… how does X call Y?") used to be
  split into tokens that became `explicit-identifier` obligations (never
  certifiable), `behavior-body` facets ("missing query facets: users, me,
  git, …") and `search_files find queries=["users","me","git",…]` next
  calls. A shared `stripPathSpans` now runs before identifier extraction at
  the obligation, find-next, concern-harvest, wiring and locator sites; a
  bare `name.ext` and one-separator references (`@scope/pkg`) are untouched
  and a stripped span's own basename is re-admitted for filename matching.
- Create packs no longer carry `likely_edits` on the sibling files served
  for imitation (the edit target is the new file named by
  `next`/`route`/`create_target`), and the byte-budget fallback envelope
  keeps `create_target` + the create route instead of dropping back to
  `discover`.
- create-only `task_pack` for non-code files: `CREATE_TARGET_EXT_RE` now also
  admits txt|md|json|jsonc|yaml|yml|toml|xml|html|css|sql|csv|ini|cfg|env|
  ps1|psm1|psd1|bat|cmd|graphql|proto|tf|properties (a curated list under the
  unchanged create-intent / target-absent / not-served gates), so "Create
  TL_SMOKE.txt with …" resolves a `create_target` instead of falling into the
  generic path, which certified a confident but WRONG `act.edit` on an
  unrelated existing file. A resolved create target now yields an empty
  `frontier` — the certificate's `action_frontier`, wiring `edit_frontier`
  and non-target edit obligations are cleared unless an independent edit
  genuinely exists — matching decisionWire's "create-only decisions omit
  frontier".
- concern tokens from hyphenated/dotted compound identifiers (`Mount-Drive`,
  a bare `M365-Drive-Mounter-Manager.ps1` mention): a compound is harvested
  as ONE token and its fragments are not recorded; the camelCase name-words of
  the workspace root (`M365DriveMounter-dev` → m365/drive/mounter/dev, plus
  prefix matches such as mount ⊂ mounter) are excluded from concern harvest
  and from `queries[]` entries. Hyphenated roots keep their words as ordinary
  prose vocabulary (precision guarantee).
- Replay corpus 258 → 266 cases (create ext coverage, lenient shapes,
  skeleton batch, sections continuation, compound concern tokens).
- Task-profile auto-binding: a query that asks for a change AND an
  enumeration/explanation (JA bare te-form 「修正して、…一覧も列挙して」, EN
  "fix … and list the affected types") binds `generic`. Before, the bare
  te-form missed the mutation gate, 「一覧」 inferred `answer`, and although
  the §14 guardrail demoted the profile to generic the `answer_from_handles`
  route still fired — a pathless T07-style query returned `act.answer` with
  the right evidence; it now returns `act.edit`.
- Concern tokens: the workspace root's name-words are excluded for ANY
  multi-segment root (hyphen/underscore/dot as well as camelCase) — in a
  `m365-drive-mount` workspace neither prose "mount" nor `queries:["mount"]`
  seeds a concern token any more; compound identifiers
  (`NetResourceMountPoint`) are unaffected and single-word roots unchanged.
- Create-with-content `task_pack`: the locator, evidence/role-filler, concern
  and wiring builders run on the query with its fenced code blocks stripped
  (create-target resolution, profile binding, the wire echo and the dedupe
  fingerprint keep the full query), and a create-only pack's evidence is
  capped to files in the target's directory (or nearest existing ancestor)
  unless an independent edit target is proven — the unrelated siblings pulled
  in by content vocabulary (4 files on the C#/PowerShell reproductions) are
  gone. Replay `tew3_1_dotted_module_create_route` flips `discover` →
  `act.edit` for the same reason (its old evidence was two decoy files).

### Defaults

- `TL_INDEX_CONSISTENCY_SCAN` (Incremental Index / Graph Update v2 self-heal,
  `packages/skeleton-engine`) is now default ON; opt out with
  `TL_INDEX_CONSISTENCY_SCAN=0`. Reclassified `util/flags.ts`'s D10 class
  (B) → (C): content-only, no wire kind/field/argument, same posture as
  `TL_GRAPH_INDEX`. Rationale: the in-process manifest-memo whole-match
  shortcut demonstrably serves stale symbol data indefinitely, within one
  long-lived server process, for a same-stat (size+mtime) external write
  that skips `invalidateCachedWorkspaceFiles` — reproduced end-to-end
  against the real server via `search_files action=symbols`. Cost is
  bounded by design (a capped, sampled scan) and measured at
  tens-to-low-hundreds of ms on a same-process warm call; a cross-process
  cold or per-file-loop warm call pays effectively nothing extra, since the
  existing content-hash gate already re-verifies every file's bytes on
  those paths regardless of this flag.

## 0.11.0

Expansion release: nine flag-gated retrieval/packing/reasoning/wire/write
cores extending v0.10's foundation, plus a serve-honesty completion and a
kickoff baseline repair. Every new capability ships dark.

### Added

- Graph Evidence / Impact Analysis v1 (`TL_GRAPH_EVIDENCE`): a derived,
  bounded evidence overlay over the existing graph and reference indexes —
  typed edges, per-edge provenance, direct/structural/heuristic impact
  classes, and mandatory expansion caps. Pure library this release; its only
  production caller is Compound Retrieval below.
- Task-aware Weighted RRF v2 (`TL_RRF_PROFILES`, composes with
  `TL_RRF_FUSION`): seven task-family retrieval profiles with per-retriever
  fusion weights and a weak-retriever quality gate layered on the v0.10
  hybrid fusion path; hard floors stay unconditional. Holdout-tuned, not yet
  decision-scale adjudicated.
- Coverage Packer v2 (`TL_COVERAGE_PACKER_V2`, composes with
  `TL_COVERAGE_PACKER`): concern-decomposed, obligation-aware packing
  (body/inventory quota split, dedup exemptions, residual-gain-gated
  complementarity, saturation) plus a prior-pack store that threads
  `change_contract` obligations across repacks; falls back to v1 on low
  confidence.
- Task Reasoning IR v2 (`TL_REASONING_IR_V2`): versioned reasoning deltas,
  an obligation dependency DAG, hypothesis tombstones, and trace-only Shadow
  Stop candidates, checkpointed as one CAS'd `ir2:`-namespaced record inside
  the existing per-workspace task state store. Advisory and trace-only — no
  wire kind, field, or tool argument.
- Compound Retrieval (`TL_COMPOUND_RETRIEVAL`, composes with
  `TL_GRAPH_EVIDENCE`): a bounded, read-only
  definition→references→representative-consumers→tests/config hop closure,
  appended strictly after the locator's pre-existing candidates. Declines
  outright on any semantic branch, stale evidence, or incomplete provider.
- Known-Local Fast Path v2 (`TL_FAST_PATH_V2`): a cheap impact guard, an
  edit-representation selector, a target fingerprint, and focused post-edit
  verification around the existing known-local edit seam; closes a real
  target-drift TOCTOU window with a narrowly scoped refusal.
- Adaptive Wire v2 (`TL_WIRE_BREAKEVEN`, requires
  `TOKENLIGHTEN_RESPONSE_FORMAT=auto`): per-cell break-even tables, versioned
  client compatibility profiles, a bounded encoding cache, and two-stage
  codec×host-budget selection. The only behavior it can newly activate is
  `tl-raw-1` encoding of `read.text`; `read.task_pack` stays hard-JSON.
- Attribution & Calibration v2 (`packages/usage`; no flag — offline code,
  recording stays gated by the existing `TOKENLIGHTEN_USAGE_LOG`): versioned
  Claude Code / Codex log parsers, a deterministic session matcher (ambiguous
  → unavailable, never guessed), paired-direct coefficient storage with
  transfer-confidence downgrade, dated pricing snapshots, and
  trajectory-level feature-contribution records feeding a holdout error
  report.
- Incremental Index / Graph Update v2 (`packages/skeleton-engine`; correctness
  hardening ships unflagged, self-heal is opt-in via
  `TL_INDEX_CONSISTENCY_SCAN`): a crash-safe manifest/graph publish journal
  with monotonic content-addressed generations, a fault injector for
  invalidation-event drop/duplicate/reorder, parser-crash quarantine (fixing
  a whole-build-abort bug and a false-absence-on-read-error bug), a fixed
  mid-build invalidation-erasure race, and proven multi-root/worktree cache
  identity. The scan adds only a bounded, opt-in periodic self-heal.
- Serve-honesty completion (no flag): `ServedPackRecord.surfaces` now
  captures `content_completeness` / `total_lines` at record time, and
  receipt revalidation declines — never silently restates — a compact
  receipt when a qref replay would collapse a previously partial surface.

### Fixed

- Two test failures present at kickoff, both traced to a single prior
  commit: the certificate-shrink path now delegates to the existing
  per-surface binding logic so the T05c multi-concern pack stays under its
  byte cap without evicting a surface, and qref replay no longer collapses a
  re-added surface's `content_completeness: "partial"` marker.

### Defaults

Every new v0.11 capability ships default OFF behind a class-(B) experiment
flag in `util/flags.ts` — or, for the Incremental Index hardening, is
unflagged pure correctness with only its opportunistic self-heal scan
gated. Flags off, this release makes zero advertised-schema changes, zero
new wire kinds or fields, and zero default-path wire-byte changes: output is
byte-identical to 0.10.0, proven by the frozen wire-baseline and
replay-corpus suites.

### Migration / rollback

- Existing clients and integrations need no action: every capability above
  defaults OFF and the default wire is unchanged. New flags, each one-line:
  `TL_GRAPH_EVIDENCE` (graph-evidence/impact overlay), `TL_RRF_PROFILES`
  (task-family RRF weighting), `TL_COVERAGE_PACKER_V2` (coverage packer v2),
  `TL_REASONING_IR_V2` (advisory Task Reasoning IR v2), `TL_COMPOUND_RETRIEVAL`
  (bounded multi-hop candidate expansion), `TL_FAST_PATH_V2` (impact guard +
  focused verification on known-local edits), `TL_WIRE_BREAKEVEN`
  (break-even-gated `tl-raw-1` for `read.text`, needs
  `TOKENLIGHTEN_RESPONSE_FORMAT=auto` too), `TL_INDEX_CONSISTENCY_SCAN`
  (opt-in bounded index self-heal).
- Rollback levers: unset any of the flags above (and leave
  `TOKENLIGHTEN_RESPONSE_FORMAT` at its default `json`) to restore 0.10.0
  selection/encoding exactly.
- Downgrading the mcp-server package itself is safe — no store or schema
  migration ran. Task Reasoning IR v2 persists state as an additive
  `ir2:`-prefixed key inside the pre-existing per-workspace task-purpose
  state store (`state/stateStore.ts`, itself unmodified by v0.11): that file's
  record shape, its `StoredPurpose` enum, and its opaque `data` field are
  unchanged from 0.10.0, the store exposes no enumeration API (only
  exact-key `get()`), and an `ir2:` key — containing a literal `:` — can
  never be produced or looked up by a 0.10.0 server's own handle resolution,
  which only ever derives base64url keys (alphabet `A-Za-z0-9-_`, never a
  colon). A downgraded server therefore never reads or writes an `ir2:`
  record; any left over simply age out through the store's existing
  2,048-record cap and 24-hour TTL like any other record.

## 0.10.0

Foundation + safe-efficiency release: MCP `2026-07-28` dual-era support,
explicit state handles, the nine Protocol-Integrity closures, and flag-gated
performance cores shipped dark behind shadow measurement.

### Added

- Modern MCP `2026-07-28` stateless transport behind
  `TOKENLIGHTEN_PROTOCOL_ERA=modern` (default `legacy`, byte-identical); a
  client pinned to `2026-07-28` connects through server/discover.
- Explicit state handles: an optional `task_handle` argument on all three
  tools; purpose-bound HMAC handles backed by a persistent per-workspace
  journal store with compare-and-swap, restart recovery, and fail-closed
  tamper/expiry/wrong-purpose refusals that always carry executable recovery.
  A `task.id` now survives a server restart — resend it as `task_handle`.
- Evidence-honesty disclosures: per-term absence proof
  (`term_results[].status`), tree `scope_report` counts
  (visited = returned + excluded + errors, `.gitignore` parity with find),
  unreadable-directory disclosure, and parser-provenance labeling on symbols
  (`symbol_coverage`; regex-derived entries are labeled fallback instead of
  being silently mixed with parser-proven declarations).
- Incremental content-hash index contract: the per-file fast path requires
  content-sha equality (a same-size/same-mtime content swap can no longer
  serve stale symbols), and every successful `edit_file` write invalidates
  the in-process index for the touched files.
- Flag-gated performance cores, all default OFF: BM25F+RRF hybrid candidate
  retrieval (`TL_BM25F_CANDIDATE` / `TL_RRF_FUSION`), the obligation-aware
  coverage packer (`TL_COVERAGE_PACKER`), and adaptive wire encoding
  (`TOKENLIGHTEN_RESPONSE_FORMAT=json|auto|compact|debug` plus
  `TL_WIRE_SHADOW` shadow measurement; refusal/edit/receipt/closure and
  task-pack decision surfaces are always JSON).
- Compact Bootstrap guide variant:
  `tl agents update --for-target --guide compact` writes the ~355-token
  bootstrap block instead of the full stable-prefix guide (default unchanged).
- Release rehearsal suites in CI: restart recovery on both eras,
  installation-key rotation, state-store corruption, dual-era semantic
  replay, the flags-off rollback drill, and a release E2E.

### Changed

- Guide v68 documents `task_handle` continuity, per-term absence, and
  `scope_report`.
- The advertised tool schema grows additively (`task_handle`); the pinned
  schema-size ceiling was raised 7,280 → 7,680 bytes through the documented
  conformance procedure.

### Migration / rollback

- Existing clients need no action: the default era stays `legacy`, every new
  request argument and response field is optional and additive, and all
  performance flags default OFF — the default wire is byte-identical, proven
  by the frozen wire-baseline and replay-corpus suites.
- Rollback levers: leave `TOKENLIGHTEN_PROTOCOL_ERA` unset (or `legacy`) to
  stay off the modern leg; unset the `TL_*` performance flags to restore
  pre-0.10 selection/encoding exactly; `TOKENLIGHTEN_STATE_STORE=off`
  disables the persistent handle store, degrading handles to honest
  handle-unknown refusals with recovery.

## 0.9.2 (GitHub tag v0.9.1a)

Public-beta refresh containing the 2026-08-17 Windows and VS Code fixes.

### Added

- VS Code startup update checks for newer published GitHub Releases, including
  public-beta prereleases, with an explicit VSIX download action.
- English and Japanese settings for disabling startup update checks.

### Fixed

- Windows workspace containment no longer rejects a file solely because the
  drive letter casing differs between VS Code and the resolved filesystem path.
- The VS Code update checker recognizes the requested `v0.9.1a` public-beta
  tag while keeping the installable VSIX manifest on a valid three-part version.

## 0.9.0

Initial public source release.

### Added

- MCP server with exactly three advertised tools: `read_file`, `edit_file`,
  and `search_files`.
- Task-oriented reads, exact source slices, edit handles, batched edits, and
  search across supported code and document formats.
- TokenLighten CLI for setup, diagnostics, workspace integration, MCP client
  registration, skeleton generation, and agent-guide management.
- VS Code extension with the TokenLighten CLI and public MCP runtime bundled
  into a zero-install VSIX.
- Developer build and package test workflows for Node.js 20 or newer.
- Public documentation for installation, MCP tools, language support,
  privacy, security, support, licensing, and source-release contents.
- Generated third-party dependency inventory distributed with release
  artifacts.

### Security and privacy

- File edits remain disabled unless the MCP server is started with
  `--allow-write`.
- Workspace access is restricted by resolved workspace roots and explicitly
  configured parent grants.
- Security reports are handled privately as described in `SECURITY.md`.
- Support is best effort; no support or availability SLA is provided.

### Known limitations

- The desktop application is not part of the 0.9.0 release and may be shipped
  in a later release.
- The initial VS Code extension is distributed as a manually installable VSIX.
- Token and cost reductions vary by task, model, client, and workflow; no
  specific saving is guaranteed.
