import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const source = resolve(root, "THIRD_PARTY_NOTICES.md");
const destination = resolve(root, "packages/vscode-extension/THIRD_PARTY_NOTICES.md");
if (!existsSync(source)) throw new Error("THIRD_PARTY_NOTICES.md is missing");
copyFileSync(source, destination);
