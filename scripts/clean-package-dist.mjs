import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const packageRoot = resolve(process.cwd());
const distDir = resolve(packageRoot, "dist");

if (basename(distDir) !== "dist" || dirname(distDir) !== packageRoot) {
  throw new Error(`Refusing to clean unexpected path: ${distDir}`);
}

await rm(distDir, { recursive: true, force: true });
