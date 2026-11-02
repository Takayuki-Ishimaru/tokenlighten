import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { jsTiktokenLegalFiles } from "./js-tiktoken-licenses.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture(change) {
  const root = mkdtempSync(join(tmpdir(), "tl-tiktoken-legal-")); roots.push(root);
  const legal = join(root, "assets", "licenses", "js-tiktoken"); mkdirSync(legal, { recursive: true });
  mkdirSync(join(root, "scripts"));
  copyFileSync(new URL("./js-tiktoken-licenses.mjs", import.meta.url), join(root, "scripts", "js-tiktoken-licenses.mjs"));
  for (const name of ["LICENSE.txt", "PROVENANCE.json"]) copyFileSync(new URL(`../assets/licenses/js-tiktoken/${name}`, import.meta.url), join(legal, name));
  change(legal);
  return (await import(pathToFileURL(join(root, "scripts", "js-tiktoken-licenses.mjs")).href)).jsTiktokenLegalFiles;
}

describe("pinned js-tiktoken legal text", () => {
  it("returns the exact release license and provenance", () => {
    const [file] = jsTiktokenLegalFiles("js-tiktoken@1.0.21");
    expect(file.name).toBe("LICENSE"); expect(file.bytes.length).toBe(1078);
    expect(createHash("sha256").update(file.bytes).digest("hex")).toBe("418cb499b436128d653d79941333a5437b7be2ea9213dcc2f04d15d5d2c51d86");
    expect(file.source).toBe("https://raw.githubusercontent.com/dqbd/tiktoken/4c8b748e07992c00386f3180af5c574b27b65139/LICENSE");
  });
  it("ignores unrelated packages and refuses an unreviewed version", () => {
    expect(jsTiktokenLegalFiles("other@1.0.21")).toBeUndefined();
    expect(() => jsTiktokenLegalFiles("js-tiktoken@1.0.22")).toThrow("must be reviewed");
  });
  it("rejects modified license bytes", async () => {
    const get = await fixture(dir => writeFileSync(join(dir, "LICENSE.txt"), "modified\n"));
    expect(() => get("js-tiktoken@1.0.21")).toThrow("resource changed");
  });
  it.each(["package", "sha", "url", "bytes", "sha256", "npm"])("rejects changed provenance %s", async field => {
    const get = await fixture(dir => { const file = join(dir, "PROVENANCE.json"); const p = JSON.parse(readFileSync(file, "utf8")); p[field] = "modified"; writeFileSync(file, JSON.stringify(p)); });
    expect(() => get("js-tiktoken@1.0.21")).toThrow("Invalid js-tiktoken legal provenance");
  });
});
