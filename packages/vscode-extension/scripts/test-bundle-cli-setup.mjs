import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const EXTENSION_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(EXTENSION_ROOT, "..", "..");
const BUNDLE_SCRIPT = join(EXTENSION_ROOT, "scripts", "bundle-cli.mjs");
const BUNDLED_CLI = join(EXTENSION_ROOT, "dist", "tl-cli.js");
const BUNDLED_NOTICES = join(EXTENSION_ROOT, "dist", "THIRD_PARTY_NOTICES.md");
const BUNDLED_MCP = join(
  EXTENSION_ROOT,
  "dist",
  "node_modules",
  "@tokenlighten",
  "mcp-server",
  "dist",
  "bin.js",
);
const BUNDLED_AGENTS_MD = join(
  EXTENSION_ROOT,
  "dist",
  "node_modules",
  "@tokenlighten",
  "agents-md",
);
const NPM_CLI = process.env.npm_execpath;
assert.ok(NPM_CLI, "npm_execpath is required to verify the VSIX file list");

function isolatedEnvironment(root) {
  const userRoot = join(root, "user");
  const configRoot = join(root, "config");
  const preload = join(root, "isolated-homedir.cjs");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(
    preload,
    `require("node:os").homedir = () => ${JSON.stringify(userRoot)};\n`,
    "utf8",
  );
  const requirePreload = `--require ${JSON.stringify(preload)}`;
  return {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, requirePreload]
      .filter(Boolean)
      .join(" "),
    APPDATA: configRoot,
    LOCALAPPDATA: configRoot,
    XDG_CONFIG_HOME: configRoot,
    XDG_CACHE_HOME: configRoot,
    XDG_DATA_HOME: configRoot,
    XDG_STATE_HOME: configRoot,
    TMPDIR: root,
  };
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    result.stderr || result.stdout || `command failed: ${command}`,
  );
  return result;
}

run(process.execPath, [BUNDLE_SCRIPT], {
  cwd: REPO_ROOT,
  env: process.env,
});

const templates = join(BUNDLED_AGENTS_MD, "templates");
assert.equal(existsSync(BUNDLED_CLI), true, "bundled CLI missing");
assert.equal(existsSync(BUNDLED_NOTICES), true, "third-party notices missing");
assert.equal(existsSync(BUNDLED_MCP), true, "bundled MCP server missing");
assert.equal(existsSync(templates), true, "agents-md templates missing");
for (const packageName of ["mcp-server", "skeleton-engine", "agents-md"]) {
  const manifest = JSON.parse(
    readFileSync(
      join(
        EXTENSION_ROOT,
        "dist",
        "node_modules",
        "@tokenlighten",
        packageName,
        "package.json",
      ),
      "utf8",
    ),
  );
  assert.equal(
    manifest.license,
    "SEE LICENSE IN LICENSE",
    `${packageName} bundled license metadata is incorrect`,
  );
}
assert.match(
  readFileSync(BUNDLED_CLI, "utf8"),
  /@tokenlighten\/agents-md/,
  "agents-md was not retained as a runtime external",
);

// Assert on the artifact that actually ships: the .vsix file list under
// .vscodeignore (vsce ls). The npm tarball is not it -- this package is
// private:true, and without a "files" field npm pack falls back to
// .gitignore, which excludes dist/ entirely (a "files" field is not an
// option either: combined with .vscodeignore it is a fatal vsce error).
const vsceResult = run(
  process.execPath,
  [NPM_CLI, "exec", "--", "vsce", "ls", "--no-dependencies"],
  {
    cwd: EXTENSION_ROOT,
    env: process.env,
  },
);
const packagedFiles = vsceResult.stdout
  .split(/\r?\n/)
  .map((line) => line.trim().replaceAll("\\", "/"))
  .filter((line) => line.length > 0);
assert.ok(
  packagedFiles.includes(
    "dist/node_modules/@tokenlighten/mcp-server/dist/bin.js",
  ),
  "VS Code .vsix listing does not contain the bundled public MCP binary",
);
assert.ok(
  packagedFiles.includes("dist/THIRD_PARTY_NOTICES.md"),
  "VS Code .vsix listing does not contain third-party notices",
);
assert.equal(
  packagedFiles.includes("SHA256SUMS"),
  false,
  "VS Code .vsix listing contains the release asset checksum",
);

const sandbox = mkdtempSync(join(tmpdir(), "tl-bundled-setup-"));
const workspace = join(sandbox, "workspace");
mkdirSync(workspace);
try {
  const setup = run(
    process.execPath,
    [
      BUNDLED_CLI,
      "workspace",
      "setup",
      "--root",
      workspace,
      "--rules-only",
      "--json",
    ],
    {
      cwd: workspace,
      env: isolatedEnvironment(sandbox),
    },
  );
  const result = JSON.parse(setup.stdout);
  assert.equal(result.workspaceRoot, realpathSync(workspace));
  assert.deepEqual(result.clients, []);
  for (const relativePath of [
    "AGENTS.md",
    join(".github", "copilot-instructions.md"),
  ]) {
    const target = join(workspace, relativePath);
    assert.equal(existsSync(target), true, `${relativePath} missing`);
    assert.ok(readFileSync(target, "utf8").length > 0, `${relativePath} empty`);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

process.stdout.write("bundle-cli setup integration: ok\n");
