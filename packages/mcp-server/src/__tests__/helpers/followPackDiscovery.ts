import { extractNext } from "./qualityFirstScenarios.js";

type Body = Record<string, unknown>;

/** A common assertion view over actual plain read pages, without merging envelopes. */
export function plainReadRows(body: Body): Body[] {
  if (body["kind"] === "read.batch") return (body["entries"] ?? []) as Body[];
  if (body["kind"] === "read.text") return ((body["evidence"] ?? []) as Body[])
    .map((row) => ({ ...row, ...(typeof row["body"] === "string" ? { content: row["body"] } : {}) }));
  throw new Error(`expected a plain read page, got ${String(body["kind"])}`);
}

/** Follow only published discovery calls; the caller still asserts readiness. */
export async function followPackDiscovery(
  first: Body,
  call: (tool: string, args: Body) => Promise<Body>,
  maxHops = 8,
): Promise<{ final: Body; responses: Body[] }> {
  const responses = [first];
  const originalTask = (first["task"] as Body | undefined)?.["id"];
  const seen = new Set<string>();
  let body = first;
  while ((body["decision"] as Body | undefined)?.["kind"] === "discover") {
    if (responses.length > maxHops) throw new Error(`seed discovery exceeded ${maxHops} calls`);
    const { next } = extractNext(body);
    if (next === undefined) throw new Error("seed discovery has no published next call");
    const key = JSON.stringify(next);
    if (seen.has(key)) throw new Error("seed discovery repeated the same next call");
    seen.add(key);
    body = await call(next.tool, next.arguments);
    const task = (body["task"] as Body | undefined)?.["id"];
    if (originalTask !== undefined && task !== undefined && task !== originalTask) {
      throw new Error("seed discovery changed the task identity");
    }
    responses.push(body);
  }
  return { final: body, responses };
}

/** Read only budget continuations; optional zoom advice is not another page. */
export async function followReadPages(first: Body, call: (tool: string, args: Body) => Promise<Body>, maxHops = 16): Promise<Body[]> {
  const responses = [first];
  const seen = new Set<string>();
  let body = first;
  for (;;) {
    const next = (body["limit"] as Body | undefined)?.["next"] as { tool: string; arguments: Body } | undefined;
    if (next === undefined) return responses;
    if (responses.length > maxHops) throw new Error(`read exceeded ${maxHops} continuation calls`);
    if (next.tool !== "tl_read_file" || typeof next.arguments !== "object" || next.arguments === null) {
      throw new Error("read continuation is not a published read call");
    }
    const key = JSON.stringify(next);
    if (seen.has(key)) throw new Error("read repeated the same continuation");
    seen.add(key);
    body = await call(next.tool, next.arguments);
    if (body["task"] !== undefined || body["decision"] !== undefined) throw new Error("read continuation became a task");
    responses.push(body);
  }
}
