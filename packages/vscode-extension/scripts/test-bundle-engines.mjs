// Repeatable standalone distribution check. Set TL_SEMANTIC_MODEL_TEST_CACHE
// to an already installed model cache to additionally verify native + local
// WASM inference; this script never downloads a model or changes real config.
// TL_SEMANTIC_NATIVE_RUNTIME_TEST=1 selects the optional native bundle variant.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { bundleCli } from "./bundle-cli.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = mkdtempSync(join(tmpdir(), "tl-bundle-engines-"));
const outDir = join(scratch, "bundle");
const configuredCache = process.env.TL_SEMANTIC_MODEL_TEST_CACHE;
const nativeSemanticRuntime = process.env.TL_SEMANTIC_NATIVE_RUNTIME_TEST === "1";
const cacheDir = configuredCache ? resolve(configuredCache) : join(scratch, "missing-model");
const environment = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", TOKENLIGHTEN_ENGINES_FILE: join(scratch, "engines.json") };

function run(args, input = undefined) {
  const result = spawnSync(process.execPath, args, { cwd: scratch, env: environment, encoding: "utf8", input, timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error ?? "child failed"));
  return result.stdout;
}

function inventory(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) inventory(path, files);
    else files.push({ path, bytes: statSync(path).size });
  }
  return files;
}

const runtimeCheck = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const require = createRequire(${JSON.stringify(join(outDir, "tl-cli.js"))});
const semanticNamespace = await import(pathToFileURL(require.resolve("@tokenlighten/mcp-server/semantic-search")).href);
const semantic = semanticNamespace.default ?? semanticNamespace;
const typed = require("@tokenlighten/mcp-server/typed-symbols");
const config = require("@tokenlighten/mcp-server/engines");
assert.equal(typeof config.readEngineConfiguration, "function");
assert.equal(require.resolve("@tokenlighten/mcp-server/package.json").startsWith(require("node:fs").realpathSync(${JSON.stringify(outDir)})), true);
for (const dependency of ["typescript", "@huggingface/transformers", "onnxruntime-web", ...(${nativeSemanticRuntime} ? ["onnxruntime-node"] : [])]) {
  assert.equal(require.resolve(dependency).startsWith(require("node:fs").realpathSync(${JSON.stringify(outDir)})), true, dependency + " escaped bundled runtime");
}
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("network forbidden in bundled smoke"); };
const runtime = await import(pathToFileURL(require.resolve("@huggingface/transformers")).href);
assert.equal(typeof runtime.AutoModel.from_pretrained, "function");
assert.equal(typeof runtime.AutoTokenizer.from_pretrained, "function");
const state = await semantic.readSemanticModelStatus({ cacheDir: ${JSON.stringify(cacheDir)} });
const engine = new semantic.LocalSemanticSearch({ cacheDir: ${JSON.stringify(cacheDir)}, timeoutMs: 120000 });
const ranked = await engine.search({ query: "通信に失敗したときの再試行", sources: [
  { path: "retry.ts", text: "Retry failed network requests with exponential backoff." },
  { path: "ui.ts", text: "Render a blue button with a red border." }
] });
if (${Boolean(configuredCache)}) {
  assert.equal(state.status, "ready");
  assert.equal(ranked.status, "available");
  assert.equal(ranked.candidates[0].path, "retry.ts");
} else {
  assert.equal(state.status, "missing");
  assert.equal(ranked.status, "unavailable");
}
await engine.dispose();
await writeFile(${JSON.stringify(join(scratch, "workspace", "policy.ts"))}, ${JSON.stringify("export class RetryPolicy { run() { return 1; } }\n")});
await writeFile(${JSON.stringify(join(scratch, "workspace", "main.ts"))}, ${JSON.stringify('import { RetryPolicy } from "./policy";\nconst policy = new RetryPolicy();\npolicy.run();\n')});
const result = await typed.resolveTypedSymbols({ root: ${JSON.stringify(join(scratch, "workspace"))}, path: "main.ts",
  position: { line: 2, character: 8 }, relations: ["definition"], timeoutMs: 15000 });
assert.equal(result.backend, "typescript");
assert.equal(result.status, "resolved");
assert.equal(result.locations[0].path, "policy.ts");
assert.equal(networkCalls, 0);
console.log(JSON.stringify({ model: state.status, semantic: ranked.status, typed: result.status, networkCalls }));
`;

try {
  await bundleCli({ outDir, nativeSemanticRuntime });
  mkdirSync(join(scratch, "workspace"));
  writeFileSync(environment.TOKENLIGHTEN_ENGINES_FILE, JSON.stringify({ version: 1, semanticSearch: { enabled: false, cacheDir } }));
  assert.equal(readFileSync(join(outDir, "MODEL_LICENSES.json"), "utf8"), readFileSync(join(repoRoot, "MODEL_LICENSES.json"), "utf8"));
  assert.equal(readFileSync(join(outDir, "node_modules/@huggingface/transformers/LICENSE"), "utf8"), readFileSync(join(repoRoot, "node_modules/@huggingface/transformers/LICENSE"), "utf8"));
  assert.match(readFileSync(join(outDir, "node_modules/@huggingface/transformers/MODIFICATIONS.txt"), "utf8"), /text-only/);
  assert.match(readFileSync(join(outDir, "node_modules/@huggingface/transformers/dist/transformers.node.mjs"), "utf8"), /^\/\* Modified by TokenLighten:/);
  assert.equal(existsSync(join(outDir, "node_modules/typescript/lib/lib.esnext.d.ts")), true);
  const files = inventory(outDir);
  for (const packageRoot of [join(outDir, "node_modules/onnxruntime-web"), join(outDir, "node_modules/onnxruntime-web/node_modules/onnxruntime-common"),
    ...(nativeSemanticRuntime ? [join(outDir, "node_modules/onnxruntime-node"), join(outDir, "node_modules/onnxruntime-common")] : [])]) {
    assert.match(readFileSync(join(packageRoot, "LICENSE"), "utf8"), /Permission is hereby granted, free of charge/);
    assert.equal(existsSync(join(packageRoot, "TOKENLIGHTEN_LEGAL_PROVENANCE.json")), true);
    if (!packageRoot.endsWith("onnxruntime-common")) assert.match(readFileSync(join(packageRoot, "ThirdPartyNotices.txt"), "utf8"), /THIRD PARTY SOFTWARE NOTICES AND INFORMATION/);
  }
  assert.equal(files.some(file => /(?:^|[/\\])(?:sharp|@img)(?:[/\\]|$)/.test(file.path)), false, "image native runtime leaked into archive");
  assert.equal(files.some(file => /\.(?:onnx|safetensors)$/i.test(file.path)), false, "model weights leaked into archive");
  if (nativeSemanticRuntime) {
    assert.equal(files.some(file => /[/\\]win32[/\\]x64[/\\]onnxruntime_binding\.node$/.test(file.path)), true, "Windows native runtime missing");
    assert.equal(files.some(file => /[/\\]linux[/\\]x64[/\\]onnxruntime_binding\.node$/.test(file.path)), true, "Linux native runtime missing");
  } else {
    assert.equal(existsSync(join(outDir, "node_modules/onnxruntime-node")), false, "native ONNX runtime leaked into portable bundle");
    assert.ok(files.reduce((sum, file) => sum + file.bytes, 0) < 150 * 1024 * 1024, "portable bundle exceeded 150MiB");
  }
  for (const args of [["engines", "status", "--json"], ["models", "list", "--json"], ["models", "licenses", "--json"]]) {
    assert.doesNotThrow(() => JSON.parse(run([join(outDir, "tl-cli.js"), ...args])));
  }
  const selected = JSON.parse(run(["--liftoff-only", "--input-type=module"], runtimeCheck));
  const binding = join(outDir, "node_modules/onnxruntime-node/bin/napi-v6", process.platform, process.arch, "onnxruntime_binding.node");
  const hadNativeBinding = existsSync(binding);
  if (hadNativeBinding) renameSync(binding, `${binding}.hidden-for-test`);
  let wasm;
  try { wasm = JSON.parse(run(["--liftoff-only", "--input-type=module"], runtimeCheck)); }
  finally { if (hadNativeBinding) renameSync(`${binding}.hidden-for-test`, binding); }
  process.stdout.write(`bundle engines integration: ${JSON.stringify({ nativeSemanticRuntime, selected, wasm, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) })}\n`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
