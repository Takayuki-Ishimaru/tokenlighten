#!/usr/bin/env node
// Verify a release archive using its own runtime and an isolated installation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const archive = resolve(process.argv[2] ?? "");
const match = /^tokenlighten-(\d+\.\d+\.\d+)-(win-x64|darwin-arm64|darwin-x64|linux-x64)\.tgz$/.exec(basename(archive));
assert(match, "Usage: node scripts/smoke-install-archive.mjs <release.tgz> [SHA256SUMS]");
const [, version, platform] = match;
// Git Bash's GNU tar treats drive letters as remote hosts. Use Windows bsdtar.
const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
assert.equal(platform, `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`);
const sums = readFileSync(resolve(process.argv[3] ?? join(dirname(archive), "SHA256SUMS")), "utf8");
const checksum = sums.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).find((entry) => entry[1] === basename(archive));
assert(checksum, "Archive must be listed in SHA256SUMS");
assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), checksum[0]);

const scratch = mkdtempSync(join(tmpdir(), "tl-archive-check-"));
const home = join(scratch, "home");
const workspace = join(scratch, "workspace");
const extracted = join(scratch, "extracted");
for (const dir of [home, workspace, extracted]) mkdirSync(dir);
const env = { ...process.env, TOKENLIGHTEN_HOME: home, TOKENLIGHTEN_USAGE_LOG: "off" };
if (process.platform === "win32") {
  env.USERPROFILE = home;
  env.HOMEDRIVE = parse(home).root.slice(0, 2);
  env.HOMEPATH = home.slice(parse(home).root.length - 1);
  env.APPDATA = join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = join(home, "AppData", "Local");
} else {
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, ".config");
  env.XDG_DATA_HOME = join(home, ".local", "share");
}
function run(command, args, cwd = workspace) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${basename(command)} failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
let client;
try {
  run(tar, ["xzf", archive, "-C", extracted]);
  const entries = readdirSync(extracted);
  assert.equal(entries.length, 1);
  const payload = join(extracted, entries[0]);
  const runtime = join(payload, "runtime", process.platform === "win32" ? "node.exe" : "node");
  assert(existsSync(join(payload, "runtime", "LICENSE-node")));
  assert(readFileSync(join(payload, "THIRD_PARTY_NOTICES.md"), "utf8").includes("Node.js"));
  const serverBundle = readFileSync(join(payload, "node_modules", "@tokenlighten", "mcp-server", "dist", "bin.js"), "utf8");
  assert(!/TL_CORE2_ENABLE|--core2|C2_TOOLS/.test(serverBundle), "Private protocol must not be bundled");
  const setup = join(payload, process.platform === "win32" ? "tl-setup.cmd" : "tl-setup");
  const setupCommand = process.platform === "win32" ? "cmd.exe" : setup;
  const setupPrefix = process.platform === "win32" ? ["/d", "/c", setup] : [];
  run(setupCommand, [...setupPrefix, "--dry-run"], payload);
  const installArgs = [...setupPrefix, workspace, "--clients", "none", "--yes", "--json"];
  const installed = JSON.parse(run(setupCommand, installArgs, payload));
  const installHome = installed.plan?.installHome ?? join(home, "data");
  const installedNode = join(installHome, "bin", process.platform === "win32" ? "node.exe" : "node");
  const installedCli = join(installHome, "bin", "tl.js");
  assert.equal(run(runtime, ["--version"]).trim(), run(installedNode, ["--version"]).trim());
  assert(run(installedNode, [installedCli, "version"]).includes(version));
  const sentence = "TokenLighten release archive read is working.";
  writeFileSync(join(workspace, "hello.txt"), sentence + "\n");
  run(tar, ["czf", join(workspace, "sample.tar.gz"), "-C", workspace, "hello.txt"]);
  client = new Client({ name: "tokenlighten-archive-smoke", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: installedNode, args: [installedCli, "mcp", "start", "--stdio", "--no-prereq-check", "--workspace", workspace], cwd: workspace, env, stderr: "inherit" }));
  assert.equal(client.getServerVersion()?.version, version);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["edit_file", "read_file", "search_files"]);
  for (const target of [{ path: "hello.txt" }, { archive: { path: "sample.tar.gz", member: "hello.txt" } }]) {
    const result = await client.callTool({ name: "read_file", arguments: { targets: [target], cwd: workspace } }, undefined, { timeout: 30_000 });
    assert(!result.isError, JSON.stringify(result));
    assert(JSON.stringify(result).includes(sentence), "Installed server must return the requested content");
  }
  await client.close();
  client = undefined;
  // Re-running setup must retain a usable version-independent launcher.
  run(setupCommand, installArgs, payload);
  assert(run(installedNode, [installedCli, "version"]).includes(version));
  run(installedNode, [installedCli, "install", "--uninstall", "--yes", "--json"]);
  assert(!existsSync(installedCli), "Uninstall must remove the managed launcher");
  console.log(`PASS ${platform}: checksum, setup, runtime, MCP tools, file/archive reads, re-run, uninstall`);
} finally {
  await client?.close();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
