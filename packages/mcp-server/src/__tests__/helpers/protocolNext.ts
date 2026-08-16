/**
 * protocolNext.ts — test helper for the §2.1.2 / §2.6 `next` migration.
 *
 * Pre-v1, a refusal's follow-up call rode as a PROSE string
 * (`read_file mode=slice handle=h1 range=1-40`) and dozens of specs pin it with
 * `expect(String(body["next"])).toContain("mode=slice")`.
 *
 * v1 (F5, §2.1.2 + A.5.15) makes `next` an executable `ToolCall` object,
 * precisely so a client runs it instead of re-parsing a sentence. Those pins are
 * still asserting the right FACT — "the refusal points at a slice of this
 * handle" — so they keep their assertion and change how they read the value:
 * `nextText()` renders the emitted `ToolCall` back into the canonical prose
 * form the emitters themselves used.
 *
 * This is a READBACK, not a shim: nothing in product code calls it, and a spec
 * that wants to assert on the structure directly should read
 * `body.next.arguments` instead.
 */

export interface ToolCallish {
  tool?: unknown;
  arguments?: unknown;
}

/** Render one argument the way the pre-v1 prose emitters did. */
function renderValue(value: unknown): string {
  if (typeof value === "string") return value.includes(" ") ? JSON.stringify(value) : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * The canonical prose form of a `ToolCall`, or `String(value)` when the value
 * is not a call (so a spec that reaches this with `undefined` still fails with
 * the message it used to).
 */
export function renderToolCall(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return String(value);
  const call = value as ToolCallish;
  if (typeof call.tool !== "string" || call.arguments === null || typeof call.arguments !== "object") {
    return String(value);
  }
  const args = Object.entries(call.arguments as Record<string, unknown>)
    .map(([key, item]) => `${key}=${renderValue(item)}`)
    .join(" ");
  return args === "" ? call.tool : `${call.tool} ${args}`;
}

/**
 * `next` on a response, rendered as prose. Reads the v1 `ToolCall`.
 *
 * Falls back to `detail` when there is no `next`: §2.6 requires `next` to be
 * EXECUTABLE, so a pre-v1 prose `next` that is guidance rather than a call
 * ("retry with cwd=… or omit cwd") is folded into `detail` instead of being
 * emitted as an unrunnable call. The guidance is still on the wire; it moved.
 */
export function nextText(body: Record<string, unknown>): string {
  const next = body["next"] ?? body["next_call"];
  if (typeof next === "string") return next;
  if (next !== undefined && next !== null) return renderToolCall(next);
  return typeof body["detail"] === "string" ? body["detail"] : String(next);
}
