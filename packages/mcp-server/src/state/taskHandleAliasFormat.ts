import { createHash } from "node:crypto";
export const TASK_ALIAS_PATTERN = /^tlh_s1_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{22})$/;
export interface TaskAliasBinding { alias: string; token: string; lane: string; expiresAtMs: number }
const MAX_BINDINGS = 16;
export function taskAliasOf(ref: string, token: string, lane: string): string {
  const digest = createHash("sha256").update(JSON.stringify(["task-alias-v1", token, lane])).digest().subarray(0, 16).toString("base64url");
  return `tlh_s1_${ref}_${digest}`;
}
export function taskAliasBindings(data: Readonly<Record<string, unknown>>): TaskAliasBinding[] | undefined {
  const raw = data["compactAliases"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_BINDINGS) return undefined;
  const result: TaskAliasBinding[] = [];
  for (const value of raw) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    if (typeof row["alias"] !== "string" || typeof row["token"] !== "string"
      || typeof row["lane"] !== "string" || typeof row["expiresAtMs"] !== "number"
      || !Number.isFinite(row["expiresAtMs"])) return undefined;
    result.push(row as unknown as TaskAliasBinding);
  }
  return result;
}
/** Called only inside the task's ordinary state commit, never during projection. */
export function taskAliasData(data: Readonly<Record<string, unknown>>, ref: string, token: string, lane: string, expiresAtMs: number): Record<string, unknown> {
  const prior = taskAliasBindings(data);
  if (prior === undefined) return {};
  const live = prior.filter(row => row.expiresAtMs > Date.now());
  const alias = taskAliasOf(ref, token, lane);
  if (!live.some(row => row.alias === alias) && live.length < MAX_BINDINGS) live.push({ alias, token, lane, expiresAtMs });
  return { compactAliases: live };
}
