// serverInfo.version was a hardcoded "0.2.0" at two server.ts sites while
// the package (and every sibling) ships 0.9.0 — the wire-visible remnant of
// the version-drift class the 2026-08-09 release audit called the
// "quadruple personality". These pins keep the derivation honest from both
// directions: the walk-up resolver must find the real manifest, and the
// bundle fallback literal must equal that manifest so it cannot rot.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import * as os from "node:os";

import {
  deriveServerPackageVersion,
  SERVER_PACKAGE_VERSION_FALLBACK,
} from "../util/serverBuild.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(HERE, "..", "..", "package.json"), "utf8"),
) as { name: string; version: string };

describe("deriveServerPackageVersion", () => {
  it("resolves the real package version from a module inside the package", () => {
    expect(manifest.name).toBe("@tokenlighten/mcp-server");
    expect(deriveServerPackageVersion(import.meta.url)).toBe(manifest.version);
  });

  it("pins the bundle fallback literal to the real manifest so it cannot drift", () => {
    expect(SERVER_PACKAGE_VERSION_FALLBACK).toBe(manifest.version);
  });

  it("degrades to the pinned fallback outside any owning package", () => {
    const orphan = pathToFileURL(join(os.tmpdir(), "tl-no-package-here", "mod.js")).href;
    expect(deriveServerPackageVersion(orphan)).toBe(SERVER_PACKAGE_VERSION_FALLBACK);
  });
});
