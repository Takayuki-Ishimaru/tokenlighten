import { afterEach, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindTaskContractHandle, clearTaskContractsForLane, naturalQueryForScope, naturalQueryForRequest, recordNaturalQueryOrigin, recordTaskContract, resetTaskContractStoreForTest, taskContractLedgerSnapshot } from "../features/task-pack/taskContractStore.js";
import { resetStateStoresForTests } from "../state/stateStore.js";

const roots: string[] = [];
afterEach(() => {
  resetTaskContractStoreForTest();
  resetStateStoresForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), "tl-natural-origin-")));
  roots.push(value);
  return value;
}
it("binds provenance to the original query, lane and task without proving obligations", () => {
  const ws = root(), a = { lane: "a" }, b = { lane: "b" };
  const query = "How are exception handlers selected?", tokens = ["exception", "handlers", "selected"];
  expect(recordNaturalQueryOrigin(ws, query, a)).toBe(false);
  recordTaskContract(ws, tokens, { query, requiredRoles: ["implementation"] }, a);
  const before = taskContractLedgerSnapshot(ws, a);
  expect(recordNaturalQueryOrigin(ws, query + " extra", a)).toBe(false);
  expect(recordNaturalQueryOrigin(ws, query, a)).toBe(true);
  expect(taskContractLedgerSnapshot(ws, a)).toEqual(before);
  expect(naturalQueryForScope(ws, b)).toBeUndefined();
  const bound = bindTaskContractHandle(ws, a, "task-a");
  expect(naturalQueryForScope(ws, bound)).toBe(query);
  expect(naturalQueryForScope(ws, { lane: "a", taskHandle: "task-b" })).toBeUndefined();
  // Dropping memory simulates restart; the existing durable scoped record owns it.
  resetTaskContractStoreForTest();
  resetStateStoresForTests();
  expect(naturalQueryForScope(ws, bound)).toBe(query);
  clearTaskContractsForLane(ws, "a");
  expect(naturalQueryForScope(ws, bound)).toBeUndefined();
});
it("does not inherit provenance into another task or an initially targeted task", () => {
  const ws = root(), scope = { lane: "a" };
  recordTaskContract(ws, ["first", "query"], { query: "first query" }, scope);
  recordNaturalQueryOrigin(ws, "first query", scope);
  recordTaskContract(ws, ["unrelated", "operation"], { query: "unrelated operation" }, scope);
  expect(naturalQueryForScope(ws, scope)).toBeUndefined();
  recordTaskContract(ws, ["unrelated", "operation"], { query: "unrelated operation" }, { lane: "b" });
  expect(naturalQueryForScope(ws, { lane: "b" })).toBeUndefined();
});

it("resumes a bound narrowed task but never rewrites a different unbound request", () => {
  const ws = root(), scope = { lane: "request-identity" };
  const query = "How does packet priority change?", tokens = ["packet", "priority", "change"];
  recordTaskContract(ws, tokens, { query }, scope);
  expect(recordNaturalQueryOrigin(ws, query, scope)).toBe(true);
  expect(naturalQueryForRequest(ws, query, scope)).toBe(query);
  expect(naturalQueryForRequest(ws, "Connect the telemetry consumer", scope)).toBeUndefined();
  expect(naturalQueryForRequest(ws, undefined, scope)).toBeUndefined();
  const bound = bindTaskContractHandle(ws, scope, "bound-natural-task");
  expect(naturalQueryForRequest(ws, "Read only the selected implementation", bound)).toBe(query);
  expect(naturalQueryForRequest(ws, undefined, bound)).toBe(query);
  expect(naturalQueryForRequest(ws, query, { lane: "other" })).toBeUndefined();
});
