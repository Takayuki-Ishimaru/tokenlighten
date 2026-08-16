import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const source = resolve(root, "THIRD_PARTY_NOTICES.md");
const destination = resolve(root, "packages/vscode-extension/THIRD_PARTY_NOTICES.md");
if (!existsSync(source) || !existsSync(destination)) {
  throw new Error("root or VS Code third-party notices file is missing");
}
if (!readFileSync(source).equals(readFileSync(destination))) {
  throw new Error("packages/vscode-extension/THIRD_PARTY_NOTICES.md is out of sync");
}
