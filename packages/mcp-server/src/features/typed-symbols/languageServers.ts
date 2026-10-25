import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { LanguageServerCommand } from './common.js';

export const TYPED_SYMBOL_LANGUAGES = ['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'cpp', 'c', 'csharp', 'kotlin', 'php', 'ruby'] as const;
const EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyi': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hh': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp',
  '.cs': 'csharp', '.kt': 'kotlin', '.kts': 'kotlin', '.php': 'php', '.rb': 'ruby', '.rbs': 'ruby',
};
/** Server binaries are external user installations; TokenLighten never distributes them. */
export const LANGUAGE_SERVER_CANDIDATES: Readonly<Record<string, readonly LanguageServerCommand[]>> = {
  python: [{ command: 'basedpyright-langserver', args: ['--stdio'] }, { command: 'pyright-langserver', args: ['--stdio'] }],
  go: [{ command: 'gopls', args: ['serve'] }],
  rust: [{ command: 'rust-analyzer' }],
  java: [{ command: 'jdtls' }],
  c: [{ command: 'clangd' }], cpp: [{ command: 'clangd' }],
  csharp: [{ command: 'csharp-ls' }],
  kotlin: [{ command: 'kotlin-language-server' }],
  php: [{ command: 'intelephense', args: ['--stdio'] }],
  ruby: [{ command: 'ruby-lsp' }, { command: 'solargraph', args: ['stdio'] }],
};
export function typedSymbolLanguage(file: string): string { return EXTENSIONS[path.extname(file).toLowerCase()] ?? 'unsupported'; }

export async function discoverLanguageServer(language: string): Promise<LanguageServerCommand | undefined> {
  for (const candidate of LANGUAGE_SERVER_CANDIDATES[language] ?? []) {
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!directory || !path.isAbsolute(directory)) continue;
      for (const suffix of process.platform === 'win32' ? ['.exe', ''] : ['']) {
        const command = path.join(directory, candidate.command + suffix);
        try {
          if (!(await stat(command)).isFile()) continue;
          await access(command, constants.X_OK);
          return { ...candidate, command };
        } catch { /* Try the next existing executable. */ }
      }
    }
  }
  return undefined;
}
