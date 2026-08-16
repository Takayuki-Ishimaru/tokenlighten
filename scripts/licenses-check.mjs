#!/usr/bin/env node

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function optionalArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a path`);
  }
  return resolve(repoRoot, value);
}

const noticeOutput = optionalArg("--notice-out");

const selectedLicenseOptions = new Map([
  ["jszip@3.10.1", "MIT"],
]);

function selectedLicenseOption(name, declaredLicense) {
  const selected = selectedLicenseOptions.get(name);
  if (!selected) return "";
  const alternatives = declaredLicense
    .replace(/[()]/g, "")
    .split(/\s+OR\s+/i)
    .map((value) => value.trim());
  if (!alternatives.includes(selected)) {
    throw new Error(`${name} no longer declares the reviewed ${selected} license option`);
  }
  return selected;
}

function runtimePackageIds() {
  const lock = JSON.parse(readFileSync(resolve(repoRoot, "package-lock.json"), "utf8"));
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") {
    throw new Error("package-lock.json must use lockfileVersion 3 with a packages map");
  }
  const ids = new Set();
  for (const [packagePath, info] of Object.entries(lock.packages)) {
    if (!packagePath.includes("node_modules/") || info?.dev === true || info?.link === true) continue;
    if (typeof info?.version !== "string") continue;
    const name = packagePath.split("node_modules/").at(-1);
    if (name) ids.add(`${name}@${info.version}`);
  }
  return ids;
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function isFirstParty(name) {
  return name.startsWith("@tokenlighten/")
    || name.startsWith("tokenlighten-desktop@")
    || name.startsWith("tokenlighten-vscode-extension@");
}

function normalizedLegalText(value, label) {
  const normalized = String(value).replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw new Error(`${label} is empty`);
  return `${normalized}\n`;
}

function readPackageLegalFile(candidate, packageRoot, label) {
  if (typeof candidate !== "string" || !candidate) {
    throw new Error(`${label} path is missing`);
  }
  if (typeof packageRoot !== "string" || !packageRoot) {
    throw new Error(`${label} package root is missing`);
  }
  const realRoot = realpathSync(packageRoot);
  const realFile = realpathSync(candidate);
  const fromRoot = relative(realRoot, realFile);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`${label} resolves outside its package root`);
  }
  if (!statSync(realFile).isFile()) throw new Error(`${label} is not a regular file`);
  return normalizedLegalText(readFileSync(realFile, "utf8"), label);
}

function packageNoticeTexts(packageRoot, packageName) {
  if (typeof packageRoot !== "string" || !packageRoot) return [];
  const realRoot = realpathSync(packageRoot);
  return readdirSync(realRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(?:notice|third[-_ ]party(?:[-_ ]notices?)?)(?:\.|$)/i.test(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      text: readPackageLegalFile(resolve(realRoot, name), realRoot, `${packageName} ${name}`),
    }));
}

function fencedText(value) {
  const longest = Math.max(2, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${value}${fence}`;
}

function groupLegalTexts(entries, select) {
  const groups = new Map();
  for (const entry of entries) {
    for (const item of select(entry)) {
      const digest = createHash("sha256").update(item.text, "utf8").digest("hex");
      const group = groups.get(digest) ?? {
        digest,
        label: item.label,
        text: item.text,
        packages: [],
      };
      group.packages.push(entry.name);
      groups.set(digest, group);
    }
  }
  return [...groups.values()]
    .map((group) => ({ ...group, packages: [...new Set(group.packages)].sort() }))
    .sort((a, b) => a.digest.localeCompare(b.digest));
}

function writeThirdPartyNotices(data, outputPath, runtimeIds) {
  const expectedNames = [...runtimeIds].filter((name) => !isFirstParty(name)).sort();
  const missing = expectedNames.filter((name) => data[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`license metadata missing for runtime packages: ${missing.join(", ")}`);
  }

  const entries = expectedNames.map((name) => {
    const info = data[name];
    const license = asLicenseString(info?.licenses) || "UNKNOWN";
    const licenseText = readPackageLegalFile(
      info?.licenseFile,
      info?.path,
      `${name} license`,
    );
    return {
      name,
      license,
      selectedLicense: selectedLicenseOption(name, license),
      publisher: typeof info?.publisher === "string" ? info.publisher : "",
      repository: typeof info?.repository === "string"
        ? info.repository
        : typeof info?.url === "string"
          ? info.url
          : "",
      licenseText,
      notices: packageNoticeTexts(info?.path, name),
    };
  });

  const licenseSelections = entries.filter((entry) => entry.selectedLicense);
  const licenseGroups = groupLegalTexts(entries, (entry) => [{
    label: entry.license,
    text: entry.licenseText,
  }]);
  const noticeGroups = groupLegalTexts(entries, (entry) => entry.notices.map((notice) => ({
    label: notice.name,
    text: notice.text,
  })));

  const lines = [
    "# Third-party dependency notices",
    "",
    "This file was generated from the installed production npm dependency metadata for this release.",
    "The package inventory, license texts, and package NOTICE files below are redistributed with the bundled runtime. Each dependency remains subject to its own terms.",
    "For a dual-licensed dependency, the selected option below is the license TokenLighten relies on; the complete upstream license file is still preserved in this notice.",
    "",
    ...(licenseSelections.length > 0 ? [
      "## Selected alternatives for dual-licensed dependencies",
      "",
      "| Package | Declared alternatives | Selected option |",
      "|---|---|---|",
      ...licenseSelections.map((entry) => `| ${markdownCell(entry.name)} | ${markdownCell(entry.license)} | ${markdownCell(entry.selectedLicense)} |`),
      "",
    ] : []),
    "## Package inventory",
    "",
    "| Package | License | Publisher | Repository |",
    "|---|---|---|---|",
    ...entries.map((entry) => `| ${markdownCell(entry.name)} | ${markdownCell(entry.license)} | ${markdownCell(entry.publisher)} | ${markdownCell(entry.repository)} |`),
    "",
    "## License texts",
    "",
    ...licenseGroups.flatMap((group) => [
      `### ${markdownCell(group.label)} — SHA-256 ${group.digest}`,
      "",
      `Applies to: ${group.packages.map((name) => `\`${name}\``).join(", ")}`,
      "",
      fencedText(group.text),
      "",
    ]),
    ...(noticeGroups.length > 0 ? [
      "## Package NOTICE files",
      "",
      ...noticeGroups.flatMap((group) => [
        `### ${markdownCell(group.label)} — SHA-256 ${group.digest}`,
        "",
        `Applies to: ${group.packages.map((name) => `\`${name}\``).join(", ")}`,
        "",
        fencedText(group.text),
        "",
      ]),
    ] : []),
  ];
  writeFileSync(outputPath, lines.join("\n"), "utf8");
  console.log(
    `Third-party notices written: ${outputPath} (${entries.length} packages, ${licenseGroups.length} license texts, ${noticeGroups.length} NOTICE texts)`,
  );
}

const denyPatterns = [
  /gpl-1/i,
  /gpl-2/i,
  /gpl-3/i,
  /agpl/i,
  /sspl/i,
  /rsalv2/i,
  /bsl/i,
  /busl/i,
  /business source/i,
  /commons clause/i,
  /cc-by-nc/i,
  /elastic-2\.0/i,
  /elv2/i,
  /confluent community/i,
];
const safePatterns = [
  /mit/i,
  /apache/i,
  /bsd/i,
  /isc/i,
  /0bsd/i,
  /cc0/i,
  /mpl-2/i,
  /unlicense/i,
  /public domain/i,
];

function asLicenseString(value) {
  return Array.isArray(value) ? value.join("; ") : String(value ?? "");
}

export function classifyLicense(value, allowPythonFoundation = false) {
  const raw = asLicenseString(value).trim();
  const tokens = raw.split(/\s+OR\s+|\s+AND\s+|[;,]/i);
  const pythonSafe = allowPythonFoundation ? [/python software foundation/i] : [];
  const hasDenied = tokens.some((token) => denyPatterns.some((pattern) => pattern.test(token)));
  const hasLgpl = tokens.some((token) => /lgpl/i.test(token));
  const hasSafe = tokens.some((token) =>
    [...safePatterns, ...pythonSafe].some((pattern) => pattern.test(token))
  );

  if (!hasDenied && !hasLgpl) return "ok";
  if (hasSafe) return hasLgpl && !hasDenied ? "lgpl" : "ok";
  if (hasLgpl && !hasDenied) return "lgpl";
  return "denied";
}

function run(command, args) {
  return crossSpawn.sync(command, args, {
    cwd: repoRoot,
    shell: false,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function report(label, entries, allowPythonFoundation = false) {
  const denied = [];
  const lgpl = [];

  for (const entry of entries) {
    const classification = classifyLicense(entry.license, allowPythonFoundation);
    if (classification === "denied") denied.push(entry);
    if (classification === "lgpl") lgpl.push(entry);
  }

  console.log(
    `${label}: ${entries.length} packages scanned, ${denied.length} denylisted (${lgpl.length} LGPL flag-for-review)`
  );
  for (const entry of lgpl) {
    console.error(`  [LGPL-WARNING] ${entry.name}: ${entry.license}`);
  }
  for (const entry of denied) {
    console.log(`  [DENIED] ${entry.name}: ${entry.license}`);
  }
  return denied.length === 0;
}

function resolveLicenseChecker() {
  const packageJsonPath = require.resolve("license-checker-rseidelsohn/package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const bin = typeof packageJson.bin === "string"
    ? packageJson.bin
    : Object.values(packageJson.bin ?? {})[0];
  if (typeof bin !== "string") {
    throw new Error("license-checker-rseidelsohn does not declare a binary");
  }
  return resolve(dirname(packageJsonPath), bin);
}

function scanNpm() {
  console.log("=== npm dependency scan ===");
  try {
    const checker = resolveLicenseChecker();
    const result = run(process.execPath, [
      checker,
      "--start",
      repoRoot,
      "--json",
      "--excludePrivatePackages",
    ]);
    if (result.error || result.status !== 0) {
      console.error(
        `npm: license-checker-rseidelsohn failed: ${result.error?.message ?? result.stderr.trim()}`
      );
      return false;
    }
    const data = JSON.parse(result.stdout);
    if (noticeOutput) {
      writeThirdPartyNotices(data, noticeOutput, runtimePackageIds());
    }
    return report(
      "npm",
      Object.entries(data).map(([name, info]) => ({
        name,
        license: asLicenseString(info?.licenses),
      }))
    );
  } catch (error) {
    console.error(`npm: ${error instanceof Error ? error.message : String(error)}`);
    console.error("npm: local license-checker-rseidelsohn is missing; run npm install first");
    return false;
  }
}

console.log("TokenLighten license gate");
console.log(`Repo root: ${repoRoot}`);
console.log("");

const npmClean = scanNpm();
console.log("");

if (npmClean) {
  console.log("License check PASSED. 0 denylisted.");
} else {
  console.log("License check FAILED. See [DENIED] or scanner error lines above.");
  process.exitCode = 1;
}
