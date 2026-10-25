import type {ReadCallDispatchBinding} from "@tokenlighten/types";
import {afterEach, describe, expect, it, vi} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {randomUUID} from "node:crypto";
import {registerReadCallBatchGroup, withReadCallBatchQueue, takeReadCallBatchSemanticLease,
  finishReadCallBatchMember, resetReadCallBatchGroupsForTests, reuseReadCallBatchSiblingNext} from "../state/readCallBatchGroup.js";
import {withReadCallDispatch, isReadCallDispatchCurrent, takeReadCallSemanticLease,
  resetReadCallDispatchForTests} from "../state/readCallDispatch.js";
import {mintTaskHandle, resolveTaskHandle} from "../state/stateHandles.js";
import {mintReadCallContinuation, resolveReadCallContinuation, claimReadCallContinuation, readCallExecutionKey} from "../state/readCallContinuationStore.js";
import {resetStateStoresForTests,stateStoreFor} from "../state/stateStore.js";
import {validateHandleToken} from "../state/handleCodec.js";
import {runWithSessionLane} from "../util/laneKey.js";
import {hydrateReadCallContinuation, projectReadCallContinuations} from "../protocol/readCallContinuation.js";
import {mintReadCallCursorAlias} from "../state/readCallCursorAliases.js";
import {shaOfText, type HandleEntry} from "../util/handles.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  resetReadCallBatchGroupsForTests();
  resetReadCallDispatchForTests();
  resetStateStoresForTests();
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true, force:true});
});
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {resolve = r;});
  return {promise, resolve};
}
async function setup(ranges = ["1-1", "2-2"], query = "Explain the control flow without edits.") {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-batch-group-")));
  roots.push(workspace);
  const lane = "batch-lane", fingerprint = "answer:" + randomUUID(), id = randomUUID();
  const taskHandle = runWithSessionLane(lane, () => mintTaskHandle(workspace, {
    taskFingerprint:fingerprint, mintedAtMs:Date.now(),
  }))!;
  let valid = true;
  const validate = () => valid;
  let tokens: string[] = [];
  await withReadCallDispatch(workspace, lane, async dispatch => {
    expect(dispatch).toBeDefined();
    tokens = ranges.map(range => mintReadCallContinuation({
      workspaceRoot:workspace, lane, taskHandle, dispatchBinding:dispatch!,
      originalInput:{query,
        targets:[{path:"flow.java",range}], task:{handle:taskHandle,profile:"answer"}},
      sources:[{path:"flow.java",sha:shaOfText("same pinned source")}],
      responseProfile:"answer",
      // Root integration prerequisite: this field is persisted as authenticated
      // ReadCallContinuationState.batch_group, never patched into a live record.
      batchGroup:id, batchSources:[{path:"flow.java",sha:shaOfText("same pinned source")}],
    })!);
    expect(tokens.every(Boolean)).toBe(true);
    expect(registerReadCallBatchGroup({id,workspace,lane,taskHandle,cursors:tokens,
      dispatchBinding:dispatch!,validate,expiresAtMs:Date.now()+30_000})).toBe(true);
  });
  return {workspace,lane,fingerprint,id,taskHandle,tokens,query,
    invalidate:() => {valid=false;},
    bump:() => runWithSessionLane(lane, () => mintTaskHandle(workspace, {
      taskFingerprint:fingerprint, ledgerDigest:randomUUID(), mintedAtMs:Date.now(),
    })),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function execute(s: Setup, index: number, options: {
  during?: (dispatch: ReadCallDispatchBinding | undefined) => Promise<void>; success?: boolean; omitFinish?: boolean;
} = {}) {
  const cursor = s.tokens[index]!;
  return withReadCallBatchQueue(s.workspace,s.lane,cursor,() =>
    withReadCallDispatch(s.workspace,s.lane,async dispatch => {
      const resolved = resolveReadCallContinuation({
        workspaceRoot:s.workspace,lane:s.lane,taskHandle:s.taskHandle,cursor,
      });
      if (resolved.kind !== "read-call") throw new Error("unexpected cursor refusal");
      const first = claimReadCallContinuation(s.workspace,resolved.state);
      // Mirrors REQUIRED hydration routing: no ordinary lease fallback for any
      // authenticated marked member, even when the ephemeral map disappeared.
      const semantic = first === true && (resolved.state.batch_group !== undefined
        ? takeReadCallBatchSemanticLease(s.workspace,s.lane,dispatch,resolved.state.batch_group,cursor)
        : takeReadCallSemanticLease(s.workspace,s.lane,dispatch,resolved.state.dispatch_binding));
      await options.during?.(dispatch);
      if (!options.omitFinish) finishReadCallBatchMember(s.workspace,s.lane,cursor,dispatch,
        semantic && options.success !== false);
      return semantic;
    }));
}
describe("ephemeral authenticated read-only semantic batch dispatch", () => {
  it("hydrates short aliases inside canonical sibling queues without losing either semantic lease", async () => {
    const s = await setup();
    const aliases = s.tokens.map(canonicalCursor => mintReadCallCursorAlias({
      workspaceRoot: s.workspace, lane: s.lane, canonicalCursor,
    }));
    expect(aliases.every(alias => alias?.length === 42)).toBe(true);
    for (const index of [1, 0]) {
      const canonical = s.tokens[index]!;
      const result = await withReadCallBatchQueue(s.workspace, s.lane, canonical, () =>
        withReadCallDispatch(s.workspace, s.lane, async dispatch => {
          const hydrated = await hydrateReadCallContinuation(s.workspace, s.lane,
            {cursor: aliases[index]}, async file => file === "flow.java" ? "same pinned source" : null,
            () => undefined, undefined, dispatch);
          const semantic = hydrated.kind === "hydrated" && hydrated.input.query === s.query;
          finishReadCallBatchMember(s.workspace, s.lane, canonical, dispatch, semantic);
          return hydrated;
        }));
      expect(result.kind === "hydrated" && result.input.query).toBe(s.query);
      expect(result.kind === "hydrated" && result.input.targets).toEqual([
        {path: "flow.java", range: index === 0 ? "1-1" : "2-2"},
      ]);
    }
  });

  it("admits reverse order and tracks only its own normal task progress", async () => {
    const s = await setup(), initial = resolveTaskHandle(s.taskHandle,s.workspace);
    expect(await execute(s,1,{during:async () => {s.bump();}})).toBe(true);
    const next = resolveTaskHandle(s.taskHandle,s.workspace);
    expect(initial.ok && next.ok && next.stateVersion > initial.stateVersion).toBe(true);
    expect(await execute(s,0)).toBe(true);
  });

  it("queues BEFORE generation allocation and waits through final projection", async () => {
    const s=await setup(), entered=latch(), release=latch(), order:string[]=[];
    const first=execute(s,1,{during:async () => {
      order.push("first-projection"); entered.resolve(); await release.promise;
      s.bump(); order.push("first-final");
    }});
    await entered.promise;
    const second=execute(s,0,{during:async () => {order.push("second-planner");}});
    await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(["first-projection"]);
    release.resolve();
    expect(await Promise.all([first,second])).toEqual([true,true]);
    expect(order).toEqual(["first-projection","first-final","second-planner"]);
  }, 5000);

  it("never leases a duplicate and taints subsequent members", async () => {
    const s=await setup();
    expect(await execute(s,0)).toBe(true);
    expect(await execute(s,0)).toBe(false);
    expect(await execute(s,1)).toBe(false);
  });

  it("serializes simultaneous duplicates without granting a second semantic turn", async () => {
    const s=await setup();
    expect(await Promise.all([execute(s,0),execute(s,0)])).toEqual([true,false]);
    expect(await execute(s,1)).toBe(false);
  }, 5000);

  it("loses the rolling generation after an outside call between members", async () => {
    const s=await setup();
    expect(await execute(s,0)).toBe(true);
    await withReadCallDispatch(s.workspace,s.lane,async () => {});
    expect(await execute(s,1)).toBe(false);
  });

  it("loses the immediate generation before the first member too", async () => {
    const s=await setup();
    await withReadCallDispatch(s.workspace,s.lane,async () => {});
    expect(await execute(s,1)).toBe(false);
    expect(await execute(s,0)).toBe(false);
  });

  it("rejects unowned parent version changes", async () => {
    const s=await setup(); s.bump();
    expect(await execute(s,0)).toBe(false);
  });

  it("detects an unobserved parent write during an owned dispatch even before a later owned CAS", async () => {
    const s=await setup();
    expect(await execute(s,0,{during:async()=>{
      const token=validateHandleToken({token:s.taskHandle,expectedPurpose:"task",workspaceRoot:s.workspace});
      if(!token.ok) throw Error("missing task");
      const store=stateStoreFor(s.workspace)!;
      const record=store.get(token.decoded.payloadRef)!;
      expect(store.put({key:token.decoded.payloadRef,purpose:"task",data:{...record.data,ledgerDigest:"outside-writer"},
        ttlMs:30000,expectedVersion:record.version}).ok).toBe(true);
      s.bump();
    }})).toBe(true);
    expect(await execute(s,1)).toBe(false);
  });

  it("keeps the group disabled when a source or original facet plan changed", async () => {
    const s=await setup(); s.invalidate();
    expect(await execute(s,0)).toBe(false);
    expect(await execute(s,1)).toBe(false);
  });

  it("checks source and plan again after the final reply", async () => {
    const s=await setup();
    expect(await execute(s,0,{during:async () => {s.invalidate();}})).toBe(true);
    expect(await execute(s,1)).toBe(false);
  });

  it.each(["refusal","missing-finish","exception"])("does not advance after %s", async reason => {
    const s=await setup();
    if (reason === "exception") {
      await expect(execute(s,0,{during:async () => {throw new Error("cancelled");}})).rejects.toThrow("cancelled");
    } else {
      expect(await execute(s,0,{success:reason !== "refusal",omitFinish:reason === "missing-finish"})).toBe(true);
    }
    expect(await execute(s,1)).toBe(false);
  });

  it("expired ephemeral groups cannot use the ordinary immediate lease", async () => {
    const s=await setup(), now=Date.now();
    vi.spyOn(Date,"now").mockReturnValue(now+31_000);
    expect(await execute(s,0)).toBe(false);
  });

  it("reset before the FIRST member still forbids the ordinary immediate lease", async () => {
    const s=await setup();
    resetReadCallBatchGroupsForTests();
    // Dispatch generation is still exactly mint+1: only the persisted marker
    // prevents an accidental fallback to the ordinary semantic lease.
    expect(await execute(s,0)).toBe(false);
  });

  it("requires the queue scope even for a valid first-claimed cursor", async () => {
    const s=await setup();
    await withReadCallDispatch(s.workspace,s.lane,async dispatch => {
      const r=resolveReadCallContinuation({workspaceRoot:s.workspace,lane:s.lane,cursor:s.tokens[0]!});
      if(r.kind!=="read-call") throw new Error("no cursor");
      expect(claimReadCallContinuation(s.workspace,r.state)).toBe(true);
      expect(takeReadCallBatchSemanticLease(s.workspace,s.lane,dispatch,s.id,s.tokens[0]!)).toBe(false);
      expect(isReadCallDispatchCurrent(s.workspace,s.lane,dispatch!)).toBe(true);
    });
    expect(await execute(s,1)).toBe(false);
  });

  it("does not match a foreign lane or a tampered token to the registered group", async () => {
    const s=await setup();
    await withReadCallDispatch(s.workspace,"foreign",async dispatch => {
      expect(takeReadCallBatchSemanticLease(s.workspace,"foreign",dispatch,s.id,s.tokens[0]!)).toBe(false);
    });
    const bad=s.tokens[0]!.slice(0,-1)+(s.tokens[0]!.endsWith("a")?"b":"a");
    expect(resolveReadCallContinuation({workspaceRoot:s.workspace,lane:s.lane,cursor:bad}).kind).not.toBe("read-call");
    expect(await execute(s,0)).toBe(true);
  });

  it("does not admit unmarked ordinary cursors as batch members", async () => {
    const s=await setup();
    await withReadCallDispatch(s.workspace,s.lane,async dispatch => {
      const ordinary=[1,2].map(n=>mintReadCallContinuation({
        workspaceRoot:s.workspace,lane:s.lane,taskHandle:s.taskHandle,dispatchBinding:dispatch!,
        originalInput:{query:"Explain.",targets:[{path:"flow.java",range:n+"-"+n}],
          task:{handle:s.taskHandle,profile:"answer"}},
        sources:[{path:"flow.java",sha:shaOfText("same pinned source")}],responseProfile:"answer",
      })!);
      expect(registerReadCallBatchGroup({id:randomUUID(),workspace:s.workspace,lane:s.lane,
        taskHandle:s.taskHandle,cursors:ordinary,dispatchBinding:dispatch!,validate:()=>true,
        expiresAtMs:Date.now()+10_000})).toBe(false);
    });
  });
});

function discover(s: Setup, targets: unknown = [{path:"flow.java",range:"1-1"}]): Record<string, unknown> {
  return {kind:"read.task_pack",profile:"answer",task:{id:s.taskHandle},evidence:[],
    decision:{kind:"discover",gaps:[{code:"missing-evidence",refs:["flow"]}],
      next:{tool:"tl_read_file",arguments:{cwd:s.workspace,lane:s.lane,
        query:s.query,targets,task:{handle:s.taskHandle,profile:"answer"}}}}};
}
function reuse(s: Setup, dispatch: ReadCallDispatchBinding | undefined, body = discover(s),
  resolve: Parameters<typeof reuseReadCallBatchSiblingNext>[0]["resolve"] = () => undefined) {
  return reuseReadCallBatchSiblingNext({workspace:s.workspace,lane:s.lane,cursor:s.tokens[1],dispatch,body,resolve});
}
describe("reuse of an already issued sibling next", () => {
  it("reverse B then A reuses A without a third plan or readiness mutation", async () => {
    const s=await setup();
    await execute(s,1,{during:async dispatch => {
      s.bump(); // Own normal semantic progress remains admissible.
      const body=discover(s), before=JSON.stringify(body);
      const put=vi.spyOn(stateStoreFor(s.workspace)!,"put");
      const projected=reuse(s,dispatch,body);
      expect(projected).toBeDefined();
      // This is the server's ordering: only a failed reuse reaches ordinary mint.
      const result=projected ?? await projectReadCallContinuations(s.workspace,s.lane,body,
        async()=>"same pinned source",()=>undefined,dispatch);
      const decision=result["decision"] as Record<string,unknown>;
      expect(decision["kind"]).toBe("discover");
      expect(decision["gaps"]).toEqual((body["decision"] as Record<string,unknown>)["gaps"]);
      expect(decision["next"]).toEqual({tool:"tl_read_file",arguments:{cwd:s.workspace,lane:s.lane,cursor:s.tokens[0]}});
      expect(JSON.stringify(body)).toBe(before);
      expect(put).not.toHaveBeenCalled();
      put.mockRestore();
    }});
    expect(await execute(s,0)).toBe(true);
  });

  it("reuses a complete disjoint union of two unused siblings without bridging its hole",async()=>{
    const s=await setup(["1-1","2-2","4-4"],"Explain the complete control flow. ".repeat(30));
    await execute(s,1,{during:async dispatch=>{
      const body=discover(s,[{path:"flow.java",ranges:["1-1","4-4"]}]);
      const projected=reuse(s,dispatch,body);
      expect(projected).toBeDefined();
      expect((projected!["decision"] as Record<string,unknown>)["next"]).toEqual([0,2].map(i=>({
        tool:"tl_read_file",arguments:{cwd:s.workspace,lane:s.lane,cursor:s.tokens[i]}})));
      expect(reuse(s,dispatch,discover(s,[{path:"flow.java",range:"1-4"}]))).toBeUndefined();
    }});
  });

  it("reuses a previously published superset for a narrower next without changing its plan",async()=>{
    const s=await setup(["1-3","4-4"]);
    await execute(s,1,{during:async dispatch=>{
      const before=resolveReadCallContinuation({workspaceRoot:s.workspace,lane:s.lane,cursor:s.tokens[0]!});
      const projected=reuse(s,dispatch,discover(s,[{path:"flow.java",range:"2-2"}]));
      expect(projected).toBeDefined();
      expect((projected!["decision"] as Record<string,any>)["next"].arguments.cursor).toBe(s.tokens[0]);
      expect(resolveReadCallContinuation({workspaceRoot:s.workspace,lane:s.lane,cursor:s.tokens[0]!})).toEqual(before);
    }});
  });

  it.each([
    [[{path:"flow.java",range:"1-3"}]],
    [[{path:"flow.java",ranges:["1-1","3-3"]}]],
    [[{path:"other.java",range:"1-1"}]],
    [[{handle:"unknown",range:"1-1"}]],
    [[{path:"../flow.java",range:"1-1"}]],
    [[{path:"flow.java",range:"1-1",purpose:"new scope"}]],
    [[{path:"flow.java"}]],
  ])("keeps the producer on incomplete or unknown fixed scope %#", async targets => {
    const s=await setup();
    await execute(s,1,{during:async dispatch=>{expect(reuse(s,dispatch,discover(s,targets))).toBeUndefined();}});
    expect(await execute(s,0)).toBe(true);
  });

  it.each(["query","qref","budget","force","cas","task","profile","cwd","lane","terminal"])(
    "preserves changed semantics or identity: %s",async field=>{
      const s=await setup();
      await execute(s,1,{during:async dispatch=>{
        const body=discover(s), decision=body["decision"] as Record<string,unknown>;
        const args=(decision["next"] as Record<string,unknown>)["arguments"] as Record<string,unknown>;
        const task=args["task"] as Record<string,unknown>;
        if(field==="query")args["query"]="Another request";
        if(field==="qref")args["qref"]="another reference";
        if(field==="budget")args["budget"]={bytes:1000};
        if(field==="force")task["force_serve"]=true;
        if(field==="cas")task["expected_state_version"]=1;
        if(field==="task")task["handle"]="unknown";
        if(field==="profile")task["profile"]="generic";
        if(field==="cwd")args["cwd"]+="/other";
        if(field==="lane")args["lane"]="another-lane";
        if(field==="terminal")decision["kind"]="act.answer";
        expect(reuse(s,dispatch,body)).toBeUndefined();
      }});
    });

  it("resolves read handles as exact workspace/lane/path identities, with plan-bounded overrides",async()=>{
    const s=await setup();
    await execute(s,1,{during:async dispatch=>{
      const body=discover(s,[{handle:"hfixed",range:"1-1"}]);
      const entry={id:"hfixed",purpose:"content" as const,kind:"range" as const,
        workspaceRoot:s.workspace,lane:s.lane,path:"flow.java",range:"1-1"};
      const resolve=()=>entry as HandleEntry;
      expect(reuse(s,dispatch,body,resolve)).toBeDefined();
      expect(reuse(s,dispatch,body,()=>({...resolve()!,lane:"other"}))).toBeUndefined();
      expect(reuse(s,dispatch,body,()=>({...resolve()!,workspaceRoot:s.workspace+"/other"}))).toBeUndefined();
      expect(reuse(s,dispatch,body,()=>({...resolve()!,range:"2-2"}))).toBeDefined();
      expect(reuse(s,dispatch,body,()=>({...resolve()!,path:"other.java"}))).toBeUndefined();
    }});
  });

  it.each(["missing","claimed","source","restart","version","expired"])(
    "does not replace a next after %s loses its proof",async failure=>{
      const s=await setup();
      await execute(s,1,{during:async dispatch=>{
        const r=resolveReadCallContinuation({workspaceRoot:s.workspace,lane:s.lane,cursor:s.tokens[0]!});
        expect(r.kind).toBe("read-call");
        if(r.kind!=="read-call")throw new Error("missing fixture plan");
        if(failure==="missing")stateStoreFor(s.workspace)!.delete(readCallExecutionKey(r.state));
        if(failure==="claimed")expect(claimReadCallContinuation(s.workspace,r.state)).toBe(true);
        if(failure==="source")s.invalidate();
        if(failure==="restart")resetReadCallBatchGroupsForTests();
        if(failure==="version"){
          // Bypass the observed normal mutation path; no borrowed CAS ownership.
          const token=validateHandleToken({token:s.taskHandle,expectedPurpose:"task",workspaceRoot:s.workspace});
          if(!token.ok)throw new Error("invalid fixture task");
          const store=stateStoreFor(s.workspace)!,key=token.decoded.payloadRef,record=store.get(key)!;
          expect(store.put({key,purpose:"task",data:record.data,ttlMs:60_000,expectedVersion:record.version}).ok).toBe(true);
        }
        if(failure==="expired")vi.spyOn(Date,"now").mockReturnValue(Date.now()+31_000);
        expect(reuse(s,dispatch)).toBeUndefined();
      }});
    });

  it("requires the live leased ALS turn, and cannot reuse an already executed sibling",async()=>{
    const s=await setup();
    expect(reuse(s,undefined)).toBeUndefined();
    expect(await execute(s,0)).toBe(true);
    await execute(s,1,{during:async dispatch=>{expect(reuse(s,dispatch)).toBeUndefined();}});
  });
});
