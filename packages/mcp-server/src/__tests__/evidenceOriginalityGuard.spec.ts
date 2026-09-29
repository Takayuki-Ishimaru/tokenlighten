// evidenceOriginalityGuard.spec.ts — FIX-ORIG (2026-09-27, eval-0927 §6.1).
//
// C1 (brief-fix-orig.md): `evidence[].body` is VERBATIM source of the lines
// its own `range` names, 1-based inclusive, end <= the file's real line
// count, except an explicit self-describing inline marker that already
// exists (doc-elision, the VS Code answer-line gutter).
// C2: a residency pointer (`code_unchanged` -> `prior`) never appears inside
// `body`; an item carries the body OR `prior` (+ `remaining`) — never both.
// C4: `decisionWire.ts`'s `guardEvidenceOriginality` is the cheap, pure,
// no-re-read structural guard at the LAST SEAT before projection that
// corrects a violation of either contract — a SAFETY NET, not the fix (each
// known producer is fixed at its own source; see this wave's report for the
// list). This spec is fail-first-shaped: every "corrects" case below
// reproduces a shape actually observed live this wave (see the file-level
// comment on `guardEvidenceOriginality` in decisionWire.ts for exactly which
// producer/session sequence), and every "leaves ... untouched" case proves
// the guard is a no-op on an ordinary, well-formed row — the byte-identical
// passthrough every OTHER decisionWire.spec-style test already depends on.
import { describe, expect, it } from "vitest";

import { projectEvidence } from "../protocol/decisionWire.js";

describe("evidence originality guard (decisionWire.ts projectEvidence, C4)", () => {
  describe("C2 — a residency pointer inside `code` is demoted to `prior`, never a mixed body", () => {
    it("corrects an applyPackDedupe-shaped pointer ('— see prior pack') glued ahead of a source line", () => {
      // The exact shape reproduced live this wave (V01 -> a JA two-line query
      // -> V03, one session/workspace): a `readiness-falsification-
      // counterexample` surface's `code` carried a residency-pointer phrase
      // with an extra line after it, though its own producer served it
      // honestly — see decisionWire.ts's header comment for the full account.
      const evidence = projectEvidence([{
        path: "src/httpClient.ts", handle: "hzobi24rrmk", range: "4-16",
        why: "readiness-falsification-counterexample",
        code: "hzobi24rrmk — see prior pack\nimport { backoffDelay, shouldRetry } from \"./retry\";",
      }]);
      expect(evidence).toEqual([{
        path: "src/httpClient.ts", handle: "hzobi24rrmk", range: "4-16",
        why: "readiness-falsification-counterexample",
        prior: "hzobi24rrmk — see prior pack",
      }]);
    });

    it("corrects an applyPackDedupe same-pack-duplicate pointer", () => {
      const evidence = projectEvidence([{
        path: "src/config.ts", handle: "hcfg1", range: "1-50",
        code: "hcfg1 — duplicate of an earlier surface in this pack\nexport const DEFAULT_OPTIONS = {};",
      }]);
      expect(evidence).toEqual([{
        path: "src/config.ts", handle: "hcfg1", range: "1-50",
        prior: "hcfg1 — duplicate of an earlier surface in this pack",
      }]);
    });

    it("corrects an applyResidentFileDedup/applyLedgerServedSurfaces 'already served this session' pointer", () => {
      const pointerLine = "hres1 — already served this session (src/retry.ts:3-5, sha abc123def456); "
        + "resident in your context — re-read hres1 only if the body is needed";
      const evidence = projectEvidence([{
        path: "src/retry.ts", handle: "hres1", range: "3-5",
        code: `${pointerLine}\nexport function shouldRetry() {}`,
      }]);
      expect(evidence).toEqual([{
        path: "src/retry.ts", handle: "hres1", range: "3-5",
        prior: pointerLine,
      }]);
    });

    it("prefers the guard's own pointer over an unrelated `code_unchanged`, never emitting both prior and body", () => {
      const evidence = projectEvidence([{
        path: "src/a.ts", handle: "ha", range: "1-3",
        code: "ha — see prior pack\nextra line",
        code_unchanged: "ha — a differently-worded restatement",
      }]);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).not.toHaveProperty("body");
      expect((evidence[0] as Record<string, unknown>)["prior"]).toBe("ha — see prior pack");
    });
  });

  describe("C1 — a body longer than its own declared range is truncated to the verbatim prefix", () => {
    it("drops an appended tail line past the declared range's span (the live-reproduced shape)", () => {
      // Reproduced live: a 16-line file's masked-counterexample body (2 real
      // lines + 14 blanks = 16 logical lines, matching range \"1-16\") arrived
      // at this module with a 17th line appended — the real, UNMASKED source
      // line the masking was meant to withhold. `range` here is honest (the
      // producer-level N+1 bug is fixed separately); only `code` overshoots.
      const honestSixteen = ["import a;", "import b;", ...Array(14).fill("")].join("\n");
      const corrupted = `${honestSixteen}\nexport async function fetchWithRetry() {`;
      const evidence = projectEvidence([{
        path: "src/httpClient.ts", handle: "h1", range: "1-16",
        why: "readiness-falsification-counterexample", required: true,
        code: corrupted,
      }]);
      // `required` is not part of the Evidence wire allow-list (decisionWire.ts's
      // own EVIDENCE_KEPT_BEYOND_APPENDIX) — it stays on the internal surface,
      // never the projected row.
      expect(evidence).toEqual([{
        path: "src/httpClient.ts", handle: "h1", range: "1-16",
        why: "readiness-falsification-counterexample",
        body: honestSixteen,
      }]);
      // The corrected body's own logical line count now matches the range.
      const body = (evidence[0] as Record<string, unknown>)["body"] as string;
      expect(body.split("\n").length).toBe(16);
    });

    it("truncates a multi-line over-length body to exactly the declared span, keeping the genuine prefix", () => {
      const evidence = projectEvidence([{
        path: "src/a.ts", handle: "h2", range: "1-3",
        code: "line1\nline2\nline3\nline4\nline5",
      }]);
      expect(evidence).toEqual([{
        path: "src/a.ts", handle: "h2", range: "1-3",
        body: "line1\nline2\nline3",
      }]);
    });
  });

  describe("C1 — a body SHORTER than its declared range is left uncorrected (recall control)", () => {
    // REGRESSION CONTROL: an earlier version of this guard narrowed `range`
    // down to match an under-length body. semanticFrontierTrace.spec.ts's
    // "activates evidence witnesses only for optional evidence that survives
    // the actual shed ladder" caught it live — the existing budget-shedding
    // pipeline legitimately ships a body shorter than `range` while
    // separately (and already correctly) updating `remaining_ranges` to
    // disclose exactly what the shed removed; narrowing `range` here on top
    // of that corrupted the shedder's own disclosure. See that spec's
    // retainedOn/retainedOff assertions for the exact shed-ladder shape this
    // guard must stay out of.
    it("leaves range AND body untouched for a body shorter than its declared range", () => {
      const evidence = projectEvidence([{
        path: "src/a.ts", handle: "h3", range: "1-10",
        code: "line1\nline2\nline3",
      }]);
      expect(evidence).toEqual([{
        path: "src/a.ts", handle: "h3", range: "1-10",
        body: "line1\nline2\nline3",
      }]);
    });

    it("leaves an empty body and its range untouched", () => {
      const evidence = projectEvidence([{
        path: "src/a.ts", handle: "h4", range: "1-10", code: "",
      }]);
      expect(evidence).toEqual([{
        path: "src/a.ts", handle: "h4", range: "1-10", body: "",
      }]);
    });

    it("leaves a shed-shortened body's `range` consistent with its own separately-disclosed `remaining` "
      + "(the exact interaction the recall control above protects)", () => {
      const evidence = projectEvidence([{
        path: "src/optional.ts", handle: "h-optional", range: "1-500", role: "style",
        code: "O", remaining_ranges: ["1-500"],
      }]);
      expect(evidence).toEqual([{
        path: "src/optional.ts", handle: "h-optional", range: "1-500", role: "style",
        body: "O", remaining: ["1-500"],
      }]);
    });
  });

  describe("the guard is a byte-identical no-op on every well-formed row (never fires on the fixed producers)", () => {
    it("passes through a body whose logical line count exactly matches its range, single line, no trailing newline", () => {
      const evidence = projectEvidence([{
        path: "src/retry.ts", handle: "h5", range: "3-3",
        code: "export function shouldRetry() {}",
      }]);
      expect(evidence).toEqual([{
        path: "src/retry.ts", handle: "h5", range: "3-3",
        body: "export function shouldRetry() {}",
      }]);
    });

    it("passes through a whole-file body ending in a real trailing newline (countLines semantics, not raw split)", () => {
      // 3 real lines, content ends with "\n" — split("\n") would (pre-fix,
      // elsewhere) yield a phantom 4th element; this guard must not clamp a
      // CORRECTLY-labelled range="1-3" body down because of that phantom.
      const evidence = projectEvidence([{
        path: "src/config.ts", handle: "h6", range: "1-3",
        code: "line1\nline2\nline3\n",
      }]);
      expect(evidence).toEqual([{
        path: "src/config.ts", handle: "h6", range: "1-3",
        body: "line1\nline2\nline3\n",
      }]);
    });

    it("passes through a multi-target/no-range evidence row unchanged", () => {
      const evidence = projectEvidence([{
        path: "src/a.ts", handle: "h7", code: "whatever text, no range to check against",
      }]);
      expect(evidence).toEqual([{
        path: "src/a.ts", handle: "h7", body: "whatever text, no range to check against",
      }]);
    });

    it("passes through a legitimate code_unchanged-only (prior-only, no body) row unchanged", () => {
      const evidence = projectEvidence([{
        path: "src/a.ts", handle: "h8", range: "1-5", code_unchanged: "h8 — see prior pack",
      }]);
      expect(evidence).toEqual([{
        path: "src/a.ts", handle: "h8", range: "1-5", prior: "h8 — see prior pack",
      }]);
    });

    it("leaves a required remainder's `remaining` untouched alongside a clean, correctly-sized body", () => {
      const evidence = projectEvidence([{
        path: "src/a.ts", handle: "h9", range: "1-3", required: true,
        code: "line1\nline2\nline3", remaining_ranges: ["4-10"],
      }]);
      expect(evidence).toEqual([{
        path: "src/a.ts", handle: "h9", range: "1-3",
        body: "line1\nline2\nline3", remaining: ["4-10"],
      }]);
    });

    it("still applies `priorForBodyless` for a codeless row with no remaining (compact receipt fallback)", () => {
      const evidence = projectEvidence(
        [{ path: "src/a.ts", handle: "h10", range: "1-5" }],
        "read_file mode=task_pack qref=q-known",
      );
      expect(evidence).toEqual([{
        path: "src/a.ts", handle: "h10", range: "1-5",
        prior: "read_file mode=task_pack qref=q-known",
      }]);
    });
  });

  describe("recall control: the fixed producers' REAL V01→§4→V03 output no longer needs the guard", () => {
    // Orchestrator follow-up (2026-09-27): the two producer-level rulings
    // (materializeExplicitAnswerAnchorEvidence's code_unchanged-as-body fix;
    // the counterexample producer's unserved-span narrowing) are the actual
    // fix; this guard is the safety net. These exact bodies/ranges were
    // captured from a LIVE dev-server run of evaluation0927Scenarios.ts's
    // V01_QUERY_EN -> V02_QUERY_JA -> V03_QUERY_JA sequence (one session, one
    // "sliced" workspace) against the current tree, verbatim (see the wave
    // report for the full transcript) — every one of them must round-trip
    // through `projectEvidence` byte-identical, proving the guard found
    // nothing to correct on the sequence it was written to guard against.
    it("passes the V01 whole-file readiness-falsification-counterexample body through unchanged", () => {
      const body = "import { loadOptions, type ClientOptions } from \"./config\";\n"
        + "import { backoffDelay, shouldRetry } from \"./retry\";\n\n"
        + "export async function fetchWithRetry(url: string, init: RequestInit = {}, "
        + "options: ClientOptions = loadOptions(process.env)): Promise<Response> {\n"
        + "  for (let attempt = 0; ; attempt++) {\n"
        + "    const controller = new AbortController();\n"
        + "    const timer = setTimeout(() => controller.abort(), options.timeoutMs);\n"
        + "    try {\n"
        + "      const response = await fetch(url, { ...init, signal: controller.signal });\n"
        + "      if (!shouldRetry(response.status, attempt, options.maxAttempts)) return response;\n"
        + "    } finally {\n      clearTimeout(timer);\n    }\n"
        + "    await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt, options.retryDelayMs)));\n"
        + "  }\n}";
      const evidence = projectEvidence([{
        path: "src/httpClient.ts", handle: "h9ppmrnidpa", range: "1-16",
        why: "readiness-falsification-counterexample", code: body,
      }]);
      expect(evidence).toEqual([{
        path: "src/httpClient.ts", handle: "h9ppmrnidpa", range: "1-16",
        why: "readiness-falsification-counterexample", body,
      }]);
    });

    it("passes the V03 narrowed-to-unserved-prefix counterexample body through unchanged (range 1-3, not the wider 1-16 selection)", () => {
      const body = "import { loadOptions, type ClientOptions } from \"./config\";\n"
        + "import { backoffDelay, shouldRetry } from \"./retry\";\n";
      const evidence = projectEvidence([{
        path: "src/httpClient.ts", handle: "hofhxi9vkve", range: "1-3",
        why: "readiness-falsification-counterexample", code: body,
      }]);
      expect(evidence).toEqual([{
        path: "src/httpClient.ts", handle: "hofhxi9vkve", range: "1-3",
        why: "readiness-falsification-counterexample", body,
      }]);
    });

    it("passes a same-session repeat's clean 'see prior pack' pointer through unchanged (no body alongside it)", () => {
      const evidence = projectEvidence([{
        path: "src/config.ts", handle: "h2k4dun0yxe", range: "1-15",
        why: "caller-supplied; caller-supplied", code_unchanged: "h2k4dun0yxe — see prior pack",
      }]);
      expect(evidence).toEqual([{
        path: "src/config.ts", handle: "h2k4dun0yxe", range: "1-15",
        why: "caller-supplied; caller-supplied", prior: "h2k4dun0yxe — see prior pack",
      }]);
    });
  });

  describe("appended windows ship as their own rows (eval-0927 review, T03)", () => {
    const head = "  public void cancel() {\n    refund();\n  }";
    const signature = "\n\n/* query-focused member place (10-11) */\n";
    const facet = "\n\n/* query facet shipping (20-22) */\n";
    const surface = {
      path: "src/Order.java", handle: "hord", range: "40-42", symbol: "Order",
      code: `${head}${signature}  public void place() {\n    validate();${facet}    a();\n    shipping();\n    b();`,
      appended_windows: [{ marker: signature, range: "10-11" }, { marker: facet, range: "20-22" }],
    };

    it("keeps the head under its own range and ships each window verbatim under the lines it holds", () => {
      expect(projectEvidence([surface])).toEqual([
        { path: "src/Order.java", handle: "hord", range: "40-42", symbol: "Order", body: head },
        { path: "src/Order.java", handle: "hord", range: "10-11", body: "  public void place() {\n    validate();" },
        { path: "src/Order.java", handle: "hord", range: "20-22", body: "    a();\n    shipping();\n    b();" },
      ]);
    });

    it("drops a window whose marker a trim removed and narrows a window a trim cut short", () => {
      const cut = { ...surface, code: `${head}${signature}  public void place() {` };
      expect(projectEvidence([cut])).toEqual([
        { path: "src/Order.java", handle: "hord", range: "40-42", symbol: "Order", body: head },
        { path: "src/Order.java", handle: "hord", range: "10-10", body: "  public void place() {" },
      ]);
    });

    it("leaves a surface without recorded windows exactly as before", () => {
      const plain = { path: "src/Order.java", handle: "hord", range: "40-42", code: head };
      expect(projectEvidence([plain])).toEqual([{ path: "src/Order.java", handle: "hord", range: "40-42", body: head }]);
    });
  });
});
