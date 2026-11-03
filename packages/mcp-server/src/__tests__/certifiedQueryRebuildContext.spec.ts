import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {ServedPackRecord} from '../features/task-pack/engine/packState2.js';
import type {TaskPackArgs} from '../features/task-pack/model.js';
import type {WorkspaceSession} from '../state/session.js';
import {rmDirWithRetry} from './helpers/rmDirWithRetry.js';

const query = 'Explain the behavior.';
let root: string;
let session: WorkspaceSession;
let record: ServedPackRecord;
let baseline: Pick<ServedPackRecord,'executionContract'|'fileShas'|'surfaces'|'taskBinding'|'lane'|'queryIdentity'>;
let fence: WorkspaceSession['executionFence'];
let binding: string;
let certificateId: string;
let api: typeof import('../features/task-pack/engine/receiptRestoration2.js');
let progress: typeof import('../features/task-pack/engine/receiptProgress3.js');
let lanes: typeof import('../util/laneKey.js');
const previousRoot = process.env['TOKENLIGHTEN_ROOT'];
const args = (overrides: Partial<TaskPackArgs> = {}): TaskPackArgs => ({query,taskBinding:binding,taskProfile:'answer',...overrides});
const context = (overrides: Partial<TaskPackArgs> = {}) => api.certifiedQueryRebuildContext(root,args(overrides));
const receipt = (overrides: Partial<TaskPackArgs> = {}) => api.tryServeCertifiedQueryReceipt(root,args(overrides));

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(),'.tl-certified-context-')));
  fs.mkdirSync(path.join(root,'src'));
  fs.writeFileSync(path.join(root,'src/retry.ts'),'export function retry(){return 3;}\n');
  process.env['TOKENLIGHTEN_ROOT'] = root;
  const {callTool} = await import('../server.js');
  const state = await import('../state/session.js');
  const packs = await import('../features/task-pack/engine/packState2.js');
  api = await import('../features/task-pack/engine/receiptRestoration2.js');
  progress = await import('../features/task-pack/engine/receiptProgress3.js');
  lanes = await import('../util/laneKey.js');
  const response = await callTool('tl_read_file',{cwd:root,query,targets:[{path:'src/retry.ts'}],task:{epoch:'new',profile:'answer'}});
  const text = response.content.find(part => part.type === 'text');
  expect(text?.type).toBe('text');
  const body = JSON.parse(text!.type === 'text' ? text!.text : '{}');
  expect(body.decision?.kind).toBe('act.answer');
  session = state.getSession(root);
  fence = session.executionFence;
  if (fence?.phase !== 'prepared') throw new Error('real selected-target call did not prepare a certificate');
  binding = fence.taskFingerprint;
  certificateId = fence.certificateId;
  record = packs.servedPacksByWorkspace.get(lanes.laneScopedKey(root))!.at(-1)!;
  expect(record).toBeDefined();
  expect(record.taskBinding).toBeUndefined();
  baseline = {executionContract:record.executionContract,fileShas:record.fileShas,surfaces:record.surfaces,taskBinding:record.taskBinding,lane:record.lane,queryIdentity:record.queryIdentity};
},30_000);

beforeEach(() => {
  expect(receipt(),'unchanged real capture must be receipt eligible').toBeDefined();
  expect(context(),'unchanged real capture must be rebuild eligible').toBeDefined();
});
afterEach(() => {
  Object.assign(record,baseline);
  if (baseline.taskBinding === undefined) delete record.taskBinding;
  session.executionFence = fence;
  session.revokedCertificateIds.delete(certificateId);
});
afterAll(async () => {
  if (previousRoot === undefined) delete process.env['TOKENLIGHTEN_ROOT'];
  else process.env['TOKENLIGHTEN_ROOT'] = previousRoot;
  if (root) await rmDirWithRetry(root);
});

describe('current certificate context grants fresh rebuilding only',() => {
  it('exposes only the current execution contract, without a cached pack or residency claim',() => {
    expect(Object.keys(context()!)).toEqual(['execution_contract']);
    expect(context()!.execution_contract?.readiness_certificate?.id).toBe(certificateId);
  });
  it('admits the first capture without a binding only under the exact current certificate',() => {
    expect(record.taskBinding).toBeUndefined();
    expect(context()).toBeDefined();
    record.taskBinding = 'conflicting-task';
    expect(context()).toBeUndefined();
    expect(receipt()).toBeUndefined();
  });
  it('lets an omitted profile defer to the captured profile',() => {
    expect(context({taskProfile:undefined})).toBeDefined();
    expect(receipt({taskProfile:undefined})).toBeDefined();
  });
  const changedArgs: Array<[string,Partial<TaskPackArgs>]> = [
    ['changed query',{query:query+' More details.'}],
    ['different task',{taskBinding:'another-task'}],
    ['missing task',{taskBinding:undefined}],
    ['new epoch',{taskEpoch:'new'}],
    ['different explicit profile',{taskProfile:'generic'}],
    ['forced fresh serve',{forceServe:true}],
    ['explicit path',{path:'src/retry.ts'}],
    ['explicit paths',{paths:[{path:'src/retry.ts'}]}],
    ['explicit symbol',{symbol:'retry'}],
    ['language constraint',{lang:'py'}],
    ['surface constraint',{surfaceRoles:['api']}],
  ];
  it.each(changedArgs)('rejects %s',(_name,overrides) => {
    expect(context(overrides)).toBeUndefined();
    expect(receipt(overrides)).toBeUndefined();
  });
  it('rejects a different active lane',() => {
    expect(lanes.runWithSessionLane('other',() => context())).toBeUndefined();
    expect(lanes.runWithSessionLane('other',() => receipt())).toBeUndefined();
  });
  it('rejects a conflicting record lane',() => {
    record.lane = 'other';
    expect(context()).toBeUndefined();
  });
  it('rejects a revoked current certificate',() => {
    session.revokedCertificateIds.add(certificateId);
    expect(context()).toBeUndefined();
    expect(receipt()).toBeUndefined();
  });
  it('rejects an absent prepared fence',() => {
    session.executionFence = undefined;
    expect(context()).toBeUndefined();
  });
  const changedCertificates = ['id','fingerprint','typestate','empty obligations','unproved obligation'] as const;
  it.each(changedCertificates)('rejects certificate %s',kind => {
    const contract = baseline.executionContract!;
    const certificate = contract.readiness_certificate!;
    record.executionContract = {...contract,typestate:{...contract.typestate},readiness_certificate:{...certificate}};
    if (kind === 'id') record.executionContract.readiness_certificate!.id = 'other';
    if (kind === 'fingerprint') record.executionContract.readiness_certificate!.task_fingerprint = 'other';
    if (kind === 'typestate') record.executionContract.typestate = {...contract.typestate,certificate_id:'other'};
    if (kind === 'empty obligations') record.executionContract.readiness_certificate!.obligations = [];
    if (kind === 'unproved obligation') record.executionContract.readiness_certificate!.obligations = certificate.obligations.map((obligation,i) => i === 0 ? {...obligation,status:'uncovered'} : obligation);
    expect(context()).toBeUndefined();
    expect(receipt()).toBeUndefined();
  });
  it('requires captured source hashes',() => {
    record.fileShas = [];
    expect(context()).toBeUndefined();
  });
  it('requires a complete captured inventory',() => {
    record.executionContract = {...baseline.executionContract!,workspace_state:{...baseline.executionContract!.workspace_state!,inventory_complete:false}};
    expect(context()).toBeUndefined();
  });
  it('does not compact a replay with partial surface metadata; fresh-build context remains metadata only',() => {
    record.surfaces = baseline.surfaces.map(surface => ({...surface,content_completeness:'partial'}));
    expect(receipt({taskQueryRefReplay:true})).toBeUndefined();
    expect(Object.keys(context({taskQueryRefReplay:true})!)).toEqual(['execution_contract']);
  });
  it('does not replay an already resident delivery next as a receipt',() => {
    const next = {tool:'tl_read_file' as const,arguments:{cwd:root,targets:[{path:'src/retry.ts',range:record.surfaces[0]!.range}]}};
    record.executionContract = {...baseline.executionContract!,next_call:next};
    // The first real call populated the served-range ledger. Check the shared
    // disposition rather than assuming this stored continuation is spent.
    expect(progress.receiptContinuationDisposition(root,record,{lane:lanes.currentSessionLane(),taskBinding:binding},next).state).toBe('spent');
    expect(receipt()).toBeUndefined();
    expect(Object.keys(context()!)).toEqual(['execution_contract']);
  });
  it('rejects an added unserved source file, and accepts the restored inventory',() => {
    const extra = path.join(root,'src/unserved.ts');
    try {
      fs.writeFileSync(extra,'export const added = 42;\n');
      expect(context()).toBeUndefined();
      expect(receipt()).toBeUndefined();
    } finally { fs.unlinkSync(extra); }
    expect(context()).toBeDefined();
  });
  it('rejects changed captured source bytes',() => {
    fs.writeFileSync(path.join(root,'src/retry.ts'),'export function retry(){return 4;}\n');
    expect(context()).toBeUndefined();
    expect(receipt()).toBeUndefined();
  });
});
