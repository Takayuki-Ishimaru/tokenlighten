import {afterEach, describe, expect, it, vi} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {TaskPackResult} from "../features/task-pack/model.js";
import {attachAuxiliaryEnumContexts, isAuxiliaryEnumSurface} from "../features/task-pack/auxiliaryEnumContextIntegration.js";
import {auxiliaryEnumAttachmentSizePreview} from "../protocol/auxiliaryEnumAttachmentSizePreview.js";
import {handleTable} from "../util/handles.js";
import {protocolCallContext, runWithProtocolCall} from "../protocol/envelope.js";
import {laneTaskProfile} from "../state/laneTaskHandles.js";
import {mintedRangedContinuationWindows, runWithSessionLane} from "../state/session.js";

const roots: string[] = [];
afterEach(() => {vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});});
async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-aux-preview-"))); roots.push(root);
  const main = "export const x = 1;", consumer = "import {Priority} from './priority';\nconst choices = Object.values(Priority);";
  fs.writeFileSync(path.join(root, "a.ts"), main); fs.writeFileSync(path.join(root, "b.ts"), consumer);
  const handle = handleTable.upsert({kind:"range", path:"a.ts", range:"1-1", workspaceRoot:root}).id;
  const primary = [{handle, path:"a.ts", range:"1-1", role:"contract", code:main, required:true}];
  const pack = {task_profile:"change_propagation", coverage:"complete", missing:[], surfaces:primary,
    route:{action:"edit_from_handles",reason:"construction metadata ".repeat(500),max_additional_tl_calls:0},
    change_contract:{version:1,status:"ready",discovery_complete:true,obligations:[],stages:[],missing:[],max_additional_tl_calls:0},
    execution_contract:{version:1,state:"ready",readiness:"ready",discovery_complete:true,next_action:"edit",
      max_additional_discovery_calls:0,reason:"ready",typestate:{phase:"prepared",certificate_id:"ready-unit",
        allowed_actions:["edit"],challenge_required_for:[]},
      readiness_certificate:{id:"ready-unit",obligations:[{id:"surface-content"}],action_frontier:[handle]},
      workspace_state:{fingerprint:"sha256:unit",scope:"served-evidence",evidence_files:1,inventory_files:0,inventory_complete:false}},
  } as unknown as TaskPackResult;
  let placeholders: TaskPackResult["surfaces"] = [];
  const added = await attachAuxiliaryEnumContexts({pool:{workspace:root,query:"extend Priority",subjects:["Priority"],
    candidates:[{path:"b.ts",rank:0}],primaryPaths:["a.ts"]}, primary,
    read: file => file === "b.ts" ? fs.readFileSync(path.join(root, file), "utf8") : undefined,
    held:()=>false, fits: rows => {
      if (rows.some(row => row.handle === "h0000000000")) placeholders = rows.map(row => ({...row})) as TaskPackResult["surfaces"];
      return true;
    }, mint:(file, range) => handleTable.upsert({kind:"range",path:file,range,workspaceRoot:root}).id});
  expect(added).toHaveLength(1);
  return {root, pack:{...pack,surfaces:[...primary,...added]} as TaskPackResult, placeholders, consumer};
}
describe("auxiliary attachment-only canonical size preview", () => {
  it("sizes real and marked-placeholder context without changing primary bytes or lane state", async () => {
    const {root,pack,placeholders} = await fixture();
    const before = JSON.stringify(pack), profile = laneTaskProfile(root, "preview"), upsert = vi.spyOn(handleTable,"upsert");
    runWithSessionLane("preview", () => {
      const context = {tool:"tl_read_file",clientId:"copilot-cli",codecTraceWorkspace:root,args:{cwd:root,lane:"preview"}};
      runWithProtocolCall(context, () => {
        const windows = [...(mintedRangedContinuationWindows(root,"b.ts") ?? [])];
        const bytes = auxiliaryEnumAttachmentSizePreview(pack,"copilot-cli");
        expect(bytes).toBeGreaterThan(512);
        expect(bytes).toBeLessThan(Buffer.byteLength(before));
        expect(auxiliaryEnumAttachmentSizePreview({...pack,surfaces:placeholders},"copilot-cli")).toBeGreaterThan(512);
        expect(mintedRangedContinuationWindows(root,"b.ts") ?? []).toEqual(windows);
        expect(protocolCallContext()).toBe(context);
        expect(context).not.toHaveProperty("sizePreview");
      });
    });
    expect(JSON.stringify(pack)).toBe(before); expect(laneTaskProfile(root,"preview")).toBe(profile);
    expect(upsert).not.toHaveBeenCalled();
  });
  it("fails closed on stale source, invalid handles, or an unmarked placeholder", async () => {
    const {root,pack,placeholders,consumer} = await fixture();
    expect(auxiliaryEnumAttachmentSizePreview(pack,"copilot-cli")).toBeGreaterThan(512);
    const bad = pack.surfaces.map(row => isAuxiliaryEnumSurface(row) ? {...row,handle:"unregistered"} : row);
    expect(auxiliaryEnumAttachmentSizePreview({...pack,surfaces:bad},"copilot-cli")).toBeUndefined();
    const unmarked = JSON.parse(JSON.stringify(placeholders));
    expect(auxiliaryEnumAttachmentSizePreview({...pack,surfaces:unmarked},"copilot-cli")).toBeUndefined();
    fs.writeFileSync(path.join(root,"b.ts"),consumer.replace("choices","changed"));
    expect(auxiliaryEnumAttachmentSizePreview(pack,"copilot-cli")).toBeUndefined();
    fs.writeFileSync(path.join(root,"b.ts"),consumer);
    fs.writeFileSync(path.join(root,"a.ts"),"export const x = 2;");
    expect(auxiliaryEnumAttachmentSizePreview(pack,"copilot-cli")).toBeUndefined();
  });
  it("retains the old accounting outside a complete ordinary compact change pack", async () => {
    const {pack} = await fixture();
    for (const client of [undefined,"claude-code"]) expect(auxiliaryEnumAttachmentSizePreview(pack,client)).toBeUndefined();
    for (const patch of [{task_profile:"answer"},{change_contract:undefined},
      {change_contract:{...pack.change_contract,status:"needs-followup"}},
      {execution_contract:{...pack.execution_contract,typestate:{phase:"discovery"}}}]) {
      expect(auxiliaryEnumAttachmentSizePreview({...pack,...patch} as TaskPackResult,"copilot-cli")).toBeUndefined();
    }
    vi.stubEnv("TL_ANSWER_LINE_GUTTER","1");
    expect(auxiliaryEnumAttachmentSizePreview(pack,"copilot-cli")).toBeUndefined();
    vi.unstubAllEnvs(); vi.stubEnv("TL_SEMANTIC_FRONTIER_GUARD","1");
    expect(auxiliaryEnumAttachmentSizePreview(pack,"copilot-cli")).toBeUndefined();
  });
});
