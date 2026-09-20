/**
 * D1 (2026-09-05, measured on paid smoke r10 / SF13 call 13): the task handles
 * THIS process minted, per (workspace, lane), so a handle that fails
 * authentication can be told apart from a handle the caller merely MANGLED.
 *
 * THE MEASURED DEFECT. A solver re-sent its own live task handle with a
 * contiguous middle chunk missing (a prefix+suffix splice — the classic
 * transcript/serialization truncation). `resolveTaskHandle` correctly reported
 * `invalid` (a truncated token cannot authenticate), and the refusal said
 * `retry:"new-task"` with `remaining:"no working set survives this call …"`.
 * That sentence was FALSE: the lane's task was live and its working set intact.
 * The solver obeyed, re-packed with `task.epoch:"new"`, got the identical pack
 * and the identical `next`, and the run tripped its own same-next recurrence
 * gate. One mistyped field cost a full re-pack plus a false-negative certificate.
 *
 * WHY AN IN-PROCESS REGISTRY IS THE RIGHT AUTHORITY. The claim being corrected
 * is "no working set survives THIS call". A working set is exactly what this
 * process holds; the durable store is keyed by task FINGERPRINT (see
 * `stateHandles.ts`'s `mintTaskHandle`) and offers no way to enumerate the
 * handles a lane is actually working with. If the process restarted, this
 * registry is empty and the refusal keeps its existing shape — which is the
 * honest answer there, because the in-memory working set really is gone.
 *
 * NOTHING IS DISCLOSED. A near-miss is only ever answered for a supplied string
 * that is already almost the whole live handle (see `laneTaskHandleNearMiss`),
 * so the caller demonstrably held that handle before this call. The registry is
 * never enumerated onto the wire.
 */

/** Bounded per (workspace, lane); a lane works one task at a time, with room for a re-pack chain. */
const MAX_HANDLES_PER_LANE = 8;

/** The `tlh_task_v1_` scheme prefix every task handle shares — never evidence of a near-miss on its own. */
const TASK_HANDLE_SCHEME_PREFIX = "tlh_task_v1_";

/**
 * Minimum shared prefix before two handles may be called a near-miss. The
 * scheme prefix plus a real slice of the token body: handles minted by the
 * same installation share a scheme prefix and some issuer bytes, and that
 * coincidence must never be mistaken for "the caller mangled THIS handle".
 */
const MIN_SHARED_PREFIX = TASK_HANDLE_SCHEME_PREFIX.length + 12;

/** Below this a string is too short to identify anything; refuse to guess. */
const MIN_SUPPLIED_LENGTH = 32;

const _laneHandles = new Map<string, string[]>();

function key(workspaceRoot: string, lane: string): string {
  return `${workspaceRoot}\u0000${lane}`;
}

/** Record a task handle this process just minted for `lane`. Most recent first. */
export function recordLaneTaskHandle(workspaceRoot: string, lane: string, token: string): void {
  if (workspaceRoot === "" || token === "") return;
  const k = key(workspaceRoot, lane);
  const existing = _laneHandles.get(k) ?? [];
  const next = [token, ...existing.filter((entry) => entry !== token)].slice(0, MAX_HANDLES_PER_LANE);
  _laneHandles.set(k, next);
}

/** The task handles this process minted for `lane`, most recent first. */
export function laneTaskHandles(workspaceRoot: string, lane: string): readonly string[] {
  return _laneHandles.get(key(workspaceRoot, lane)) ?? [];
}

// WP-V1 (2026-09-20): the profile ("answer"/"generic") of the most recent
// task pack this process minted for (workspace, lane) — the smallest
// possible accessor `protocol/lineGutter.ts` needs to keep numbering a
// task-less zoom read once a leaned continuation (see util/flags.ts's
// `leanCallsEnabled`) stops carrying `task.profile` at all. Same
// (workspace, lane) keying as `_laneHandles` above, and the same
// never-enumerated-on-the-wire registry discipline: this is read back only
// to DECIDE whether to number a body already about to be served, never
// surfaced as a field of its own.
const _laneProfile = new Map<string, string>();

/** Record the profile of the most recent task pack this process minted for `lane`. */
export function recordLaneTaskProfile(workspaceRoot: string, lane: string, profile: string): void {
  if (workspaceRoot === "" || profile === "") return;
  _laneProfile.set(key(workspaceRoot, lane), profile);
}

/** The profile of the most recent task pack this process minted for `lane`, if any. */
export function laneTaskProfile(workspaceRoot: string, lane: string): string | undefined {
  return _laneProfile.get(key(workspaceRoot, lane));
}

/**
 * Is `supplied` the same handle as `live` with ONE contiguous chunk removed?
 *
 * The measured mangling exactly: `live` = prefix + <dropped> + suffix, and
 * `supplied` = prefix + suffix. Proved rather than scored — let `p` be the
 * common prefix length and `s` the common suffix length (clamped so the two
 * cannot overlap inside `supplied`); `p + s >= supplied.length` holds if and
 * only if `supplied` is obtainable from `live` by deleting one contiguous run.
 * A plain truncation is the `s === 0` case of the same rule.
 *
 * This is deliberately NOT an edit-distance score: the dropped run is 40+
 * characters, which every sane distance threshold rejects, while the structural
 * property is exact and has no constant to tune.
 */
export function isSplicedHandle(supplied: string, live: string): boolean {
  if (supplied === live) return false;
  if (supplied.length >= live.length) return false;
  if (supplied.length < MIN_SUPPLIED_LENGTH) return false;
  if (!supplied.startsWith(TASK_HANDLE_SCHEME_PREFIX) || !live.startsWith(TASK_HANDLE_SCHEME_PREFIX)) {
    return false;
  }
  let prefix = 0;
  while (prefix < supplied.length && supplied[prefix] === live[prefix]) prefix++;
  if (prefix < MIN_SHARED_PREFIX) return false;
  let suffix = 0;
  while (
    suffix < supplied.length - prefix
    && supplied[supplied.length - 1 - suffix] === live[live.length - 1 - suffix]
  ) {
    suffix++;
  }
  return prefix + suffix >= supplied.length;
}

/**
 * E1 (2026-09-05, measured on paid smoke r11 / SF13-estimator-telemetry-
 * continuation-a_tl_sf_cheap3-r0): before `isSplicedHandle` runs, a caller
 * may instead have copied a DISPLAY-ABBREVIATED handle — some upstream
 * rendering (a terminal, a transcript viewer, a diff tool) collapses a long
 * token to `prefix...suffix` for a human to read, and the agent then pastes
 * exactly THAT string back as `task.handle`. That is not a deletion
 * `isSplicedHandle` can prove: its prefix+suffix arithmetic must reach
 * `supplied.length` exactly, and the "..."/"…"/".." characters here are EXTRA
 * relative to `live`, not merely absent, so the two checks are complementary,
 * not overlapping — r11's own 24-char-prefix + 5-char-suffix supplied string
 * carries a kept span of 29 characters against a 32-character supplied
 * length, 3 short (exactly the length of its own "..." marker) of
 * `isSplicedHandle`'s required prefix+suffix >= supplied.length match.
 *
 * `ELLIPSIS_MARKERS` is tried longest-first so a literal "..." reads as one
 * three-character marker rather than as an ambiguous ".." split; the unicode
 * "…" is checked first because, being a single code point, it can never
 * collide with a run of literal dots.
 *
 * FLOOR: identical to `isSplicedHandle`'s own `MIN_SHARED_PREFIX` — the kept
 * prefix and suffix together must cover the scheme prefix (12 chars, i.e.
 * `TASK_HANDLE_SCHEME_PREFIX.length`) plus 12 further token-body characters
 * (24 total), the same bar this module already treats as enough to rule out
 * a random foreign handle. The measured r11 shape (24-char prefix + 5-char
 * suffix = 29) clears it with room to spare; a kept span at or below 23
 * characters does not — refuse to guess rather than risk a false
 * `did_you_mean`.
 */
const ELLIPSIS_MARKERS = ["\u2026", "...", ".."] as const;

export function isEllipsisAbbreviatedHandle(supplied: string, live: string): boolean {
  if (supplied === live) return false;
  if (supplied.length >= live.length) return false;
  if (!supplied.startsWith(TASK_HANDLE_SCHEME_PREFIX) || !live.startsWith(TASK_HANDLE_SCHEME_PREFIX)) {
    return false;
  }
  for (const marker of ELLIPSIS_MARKERS) {
    const first = supplied.indexOf(marker);
    if (first === -1) continue; // this marker form isn't present; try the next
    // Falls inside (or before) the scheme prefix: not a body abbreviation.
    if (first < TASK_HANDLE_SCHEME_PREFIX.length) return false;
    // Recurs elsewhere in `supplied`: the split point is ambiguous, so this
    // marker form is not it — a weaker marker is not tried either, since it
    // would only re-split the same literal text.
    if (supplied.indexOf(marker, first + 1) !== -1) return false;
    const prefixPart = supplied.slice(0, first);
    const suffixPart = supplied.slice(first + marker.length);
    if (prefixPart.length + suffixPart.length < MIN_SHARED_PREFIX) return false;
    // Must actually elide at least one character to be an abbreviation of
    // `live` at all — a full reconstruction with room to spare is
    // `isSplicedHandle`'s claim to make, not this one's.
    if (prefixPart.length + suffixPart.length >= live.length) return false;
    return live.startsWith(prefixPart) && live.endsWith(suffixPart);
  }
  return false;
}

/**
 * TL_TASK_HANDLE_RECOVERY route (b) (2026-09-19). `isSplicedHandle` and
 * `isEllipsisAbbreviatedHandle` both require `supplied` STRICTLY SHORTER than
 * `live` — a deletion shape. A caller that merges two of ITS OWN near-identical
 * live handles (e.g. a re-pack that legitimately minted a new id for the same
 * task — content-addressed identity means the id changes whenever the hashed
 * profile/query text does, even under a still-valid presented handle) produces
 * a SAME-LENGTH splice instead: one contiguous run of `live`'s characters
 * replaced by the sibling handle's bytes at that position.
 *
 * Measured shape (task prompt, 2026-09-19 GitHub Copilot / gpt-5.6-luna
 * session): a 12-character run exactly at the `payloadRef` field's own
 * base64 span (state/handleCodec.ts's `OFF_PAYLOAD_REF`/`PAYLOAD_REF_BYTES`)
 * — the one header field that genuinely differs between two mintings of what
 * a caller experiences as "the same task"; every other header field (key id,
 * workspace/subject/issuer refs, store epoch) is identical between two
 * mintings from the same process/workspace/epoch. 16 is a small multiple of
 * that measured 12-character span, not a round-number guess.
 *
 * Pure and unconditional — detection only. Whether a caller ACTS on a match
 * is server.ts's `recoverAuthFailedTaskHandle`, gated by
 * TL_TASK_HANDLE_RECOVERY, so this predicate's own truth table stays the
 * same regardless of the flag.
 */
const MAX_MIDSPLICE_RUN = 16;

export function isMidSplicedHandle(supplied: string, live: string): boolean {
  if (supplied === live) return false;
  if (supplied.length !== live.length) return false;
  if (supplied.length < MIN_SUPPLIED_LENGTH) return false;
  if (!supplied.startsWith(TASK_HANDLE_SCHEME_PREFIX) || !live.startsWith(TASK_HANDLE_SCHEME_PREFIX)) {
    return false;
  }
  let prefix = 0;
  while (prefix < supplied.length && supplied[prefix] === live[prefix]) prefix++;
  if (prefix < MIN_SHARED_PREFIX) return false;
  let suffix = 0;
  while (
    suffix < supplied.length - prefix
    && supplied[supplied.length - 1 - suffix] === live[live.length - 1 - suffix]
  ) {
    suffix++;
  }
  const middle = supplied.length - prefix - suffix;
  return middle > 0 && middle <= MAX_MIDSPLICE_RUN;
}

/**
 * The lane's own live handle that is an `isMidSplicedHandle` match for
 * `supplied` — same contract as `laneTaskHandleNearMiss` just below (most
 * recent MAX_HANDLES_PER_LANE candidates, `isLive`-checked, ambiguity when
 * two or more qualify resolves nothing).
 */
export function laneTaskHandleMidSpliceMatch(
  workspaceRoot: string,
  lane: string,
  supplied: string,
  isLive: (candidate: string) => boolean,
): string | undefined {
  const candidates = laneTaskHandles(workspaceRoot, lane)
    .filter((candidate) => candidate !== supplied && isMidSplicedHandle(supplied, candidate))
    .filter((candidate) => isLive(candidate));
  const unique = new Set(candidates);
  return unique.size === 1 ? [...unique][0] : undefined;
}

/**
 * TL_TASK_HANDLE_RECOVERY route (0) (2026-09-19, second live GitHub Copilot
 * session). The caller sent the WHOLE live handle followed by a few more
 * characters — its own last seven repeated (`…qtWOo` sent as
 * `…qtWOoAGqtWOo`), a copying stutter. The presented string CONTAINS the
 * authentic handle, MAC included, so resolving that prefix proves possession
 * more strongly than any other route here: nothing is guessed, the caller
 * demonstrably holds the real token. Bounded so an arbitrary long string that
 * merely begins with a handle is not quietly accepted.
 */
const MAX_TAIL_EXTENSION = 16;

export function isTailExtendedHandle(supplied: string, live: string): boolean {
  return supplied.length > live.length
    && supplied.length - live.length <= MAX_TAIL_EXTENSION
    && live.length >= MIN_SUPPLIED_LENGTH
    && live.startsWith(TASK_HANDLE_SCHEME_PREFIX)
    && supplied.startsWith(live);
}

/** The lane's own live handle that `supplied` merely extends — at most one can, handles of one codec being equally long. */
export function laneTaskHandleTailExtensionMatch(
  workspaceRoot: string,
  lane: string,
  supplied: string,
  isLive: (candidate: string) => boolean,
): string | undefined {
  return laneTaskHandles(workspaceRoot, lane)
    .find((candidate) => isTailExtendedHandle(supplied, candidate) && isLive(candidate));
}

/**
 * The lane's live task handle `supplied` is a mangled copy of, or `undefined`.
 *
 * `isLive` is injected (rather than imported) so this module stays free of the
 * state-store layer and the caller keeps ONE authority for liveness —
 * `resolveTaskHandle`, the very function that just rejected `supplied`.
 * Answers only when the match is UNIQUE, the same bar the cwd near-miss holds:
 * two candidates mean the server does not know which one the caller meant, and
 * naming either would be a guess presented as a correction.
 */
export function laneTaskHandleNearMiss(
  workspaceRoot: string,
  lane: string,
  supplied: string,
  isLive: (candidate: string) => boolean,
): string | undefined {
  const candidates = laneTaskHandles(workspaceRoot, lane)
    .filter((candidate) =>
      candidate !== supplied
      && (isSplicedHandle(supplied, candidate) || isEllipsisAbbreviatedHandle(supplied, candidate)))
    .filter((candidate) => isLive(candidate));
  const unique = new Set(candidates);
  return unique.size === 1 ? [...unique][0] : undefined;
}

/** Focused regression seam; also keeps cross-test state from leaking. */
export function resetLaneTaskHandlesForTest(): void {
  _laneHandles.clear();
  _laneProfile.clear();
}
