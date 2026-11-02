import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const packageId = "js-tiktoken@1.0.21";
const sha = "4c8b748e07992c00386f3180af5c574b27b65139";
const url = `https://raw.githubusercontent.com/dqbd/tiktoken/${sha}/LICENSE`;
const digest = "418cb499b436128d653d79941333a5437b7be2ea9213dcc2f04d15d5d2c51d86";
const root = new URL("../assets/licenses/js-tiktoken/", import.meta.url);

/** The npm package omits LICENSE; retain the exact upstream release's text. */
export function jsTiktokenLegalFiles(id) {
  if (!id.startsWith("js-tiktoken@")) return undefined;
  if (id !== packageId) throw new Error(`js-tiktoken legal provenance must be reviewed for ${id}`);
  const provenance = JSON.parse(readFileSync(new URL("PROVENANCE.json", root), "utf8"));
  if (provenance.package !== packageId || provenance.sha !== sha || provenance.url !== url
    || provenance.bytes !== 1078 || provenance.sha256 !== digest
    || provenance.npm !== "https://registry.npmjs.org/js-tiktoken/1.0.21") {
    throw new Error(`Invalid js-tiktoken legal provenance for ${id}`);
  }
  const bytes = readFileSync(new URL("LICENSE.txt", root));
  if (bytes.length !== 1078 || createHash("sha256").update(bytes).digest("hex") !== digest) {
    throw new Error("js-tiktoken legal resource changed: LICENSE.txt");
  }
  return [{ name: "LICENSE", bytes, source: url }];
}
