import {describe, expect, it} from "vitest";
import {
  attachAuxiliaryEnumContexts, auxiliaryEnumPool, carryAuxiliaryEnumPool, captureAuxiliaryEnumCandidate,
  isAuxiliaryEnumSurface, primaryEnumContextRows, publishAuxiliaryEnumPool,
  restoreAuxiliaryEnumPool, shedAuxiliaryEnumContexts, type AuxiliaryEnumPool,
} from "../features/task-pack/auxiliaryEnumContextIntegration.js";

const source = (name = "Priority") => `import {${name}} from "./domain";\n\nexport const choices = Object.values(${name});`;
const pool = (paths = ["ui/a.ts"]): AuxiliaryEnumPool => ({workspace: "/repo", query: "Add CRITICAL to Priority",
  candidates: paths.map((path, rank) => ({path, rank})), subjects: ["Priority"], primaryPaths: ["domain.ts"],
});
const active = () => ({ref: "q-1", query: pool().query, taskBinding: "task-1", taskHandle: "signed-1"});
const seeded = () => {const carrier = {}; carryAuxiliaryEnumPool(carrier, pool()); return carrier;};
function setup(paths = ["ui/a.ts"]) {
  const primary = [{path: "domain.ts", handle: "primary", range: "1-4", code: "unchanged primary"}];
  const sources = new Map(paths.map(path => [path, source()]));
  const minted: string[] = [];
  return {primary, sources, minted, options: {
    pool: pool(paths), primary,
    read: (path: string) => sources.get(path),
    held: () => false,
    fits: () => true,
    mint: (path: string, range: string) => {minted.push(`${path}:${range}`);return `h${String(minted.length).padStart(10, "0")}`;},
  }};
}

describe("auxiliary enum candidate ownership", () => {
  it("keeps a private bounded carrier through spread, not JSON", () => {
    const carrier = {};
    carryAuxiliaryEnumPool(carrier, {...pool(), candidates: Array.from({length: 40}, (_,rank) => ({path:`p${rank}.ts`,rank})),
      subjects: ["Priority", "Priority", "bad-name"], primaryPaths: ["domain.ts", "../escape"]});
    const value = auxiliaryEnumPool({...carrier})!;
    expect(value.candidates).toHaveLength(24); expect(value.subjects).toEqual(["Priority"]);
    expect(value.primaryPaths).toEqual(["domain.ts"]); expect(JSON.stringify(carrier)).toBe("{}");
    expect(auxiliaryEnumPool(JSON.parse(JSON.stringify(carrier)))).toBeUndefined();
  });
  it("publishes only after matching qref, task binding, handle, workspace and query", () => {
    for (const changed of [{ref:"wrong"}, {taskBinding:"wrong"}, {taskHandle:"wrong"}, {query:"unrelated"}]) {
      const state = {...active(), ...changed};
      publishAuxiliaryEnumPool(seeded(), state, "/repo", "q-1", "task-1", "signed-1");
      expect(restoreAuxiliaryEnumPool(state, "/repo", pool().query, "task-1", true)).toBeUndefined();
    }
  });
  it("restores the same authenticated continuation without state-store writes", () => {
    const state = active(); publishAuxiliaryEnumPool(seeded(), state, "/repo", "q-1", "task-1", "signed-1");
    expect(restoreAuxiliaryEnumPool({...state}, "/repo", pool().query, "task-1", true)).toEqual(pool());
    expect(restoreAuxiliaryEnumPool(state, "/other", pool().query, "task-1", true)).toBeUndefined();
    expect(restoreAuxiliaryEnumPool(state, "/repo", pool().query, "other-task", true)).toBeUndefined();
    expect(restoreAuxiliaryEnumPool(state, "/repo", pool().query, "task-1", false)).toBeUndefined();
  });
  it("does not transfer to another lane object or a restart/epoch-reset object", () => {
    const state = active(); publishAuxiliaryEnumPool(seeded(), state, "/repo", "q-1", "task-1", "signed-1");
    expect(restoreAuxiliaryEnumPool(active(), "/repo", pool().query, "task-1", true)).toBeUndefined();
    expect(restoreAuxiliaryEnumPool(JSON.parse(JSON.stringify(state)), "/repo", pool().query, "task-1", true)).toBeUndefined();
  });
  it("fails closed if active query fields change after publication", () => {
    for (const changed of [{ref:"other"}, {taskBinding:"other"}, {taskHandle:"other"}, {query:"other"}]) {
      const state = active(); publishAuxiliaryEnumPool(seeded(), state, "/repo", "q-1", "task-1", "signed-1");
      Object.assign(state, changed);
      expect(restoreAuxiliaryEnumPool(state, "/repo", pool().query, "task-1", true)).toBeUndefined();
    }
  });
});

describe("bounded auxiliary attachment", () => {
  it("keeps primary rows byte-identical and returns marked readonly import/use windows", async () => {
    const fixture = setup(); const before = JSON.stringify(fixture.primary);
    const rows = await attachAuxiliaryEnumContexts(fixture.options);
    expect(rows.map(row => row.range)).toEqual(["1-1", "3-3"]);
    expect(rows.every(row => row.required === false && isAuxiliaryEnumSurface(row))).toBe(true);
    expect(rows[0]!.why).toContain("L3-3: Object.values(Priority) reads current runtime enum members here");
    expect(Buffer.byteLength(rows[0]!.why!, "utf8")).toBeLessThanOrEqual(200);
    expect(primaryEnumContextRows([...fixture.primary, ...rows])).toEqual(fixture.primary);
    expect(JSON.stringify(fixture.primary)).toBe(before);
    expect(isAuxiliaryEnumSurface({...rows[0]})).toBe(true);
    expect(isAuxiliaryEnumSurface(JSON.parse(JSON.stringify(rows[0])))).toBe(false);
  });
  it("anchors the aid to the accessor when it falls in the latter half of a split use context", async () => {
    const fixture=setup();
    fixture.sources.set("ui/a.ts", `import {Priority} from "./domain";\nexport function choices() {\n  if (true) {\n    const a = 1;\n    const b = 2;\n    const c = 3;\n    const d = 4;\n    const e = 5;\n    const f = 6;\n    const g = 7;\n    const h = 8;\n    return Object.values(Priority);\n  }\n}`);
    const rows=await attachAuxiliaryEnumContexts(fixture.options);
    expect(rows.map(row=>row.range)).toEqual(["1-1","3-10","11-13"]);
    expect(rows[0]!.why).toContain("L12-12: Object.values(Priority)");
    expect(rows[0]!.why).not.toContain("L3-10:");
    expect(rows.slice(1).map(row=>row.code).join("\n")).toContain("return Object.values(Priority);");
    expect(rows).toHaveLength(3);
  });
  it("marks placeholder rows before preview and mints only after the whole file fits", async () => {
    const fixture = setup(); let previews = 0;
    const rows = await attachAuxiliaryEnumContexts({...fixture.options, fits: all => {
      const added = all.slice(1); previews++;
      expect(added.every(isAuxiliaryEnumSurface)).toBe(true);
      const firstAdded=added[0];
      if(firstAdded===undefined||!("why" in firstAdded)||firstAdded.why===undefined)
        throw new Error("expected the import context to carry its bounded why");
      expect(firstAdded.why).toContain("Object.values(Priority)");
      expect(Buffer.byteLength(firstAdded.why, "utf8")).toBeLessThanOrEqual(200);
      if (previews === 1) {expect(fixture.minted).toEqual([]);expect(added.every(row => row.handle === "h0000000000")).toBe(true);}
      return true;
    }});
    expect(rows).toHaveLength(2); expect(previews).toBe(2);
  });
  it("falls back to the short why when its byte threshold fits the generic complete bundle", async () => {
    const fixture=setup(); let threshold: number | undefined; let positiveRejected=false;
    const generic="Read-only import/use context; not a whole-file no-change proof.";
    const rows=await attachAuxiliaryEnumContexts({...fixture.options,fits:all=>{
      const bytes=Buffer.byteLength(JSON.stringify(all),"utf8");
      const added=all.filter(isAuxiliaryEnumSurface);
      if(added[0] !== undefined && "why" in added[0] && added[0].why?.startsWith("L")){
        const short=all.map(row=>isAuxiliaryEnumSurface(row)&&"why" in row&&row.why!==undefined?{...row,why:generic}:row);
        threshold=Buffer.byteLength(JSON.stringify(short),"utf8");
        positiveRejected=bytes>threshold;
        return bytes<=threshold;
      }
      return threshold!==undefined&&bytes<=threshold;
    }});
    expect(positiveRejected).toBe(true); expect(rows).toHaveLength(2);
    expect(rows[0]!.why).toBe(generic); expect(fixture.minted).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify([...fixture.primary,...rows]),"utf8")).toBeLessThanOrEqual(threshold!);
  });
  it("retries the generic why when real minted handles make the positive aid exceed the cap", async () => {
    const fixture=setup(); const generic="Read-only import/use context; not a whole-file no-change proof.";
    const longHandle=`h${"x".repeat(100)}`;
    let previewPositiveFits=false, realPositiveRejected=false;
    const fits=(all:readonly (typeof fixture.primary[number] | import("../features/task-pack/auxiliaryEnumContextIntegration.js").AuxiliaryContextSurface)[])=>{
      const bytes=Buffer.byteLength(JSON.stringify(all),"utf8");
      const finalShort=all.map(row=>isAuxiliaryEnumSurface(row)
        ?{...row,handle:longHandle,...("why" in row&&row.why!==undefined?{why:generic}:{})}:row);
      const cap=Buffer.byteLength(JSON.stringify(finalShort),"utf8");
      const first=all.find(isAuxiliaryEnumSurface);
      if(first!==undefined&&"why" in first&&first.why?.startsWith("L")&&first.handle==="h0000000000"&&bytes<=cap)previewPositiveFits=true;
      if(first!==undefined&&"why" in first&&first.why?.startsWith("L")&&first.handle===longHandle&&bytes>cap)realPositiveRejected=true;
      return bytes<=cap;
    };
    const rows=await attachAuxiliaryEnumContexts({...fixture.options,fits,mint:()=>longHandle});
    expect(previewPositiveFits,"placeholder fit should accept the positive note before real handles").toBe(true);
    expect(realPositiveRejected,"post-mint positive note should exceed the exact generic-byte cap").toBe(true);
    expect(rows).toHaveLength(2);expect(rows[0]!.why).toBe(generic);
    expect(rows.every(row=>row.handle===longHandle)).toBe(true);
  });
  it("never drops primary content or mints when a whole bundle cannot fit", async () => {
    const fixture = setup();
    expect(await attachAuxiliaryEnumContexts({...fixture.options, fits: () => false})).toEqual([]);
    expect(fixture.minted).toEqual([]);expect(fixture.primary[0]!.code).toBe("unchanged primary");
  });
  it("does not attach only the import half when the complete import/use bundle cannot fit", async () => {
    const fixture=setup();
    const rows=await attachAuxiliaryEnumContexts({...fixture.options,
      fits:all=>all.filter(isAuxiliaryEnumSurface).length<2});
    expect(rows).toEqual([]);expect(fixture.minted).toEqual([]);
  });
  it("continues to a later smaller bundle when the first cannot fit", async () => {
    const fixture = setup(["large.ts", "small.ts"]);
    fixture.sources.set("large.ts", `import {Priority} from "./domain";\nexport const veryLongDescriptiveConsumerName = Object.values(Priority).map(value => value);`);
    const rows = await attachAuxiliaryEnumContexts({...fixture.options,
      fits: all => !all.some(row => row.path === "large.ts"),
    });
    expect(new Set(rows.map(row => row.path))).toEqual(new Set(["small.ts"]));
  });
  it("does not turn four selected paths into eight on a second page", async () => {
    const fixture = setup(Array.from({length:8},(_,i)=>`ui/${i}.ts`));
    const first = await attachAuxiliaryEnumContexts(fixture.options);
    expect(new Set(first.map(row => row.path)).size).toBe(4);
    const second = await attachAuxiliaryEnumContexts({...fixture.options, held: () => true});
    expect(second).toEqual([]);
  });
  it("two spare-capacity responses can deliver four import/use bundles without primary re-reads", async () => {
    const fixture = setup(["a.ts", "b.ts", "c.ts", "d.ts"]);
    const fitTwoPaths = (all: readonly {path:string}[]) => new Set(all.slice(1).map(row => row.path)).size <= 2;
    const first = await attachAuxiliaryEnumContexts({...fixture.options, fits: fitTwoPaths});
    const held = new Set(first.map(row=>`${row.path}:${row.range}`));
    const second = await attachAuxiliaryEnumContexts({...fixture.options, fits: fitTwoPaths,
      held: (plan,start,end) => held.has(`${plan.path}:${start}-${end}`),
    });
    expect(new Set([...first,...second].map(row=>row.path)).size).toBe(4);
    expect(second.some(row=>held.has(`${row.path}:${row.range}`))).toBe(false);
    expect(fixture.primary).toHaveLength(1);
  });
  it("requires every window held and permits force_serve", async () => {
    const fixture = setup();
    expect(await attachAuxiliaryEnumContexts({...fixture.options, held:()=>true})).toEqual([]);
    expect(await attachAuxiliaryEnumContexts({...fixture.options, held:()=>true, forceServe:true})).toHaveLength(2);
    expect(await attachAuxiliaryEnumContexts({...fixture.options, held:(_plan,start)=>start===1})).toHaveLength(2);
  });
  it("revalidates full source SHA after the async parse before mint", async () => {
    const fixture = setup();let reads = 0;
    const rows = await attachAuxiliaryEnumContexts({...fixture.options, read: path => {
      reads++;return reads===1 ? fixture.sources.get(path) : source()+"\n// changed";
    }});
    expect(rows).toEqual([]);expect(fixture.minted).toEqual([]);
  });
  it("excludes original primary paths even if no longer on this page", async () => {
    const fixture = setup(["domain.ts"]);
    expect(await attachAuxiliaryEnumContexts(fixture.options)).toEqual([]);
  });
  it("labels type-only import context without certifying correctness", async () => {
    const fixture=setup();fixture.sources.set("ui/a.ts",source().replace("import {", "import type {"));
    const rows=await attachAuxiliaryEnumContexts(fixture.options);
    expect(rows[0]!.why).toContain("type-only import used at runtime");
  });
  it("describes a validated alias with its original enum subject", async () => {
    const fixture=setup();fixture.sources.set("ui/a.ts",source().replace("Priority}","Priority as Severity}")
      .replace("Object.values(Priority)","Object.values(Severity)"));
    const rows=await attachAuxiliaryEnumContexts(fixture.options);
    expect(rows[0]!.why).toContain("Object.values(Severity) reads current runtime enum members for Priority here");
    expect(Buffer.byteLength(rows[0]!.why!,"utf8")).toBeLessThanOrEqual(200);
  });
  it("keeps a valid bundle when a long alias makes the positive aid too large", async () => {
    const fixture=setup();
    const alias=`Severity${"A".repeat(240)}`;
    fixture.sources.set("ui/a.ts",`import {Priority as ${alias}} from "./domain";\n\nexport const choices = Object.values(${alias});`);
    const rows=await attachAuxiliaryEnumContexts(fixture.options);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.why).toBe("Read-only import/use context; not a whole-file no-change proof.");
    expect(Buffer.byteLength(rows[0]!.why!,"utf8")).toBeLessThanOrEqual(200);
  });
  it("abstains for shadowed imports and accessors of a different enum", async () => {
    const fixture=setup();
    fixture.sources.set("ui/a.ts",`import {Priority} from "./domain";\nexport function choices(Priority: Record<string, string>) { return Object.values(Priority); }`);
    expect(await attachAuxiliaryEnumContexts(fixture.options)).toEqual([]);
    fixture.sources.set("ui/a.ts",`import {Priority} from "./domain";\nexport const choices = Object.values(Other);`);
    expect(await attachAuxiliaryEnumContexts(fixture.options)).toEqual([]);
  });
  it("sheds entire auxiliary file bundles before any primary row", async () => {
    const fixture=setup(["a.ts","b.ts"]);const added=await attachAuxiliaryEnumContexts(fixture.options);
    const rows=[...fixture.primary,...added];
    shedAuxiliaryEnumContexts(rows,()=>rows.length<=3);
    expect(rows[0]).toBe(fixture.primary[0]);expect(rows.filter(isAuxiliaryEnumSurface)).toHaveLength(2);
    expect(new Set(rows.slice(1).map(row=>row.path))).toEqual(new Set(["a.ts"]));
    shedAuxiliaryEnumContexts(rows,()=>false);expect(rows).toEqual(fixture.primary);
  });
});


describe("reuse of already-read enum candidates", () => {
  it("extends a tiny query-token pool with exact enum-name hits without changing primary paths", () => {
    const cache = {}; carryAuxiliaryEnumPool(cache, {...pool(["ui/Badge.ts"]), subjects: []});
    captureAuxiliaryEnumCandidate(cache, "/repo", pool().query, "ui/Form.ts", ["Priority"]);
    captureAuxiliaryEnumCandidate(cache, "/repo", pool().query, "ui/Filters.ts", ["Priority"]);
    const result = auxiliaryEnumPool(cache)!;
    expect(result.candidates.map(candidate=>candidate.path)).toEqual(["ui/Badge.ts","ui/Form.ts","ui/Filters.ts"]);
    expect(result.subjects).toEqual(["Priority"]);expect(result.primaryPaths).toEqual(["domain.ts"]);
  });
  it("does not create a carrier in an unrelated scan or another query/workspace", () => {
    const empty = {};captureAuxiliaryEnumCandidate(empty,"/repo",pool().query,"a.ts",["Priority"]);
    expect(auxiliaryEnumPool(empty)).toBeUndefined();
    const cache=seeded();
    captureAuxiliaryEnumCandidate(cache,"/other",pool().query,"b.ts",["Priority"]);
    captureAuxiliaryEnumCandidate(cache,"/repo","another query","c.ts",["Priority"]);
    expect(auxiliaryEnumPool(cache)!.candidates).toHaveLength(1);
  });
  it("preserves directory boundaries and a union of original scopes", () => {
    const cache={};carryAuxiliaryEnumPool(cache,{...pool([]),scopes:["app/ui","shared/enum.ts"]});
    for(const path of ["app/ui/Form.ts","app/ui2/Bad.ts","app/api/Bad.ts","shared/enum.ts","shared/other.ts"])
      captureAuxiliaryEnumCandidate(cache,"/repo",pool().query,path,["Priority"]);
    expect(auxiliaryEnumPool(cache)!.candidates.map(row=>row.path)).toEqual(["app/ui/Form.ts","shared/enum.ts"]);
    expect(auxiliaryEnumPool({...cache})!.scopes).toEqual(["app/ui","shared/enum.ts"]);
  });
  it("never broadens a malformed retained scope into workspace scope", () => {
    const cache={};carryAuxiliaryEnumPool(cache,{...pool([]),scopes:["../outside"]});
    captureAuxiliaryEnumCandidate(cache,"/repo",pool().query,"ui/Form.ts",["Priority"]);
    expect(auxiliaryEnumPool(cache)!.candidates).toEqual([]);
  });
  it("deduplicates stable ranks and keeps the 24-candidate cap", () => {
    const cache={};carryAuxiliaryEnumPool(cache,pool([]));
    for(let i=0;i<30;i++)captureAuxiliaryEnumCandidate(cache,"/repo",pool().query,`ui/${i}.ts`,["Priority"]);
    captureAuxiliaryEnumCandidate(cache,"/repo",pool().query,"ui/0.ts",["Priority"]);
    const result=auxiliaryEnumPool(cache)!;
    expect(result.candidates).toHaveLength(24);expect(result.candidates.map(row=>row.rank)).toEqual(Array.from({length:24},(_,i)=>i));
  });
  it("carries discovered subjects and candidates through authenticated continuation", () => {
    const cache={};carryAuxiliaryEnumPool(cache,{...pool([]),subjects:[],scopes:["ui"]});
    captureAuxiliaryEnumCandidate(cache,"/repo",pool().query,"ui/Form.ts",["Priority"]);
    const state=active();publishAuxiliaryEnumPool(cache,state,"/repo","q-1","task-1","signed-1");
    const restored=restoreAuxiliaryEnumPool(state,"/repo",pool().query,"task-1",true)!;
    expect(restored.subjects).toEqual(["Priority"]);expect(restored.candidates).toEqual([{path:"ui/Form.ts",rank:0}]);
    expect(restored.scopes).toEqual(["ui"]);
  });
});
