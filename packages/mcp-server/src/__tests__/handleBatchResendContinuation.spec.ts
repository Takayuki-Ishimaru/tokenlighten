import {describe, expect, it} from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {makeSmallTaskWorkspace, startSmallTaskServer, type CallResult} from "./helpers/smallTaskServer.js";

type Row = Record<string, unknown>;
const files = Object.fromEntries(["alpha.ts", "beta.ts"].map((file, index) => [file,
  Array.from({length: 180}, (_, line) => line % 9 === 0
    ? `/** BODY_${index}_${line + 1} ${"comment ".repeat(13)} */`
    : `export const BODY_${index}_${line + 1} = "${"source ".repeat(13)}";`).join("\n")]));
const rows = (body: Row): Row[] => (body["entries"] ?? body["evidence"] ?? []) as Row[];
const nextOf = (body: Row): {tool: string; arguments: Row} | undefined =>
  (body["limit"] as Row | undefined)?.["next"] as {tool: string; arguments: Row} | undefined;

describe("bounded handle-batch resend continuations", () => {
  it("resends actual source on every forced, new-task, budget and full-content page", async () => {
    const ws = makeSmallTaskWorkspace("tl-handle-resend-", files);
    const server = await startSmallTaskServer(ws, {env: {TOKENLIGHTEN_CLIENT_ID: "claude-code"}});
    try {
      const handles: string[] = [];
      for (const file of Object.keys(files)) {
        const mint = await server.call("tl_read_file", {cwd: ws, targets: [{path: file, range: "1-1"}], content: "full"});
        handles.push(String(rows(mint.body)[0]!["handle"]));
      }
      const targets = handles.map(handle => ({handle, ranges: ["1-70", "90-180"]}));
      const drain = async (input: Row): Promise<CallResult[]> => {
        const pages: CallResult[] = [];
        let reply = await server.call("tl_read_file", {cwd: ws, targets, ...input});
        const taskId = (reply.body["task"] as Row | undefined)?.["id"];
        for (let page = 0; page < 20; page++) {
          pages.push(reply);
          expect(reply.bytes).toBeLessThanOrEqual(20_000);
          expect((reply.body["task"] as Row | undefined)?.["id"]).toBe(taskId);
          expect(["read.batch", "read.text"], JSON.stringify(reply.body).slice(0, 500)).toContain(reply.body["kind"]);
          const next = nextOf(reply.body);
          if (!next) return pages;
          expect(next.arguments["query"]).toBeUndefined();
          expect((next.arguments["task"] as Row | undefined)?.["epoch"]).toBeUndefined();
          reply = await server.call(next.tool, next.arguments);
        }
        throw new Error("resend continuation did not terminate");
      };
      // Hold all requested code and comments before each control: later body
      // assertions must be satisfied by that control's wire alone.
      await drain({content: "full"});
      for (const input of [{task: {force_serve: true}}, {task: {epoch: "new"}}, {budget: {bytes: 60000}}, {content: "full"}]) {
        const pages = await drain(input);
        expect(pages.length).toBeGreaterThan(1);
        const delivered = pages.flatMap(page => rows(page.body)).map(row => row["body"] ?? row["content"]).filter(value => typeof value === "string").join("\n");
        for (const [index] of Object.keys(files).entries()) {
          for (let line = 1; line <= 180; line++) {
            if (line > 70 && line < 90) continue;
            if ((line - 1) % 9 === 0 && !("content" in input)) continue;
            expect(delivered, `${JSON.stringify(input)} omitted BODY_${index}_${line}`).toContain(`BODY_${index}_${line} `);
          }
        }
        expect(pages.flatMap(page => rows(page.body)).some(row => row["prior"] !== undefined || row["reason"] === "already-served")).toBe(false);
      }

      // Source validation still precedes a forced cursor's body replay.
      const first = await server.call("tl_read_file", {cwd: ws, targets, task: {force_serve: true}, content: "full"});
      const next = nextOf(first.body);
      expect(next).toBeDefined();
      fs.appendFileSync(path.join(ws, "beta.ts"), "\nexport const changed = true;");
      const stale = await server.call(next!.tool, next!.arguments);
      expect(stale.body["kind"]).toBe("refusal");
      expect(JSON.stringify(stale.body)).toContain("cursor-stale");
      expect(rows(stale.body)).toEqual([]);
    } finally {
      await server.kill();
      fs.rmSync(ws, {recursive: true, force: true});
    }
  }, 120_000);
});
