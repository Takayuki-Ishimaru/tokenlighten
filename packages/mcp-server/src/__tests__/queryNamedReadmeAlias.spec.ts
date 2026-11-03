import {afterEach, describe, expect, it} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {queryNamedWorkspaceFiles} from '../features/task-pack/engine/queryIntent3.js';

const roots: string[] = [];
function workspace(files: string[]): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.tl-readme-alias-')));
  roots.push(root);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});
    fs.writeFileSync(path.join(root,file),'Installation steps\n');
  }
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root,{recursive:true,force:true}); });

describe('explicit README document name', () => {
  it.each(['Explain the installation steps described in the README','Read the readme.','READMEを説明してください'])('resolves the actual unique root document: %s',query => {
    expect(queryNamedWorkspaceFiles(query,workspace(['README.md','nested/README.md']))).toEqual(['README.md']);
  });
  it.each(['Describe the documentation','Read READMEHelper','Read README-old','See https://example.com/README'])('does not infer a document from unrelated prose: %s',query => {
    expect(queryNamedWorkspaceFiles(query,workspace(['README.md']))).toEqual([]);
  });
  it('does not choose among ambiguous root documents or substitute a nested one',() => {
    expect(queryNamedWorkspaceFiles('Read the README',workspace(['README.md','README.txt']))).toEqual([]);
    expect(queryNamedWorkspaceFiles('Read the README',workspace(['nested/README.md']))).toEqual([]);
    expect(queryNamedWorkspaceFiles('Read the README',workspace([]))).toEqual([]);
  });
  it('preserves the exact extension and directory a caller names',() => {
    expect(queryNamedWorkspaceFiles('Read nested/README.txt',workspace(['README.md','nested/README.txt']))).toEqual(['nested/README.txt']);
  });
});
