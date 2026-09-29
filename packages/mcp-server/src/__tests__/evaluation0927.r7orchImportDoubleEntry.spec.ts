/**
 * evaluation0927.r7orchImportDoubleEntry.spec.ts — a specifier list that names
 * the member twice, once plainly and once under an alias, is never
 * "explained" by the plain entry (orchestrator, round 7). The aliased entry
 * introduces a second name callers use (`export { formatBytes, formatBytes as
 * formatSize }` keeps a deprecated name alive), so the line stays a mention
 * and the callers facet can never be certified `empty` through it.
 */
import { describe, expect, it } from "vitest";

import { mentionExplainedByImportExport, mentionExplainedByImportExportLine } from "../features/task-pack/readCodeTaskPack.js";

const M = "formatBytes";

describe("a plain entry never explains an aliased sibling of the same member", () => {
  it.each([
    ["export { formatBytes, formatBytes as formatSize };"],
    ["export { formatBytes as formatSize, formatBytes } from \"./format\";"],
    ["import { formatBytes as fmt, formatBytes } from \"./format\";"],
    ["import def, { formatBytes, formatBytes as fmt } from \"./format\";"],
    ["import formatBytes, { formatBytes as fmt } from \"./format\";"],
    ["const { formatBytes, formatBytes: fmt } = require(\"./format\");"],
    ["use crate::format::{formatBytes, formatBytes as fmt};"],
  ])("%s is a mention", (line) => {
    expect(mentionExplainedByImportExportLine(line, M)).toBe(false);
  });

  it("python: `from m import formatBytes, formatBytes as fb` is a mention", () => {
    expect(mentionExplainedByImportExportLine("from m import formatBytes, formatBytes as fb", M)).toBe(false);
  });

  it("controls: plain single and plain multi-entry lists stay explained", () => {
    expect(mentionExplainedByImportExportLine("import { formatBytes } from \"./format\";", M)).toBe(true);
    expect(mentionExplainedByImportExportLine("import { a, formatBytes, b } from \"./format\";", M)).toBe(true);
    expect(mentionExplainedByImportExportLine("import formatBytes, { a } from \"./format\";", M)).toBe(true);
    expect(mentionExplainedByImportExportLine("export { formatBytes } from \"./format\";", M)).toBe(true);
    expect(mentionExplainedByImportExportLine("import { formatBytesLegacy as fmt, formatBytes } from \"./format\";", M)).toBe(true);
  });

  it("multi-line list: the plain line is explained, the aliased line is a mention", () => {
    const lines = ["export {", "  formatBytes,", "  formatBytes as formatSize,", "} from \"./format\";"];
    expect(mentionExplainedByImportExport(lines, 2, M)).toBe(true);
    expect(mentionExplainedByImportExport(lines, 3, M)).toBe(false);
  });
});
