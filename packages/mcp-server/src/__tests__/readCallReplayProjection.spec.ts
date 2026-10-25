import {describe, expect, it} from "vitest";
import {projectAuthenticatedReadBatchReplay, type ReadCallReplayAuthorization} from "../protocol/readCallContinuation.js";
import type {FinalSourceCapsule} from "../features/task-pack/sourceCapsuleCallScope.js";
import {shaOfText, type HandleEntry} from "../util/handles.js";

const workspace="/workspace", lane="copilot", file="src/order.ts", range="4-5";
const body="four".repeat(80), fullSource="one\ntwo\nthree\nfour\nfive\nsix\n";
const fullSha=shaOfText(fullSource), rowSha=shaOfText(body);
const authorization:ReadCallReplayAuthorization={taskHandle:"authenticated-task",sourceBindings:[{path:file,sha:fullSha}],
  targets:[{path:file,ranges:[range]}]};
const priorCapsule:FinalSourceCapsule={taskBinding:"task-binding",capsule:Object.freeze({path:file,sha:fullSha,
  handle:"h-prior",startLine:4,endLine:5,body})};
const handle=(id:string,fields:Partial<HandleEntry>={}):HandleEntry=>({id,purpose:"content",kind:"range",path:file,range,
  workspaceRoot:workspace,lane,sha:rowSha,createdAt:1,...fields});
const handles=new Map<string,HandleEntry>([["h-prior",handle("h-prior",{sha:undefined})],["h-current",handle("h-current")]]);
const readBody={v:1,kind:"read.batch",entries:[{form:"handle",path:file,range,handle:"h-current",sha:"sha256:"+rowSha.slice(7,19),content:body,truncated:false}]};
const project=(options:{prior?:readonly FinalSourceCapsule[];taskBinding?:string;auth?:ReadCallReplayAuthorization;current?:Partial<HandleEntry>;priorHandle?:Partial<HandleEntry>;entry?:Record<string,unknown>}={})=>{
  const table=new Map(handles);
  if(options.current)table.set("h-current",handle("h-current",options.current));
  if(options.priorHandle)table.set("h-prior",handle("h-prior",options.priorHandle));
  const body={...readBody,entries:[{...readBody.entries[0],...options.entry}]};
  return projectAuthenticatedReadBatchReplay(body,options.auth??authorization,options.prior??[priorCapsule],
    options.taskBinding??"task-binding",workspace,lane,id=>table.get(id));
};

describe("authenticated duplicate read-cursor batch projection",()=>{
  it("downgrades exact finalized source while accepting a newly minted authenticated handle",()=>{
    const result=project() as typeof readBody;
    expect(result.entries[0]).toMatchObject({form:"file-downgraded",reason:"already-served",range,handle:"h-current",
      code_unchanged:true,summary:{served:[range],complete:false}});
    expect(result.entries[0]).not.toHaveProperty("content");
    expect(result.entries[0].handle).not.toBe(priorCapsule.capsule.handle);
  });

  it("keeps a near-cap batch unchanged when the receipt projection would grow it",()=>{
    const tiny="x", tinySha=shaOfText(tiny), tinyFullSha=shaOfText(tiny);
    const tinyAuth:ReadCallReplayAuthorization={taskHandle:"authenticated-task",sourceBindings:[{path:file,sha:tinyFullSha}],
      targets:[{path:file,ranges:["1-1"]}]};
    const tinyPrior:FinalSourceCapsule={taskBinding:"task-binding",capsule:Object.freeze({path:file,sha:tinyFullSha,
      handle:"h-prior",startLine:1,endLine:1,body:tiny})};
    const tinyHandle=handle("h-current",{range:"1-1",sha:tinySha});
    const nearCap={v:1,kind:"read.batch",entries:[
      {form:"handle",path:file,range:"1-1",handle:"h-current",sha:"sha256:"+tinySha.slice(7,19),content:tiny,truncated:false},
      {form:"file",path:"src/unrequested.ts",range:"1-1",handle:"h-large",sha:"sha256:000000000000",content:"z".repeat(17_700),truncated:false},
    ]};
    const result=projectAuthenticatedReadBatchReplay(nearCap,tinyAuth,[tinyPrior],"task-binding",workspace,lane,
      id=>id==="h-current"?tinyHandle:id==="h-prior"?handle("h-prior",{range:"1-1",sha:tinySha}):undefined) as typeof nearCap;
    expect(result).toBe(nearCap);
    expect(result.entries[0]).toHaveProperty("content",tiny);
    expect(result.entries[1]).toHaveProperty("content","z".repeat(17_700));
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength)
      .toBe(new TextEncoder().encode(JSON.stringify(nearCap)).byteLength);
  });

  it("never replays a task-pack answer as a cursor batch receipt",()=>{
    const answer={...readBody,kind:"read.task_pack"};
    expect(projectAuthenticatedReadBatchReplay(answer as unknown as Record<string,unknown>,authorization,[priorCapsule],
      "task-binding",workspace,lane,id=>handles.get(id))).toBe(answer);
  });

  it.each([
    ["missing final delivery",{prior:[]}],
    ["wrong task binding",{taskBinding:"another-task"}],
    ["wrong lane handle",{current:{lane:"other"}}],
    ["wrong workspace handle",{priorHandle:{workspaceRoot:"/other"}}],
    ["wrong current content hash",{current:{sha:shaOfText("changed")}}],
    ["partial capsule coverage",{prior:[{taskBinding:"task-binding",capsule:Object.freeze({path:file,sha:fullSha,
      handle:"h-prior",startLine:4,endLine:4,body:"four\n"})}]}],
    ["wrong requested path",{auth:{...authorization,targets:[{path:"src/other.ts",ranges:[range]}]}}],
    ["wrong source revision",{auth:{...authorization,sourceBindings:[{path:file,sha:shaOfText("changed")}]}}],
    ["changed returned body",{entry:{content:"changed\n"}}],
    ["truncated returned body",{entry:{truncated:true}}],
    ["different returned range",{entry:{range:"4-6"}}],
  ] as const)("resends on %s",(_label,options)=>{
    const result=project(options as Parameters<typeof project>[0]) as typeof readBody;
    expect(result.kind).toBe("read.batch");
    expect(result.entries[0]?.form).toBe("handle");
    expect(typeof result.entries[0]?.content).toBe("string");
  });

  describe("multi-fragment finalized coverage",()=>{
    const source="alpha\nbeta\ngamma\n"+"delta".repeat(45)+"\n"+"epsilon".repeat(45)+"\n";
    const sourceSha=shaOfText(source), fragmentA="delta".repeat(45)+"\n", fragmentB="epsilon".repeat(45)+"\n";
    const fragmentAuth:ReadCallReplayAuthorization={taskHandle:"authenticated-task",sourceBindings:[{path:file,sha:sourceSha}],
      targets:[{path:file,ranges:["4-5"]}]};
    const fragments:FinalSourceCapsule[]=[
      {taskBinding:"task-binding",capsule:Object.freeze({path:file,sha:sourceSha,handle:"fragment-a",startLine:4,endLine:4,body:fragmentA})},
      {taskBinding:"task-binding",capsule:Object.freeze({path:file,sha:sourceSha,handle:"fragment-b",startLine:5,endLine:5,body:fragmentB})},
    ];
    const fragmentBody={v:1,kind:"read.batch",entries:[{form:"handle",path:file,range:"4-5",handle:"h-current",
      sha:"sha256:"+shaOfText(fragmentA+fragmentB).slice(7,19),content:fragmentA+fragmentB,truncated:false}]};
    const run=(capsules:readonly FinalSourceCapsule[]=fragments, opts:{taskBinding?:string;lane?:string;workspace?:string;
      auth?:ReadCallReplayAuthorization;current?:Partial<HandleEntry>;fragmentA?:Partial<HandleEntry>;fragmentB?:Partial<HandleEntry>}={})=>{
      const current=handle("h-current",{range:"4-5",sha:shaOfText(fragmentA+fragmentB),...opts.current});
      const table=new Map<string,HandleEntry>([["h-current",current],
        ["fragment-a",handle("fragment-a",{range:"4-4",sha:shaOfText(fragmentA),...opts.fragmentA})],
        ["fragment-b",handle("fragment-b",{range:"5-5",sha:shaOfText(fragmentB),...opts.fragmentB})]]);
      return projectAuthenticatedReadBatchReplay(fragmentBody,opts.auth??fragmentAuth,capsules,opts.taskBinding??"task-binding",
        opts.workspace??workspace,opts.lane??lane,id=>table.get(id)) as typeof fragmentBody;
    };

    it("downgrades a full requested range covered by exact adjacent finalized fragments",()=>{
      const result=run();
      expect(result.entries[0]).toMatchObject({form:"file-downgraded",reason:"already-served",range:"4-5",
        code_unchanged:true,summary:{served:["4-5"],complete:false}});
      expect(result.entries[0]).not.toHaveProperty("content");
    });

    it.each([
      ["missing middle line",[fragments[0]]],
      ["wrong fragment bytes",[fragments[0],{...fragments[1],capsule:Object.freeze({...fragments[1].capsule,body:"other\n"})}]],
      ["wrong fragment task",[fragments[0],{...fragments[1],taskBinding:"other-task"}]],
      ["wrong fragment source hash",[fragments[0],{...fragments[1],capsule:Object.freeze({...fragments[1].capsule,sha:shaOfText("other\n")})}]],
      ["wrong fragment handle",[fragments[0],{...fragments[1],capsule:Object.freeze({...fragments[1].capsule,handle:"unknown"})}]],
      ["overlapping fragments",[fragments[0],{...fragments[1],capsule:Object.freeze({...fragments[1].capsule,startLine:4,endLine:5})}]],
      ["subset coverage",[fragments[1]]],
    ] as const)("keeps the full batch on %s",(_label,capsules)=>{
      expect(run(capsules).entries[0]).toHaveProperty("content",fragmentA+fragmentB);
    });

    it.each([
      ["different lane",{lane:"other"}],
      ["different workspace",{workspace:"/other"}],
      ["different task",{taskBinding:"other-task"}],
      ["different source revision",{auth:{...fragmentAuth,sourceBindings:[{path:file,sha:shaOfText("changed")}]}}],
      ["current row clipped to a subset",{current:{range:"4-4"}}],
    ] as const)("keeps the full batch on %s",(_label,opts)=>{
      expect(run(fragments,opts).entries[0]).toHaveProperty("content",fragmentA+fragmentB);
    });

    it.each([
      ["fragment handle lane",{fragmentA:{lane:"other"}}],
      ["fragment handle workspace",{fragmentB:{workspaceRoot:"/other"}}],
    ] as const)("keeps the full batch on a mismatched %s",(_label,opts)=>{
      expect(run(fragments,opts).entries[0]).toHaveProperty("content",fragmentA+fragmentB);
    });

    it("accepts finalized fragment handles whose hash covers a wider range",()=>{
      const widerBody="gamma\n"+fragmentA+fragmentB;
      const widerHash=shaOfText(widerBody);
      const result=run(fragments,{fragmentA:{range:"3-5",sha:widerHash},fragmentB:{range:"3-5",sha:widerHash}});
      expect(result.entries[0]).toMatchObject({form:"file-downgraded",code_unchanged:true});
      expect(result.entries[0]).not.toHaveProperty("content");
    });

    it("rejects a fragment with the right line text but a conflicting internal separator",()=>{
      const wrongSeparator="delta".repeat(45)+"\r\n";
      const capsules=[{...fragments[0],capsule:Object.freeze({...fragments[0]!.capsule,body:wrongSeparator})},fragments[1]];
      expect(run(capsules,{fragmentA:{sha:shaOfText(wrongSeparator)}}).entries[0]).toHaveProperty("content",fragmentA+fragmentB);
    });

    it("rejects different source bytes even when that fragment handle hashes its own body",()=>{
      const wrongBody="changed".repeat(45)+"\n";
      const capsules=[fragments[0],{...fragments[1],capsule:Object.freeze({...fragments[1]!.capsule,body:wrongBody})}];
      expect(run(capsules,{fragmentB:{sha:shaOfText(wrongBody)}}).entries[0]).toHaveProperty("content",fragmentA+fragmentB);
    });

    it.each([
      ["source without terminal newline", "alpha\nbeta\ngamma\n"+"delta".repeat(45)+"\n"+"epsilon".repeat(45), "delta".repeat(45)+"\n", "epsilon".repeat(45)],
      ["source with terminal LF", "alpha\nbeta\ngamma\n"+"delta".repeat(45)+"\n"+"epsilon".repeat(45)+"\n", "delta".repeat(45)+"\n", "epsilon".repeat(45)+"\n"],
      ["source with CRLF", "alpha\r\nbeta\r\ngamma\r\n"+"delta".repeat(45)+"\r\n"+"epsilon".repeat(45)+"\r\n", "delta".repeat(45)+"\r\n", "epsilon".repeat(45)+"\r\n"],
    ] as const)("accepts exact fragment bytes for %s",(_label,actualSource,lineFour,lineFive)=>{
      const actualSha=shaOfText(actualSource);
      const actualRangeBody=lineFour+lineFive;
      const auth:ReadCallReplayAuthorization={...fragmentAuth,sourceBindings:[{path:file,sha:actualSha}]};
      const body={...fragmentBody,entries:[{...fragmentBody.entries[0],content:actualRangeBody,
        sha:"sha256:"+shaOfText(actualRangeBody).slice(7,19)}]};
      const caps:FinalSourceCapsule[]=[
        {taskBinding:"task-binding",capsule:Object.freeze({path:file,sha:actualSha,handle:"fragment-a",startLine:4,endLine:4,body:lineFour})},
        {taskBinding:"task-binding",capsule:Object.freeze({path:file,sha:actualSha,handle:"fragment-b",startLine:5,endLine:5,body:lineFive})},
      ];
      const table=new Map<string,HandleEntry>([["h-current",handle("h-current",{range:"4-5",sha:shaOfText(actualRangeBody)})],
        ["fragment-a",handle("fragment-a",{range:"4-4",sha:shaOfText(lineFour)})],
        ["fragment-b",handle("fragment-b",{range:"5-5",sha:shaOfText(lineFive)})]]);
      const result=projectAuthenticatedReadBatchReplay(body,auth,caps,"task-binding",workspace,lane,id=>table.get(id)) as typeof body;
      expect(result.entries[0]).toMatchObject({form:"file-downgraded",code_unchanged:true});
      expect(result.entries[0]).not.toHaveProperty("content");
    });
  });
});
