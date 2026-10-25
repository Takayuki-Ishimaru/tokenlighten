import {randomUUID} from "node:crypto";
import type {ReadCallDispatchBinding} from "@tokenlighten/types";
import {ledgerCoverage, normalizeWindows, parseWindow, subtractWindows} from "../state/readRequestStore.js";
import {mintReadCallContinuation} from "../state/readCallContinuationStore.js";
import {mintReadCallCursorAlias} from "../state/readCallCursorAliases.js";
import {registerReadCallBatchGroup} from "../state/readCallBatchGroup.js";
import {expandTaskHandle} from "../state/taskHandleAliases.js";
import {shaOfText} from "../util/handles.js";
import {coalesceBlankGapWindows} from "../features/task-pack/blankWindowBundles.js";
type Row = Record<string, unknown>;
const row = (value: unknown): Row | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Offer the two remaining pages together; the server serializes their normal
 * semantic dispatches. No page changes readiness or marks planned bytes served.
 */
export async function projectReadOnlyBatchContinuations(input: {
  workspace: string; lane: string; body: Row; dispatch: ReadCallDispatchBinding;
  plan: {windows: readonly {path:string;range:string}[]; validate:()=>boolean};
  read: (file: string) => Promise<string | null>;
}): Promise<Row> {
  const {workspace,lane,body,dispatch,plan,read} = input;
  const decision = row(body["decision"]), next = row(decision?.["next"]), args = row(next?.["arguments"]), task = row(args?.["task"]);
  if (body["kind"] !== "read.task_pack" || body["profile"] !== "answer" || decision?.["kind"] !== "discover"
    || next?.["tool"] !== "tl_read_file" || !args || !task || typeof task["handle"] !== "string"
    || typeof args["query"] !== "string" || args["cwd"] !== workspace || (args["lane"] ?? "") !== lane
    || args["cursor"] !== undefined || args["qref"] !== undefined || args["budget"] !== undefined
    || args["comments"] !== undefined || task["expected_state_version"] !== undefined
    || task["force_serve"] === true || task["pull"] !== undefined || !plan.validate()) return body;
  try {
    const canonical = expandTaskHandle(workspace,lane,task["handle"]) ?? task["handle"];
    const byPath = new Map<string, Array<{start:number;end:number}>>();
    for (const window of plan.windows) {
      const span = parseWindow(window.range); if (!span) return body;
      const spans = byPath.get(window.path) ?? []; spans.push(span); byPath.set(window.path,spans);
    }
    if (byPath.size > 4) return body;
    const sources = new Map<string,{text:string;sha:string;lines:string[]}>();
    const pages: Array<Array<{path:string;range:string}>> = [[]];
    let bytes = 0;
    // Bound raw source per page below the existing 18KiB response ceiling.
    // The ordinary planner still owns final fitting and continuation honesty.
    const sourceCap = 15300;
    for (const [file, spans] of byPath) {
      const text = await read(file); if (text === null) return body;
      const source = {text,sha:shaOfText(text),lines:text.replace(/\r\n/g,"\n").split("\n")}; sources.set(file,source);
      const missing = subtractWindows(normalizeWindows(spans),ledgerCoverage(workspace,file,source.sha));
      const bundled = coalesceBlankGapWindows(missing.map(span=>({path:file,range:`${span.start}-${span.end}`})),
        ()=>source.text,96*1024);
      for (const target of bundled) {
        const span = parseWindow(target.range)!;
        if (span.end > source.lines.length) return body;
        let start = span.start;
        for (let line = span.start; line <= span.end; line++) {
          const cost = Buffer.byteLength(source.lines[line-1]!)+1;
          if (cost > sourceCap) return body;
          if (bytes+cost > sourceCap) {
            if (line > start) pages.at(-1)!.push({path:file,range:`${start}-${line-1}`});
            pages.push([]); if (pages.length > 2) return body;
            bytes=0; start=line;
          }
          bytes+=cost;
        }
        pages.at(-1)!.push({path:file,range:`${start}-${span.end}`});
      }
    }
    if (pages.length !== 2 || pages.some(page => page.length === 0 || page.length > 64)) return body;
    const id=randomUUID(), calls: Row[]=[], canonicalCursors: string[]=[];
    for (const targets of pages) {
      const original: Row = {...clone(args),targets,task:{...task,handle:canonical,profile:"answer"}};
      delete original["cwd"]; delete original["lane"];
      const paths = new Set(targets.map(target=>target.path));
      const bindings = [...sources].filter(([file])=>paths.has(file)).map(([path,value])=>({path,sha:value.sha}));
      const cursor=mintReadCallContinuation({workspaceRoot:workspace,lane,taskHandle:canonical,dispatchBinding:dispatch,
        originalInput:original,sources:bindings,responseProfile:"answer",batchGroup:id,
        batchSources:[...sources].map(([path,value])=>({path,sha:value.sha}))});
      if (!cursor) return body;
      canonicalCursors.push(cursor);
      const exposed=mintReadCallCursorAlias({workspaceRoot:workspace,lane,canonicalCursor:cursor}) ?? cursor;
      calls.push({tool:"tl_read_file",arguments:{cwd:workspace,...(lane ? {lane}:{}),cursor:exposed}});
    }
    const projected = {...body,decision:{...decision,next:calls}};
    // The final response was already fitted: this optimization may only shrink.
    // `projected` differs from `body` ONLY in the value of `decision.next` (same
    // keys, same order), so the response grows by exactly what that value grows
    // by. Compare the call arguments themselves -- the replaced `next` against its
    // replacement -- never the whole response (G8: wireBudgetG8Fence.spec.ts lists
    // these two sites under REQUEST_PLAN_SIZE_EXEMPT). The workspace's absolute
    // `cwd` is set aside on both sides: the transport copy drops it from a cursor
    // call under the configured root, and a comparison that carried it (twice in
    // the replacement, once in the original) would turn the siblings into a single
    // next once the path was long enough (2026-10-23).
    const bare = (value: unknown): unknown => {
      const call = clone(value), args = row(row(call)?.["arguments"]);
      if (args) delete args["cwd"];
      return call;
    };
    if (Buffer.byteLength(JSON.stringify(calls.map(bare))) > Buffer.byteLength(JSON.stringify(bare(next))) || !plan.validate()) return body;
    if (!registerReadCallBatchGroup({id,workspace,lane,taskHandle:canonical,
      cursors:canonicalCursors,dispatchBinding:dispatch,
      validate:plan.validate,expiresAtMs:Date.now()+60*60*1000})) return body;
    return projected;
  } catch {return body;}
}
