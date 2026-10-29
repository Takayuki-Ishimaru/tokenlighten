import { describe, expect, it } from "vitest";
import { INSTRUCTIONS_VERSION, renderBlock, renderCanonicalBlock, renderCompactBlock, renderMediumBlock, renderPortableCodeBlock, renderReadOnlyCodeBlock } from "../render.js";

// A compact `next` the server issues under its configured root carries no `cwd`
// (an omitted cwd resolves to that root), so the long path is nothing to copy
// back in: a Codex trial typed it with an extra word and paid an invalid-cwd
// round trip. Every guide that states the per-call cwd rule says, inside that
// same sentence, that none is added to a `next`.
describe("the per-call cwd rule leaves a server-issued next as written", () => {
  const en = "add no `cwd` to a `next`", plain = "add no cwd to a next", jp = "`next`にcwd追加禁止";

  it.each([
    ["compact EN", () => renderCompactBlock("en"), `top-level \`cwd\` (no pwd; else \`cwd-required-for-edit\`); ${en}. Working alone, omit \`lane\``],
    ["compact JP", () => renderCompactBlock("jp"), `なければ\`cwd-required-for-edit\`); ${jp}. 単独作業では\`lane\`を省略`],
    ["medium EN", () => renderMediumBlock("en"), `Top-level \`cwd\`; ${en}; alone omit \`lane\``],
    ["medium JP", () => renderMediumBlock("jp"), `最上位\`cwd\`; ${jp}; 単独は\`lane\`省略`],
    ["full EN", () => renderCanonicalBlock("en"), `on EVERY call; otherwise \`cwd-required-for-edit\`. Add no \`cwd\` to a \`next\`.`],
    ["full JP", () => renderCanonicalBlock("jp"), `無宣言rootは\`cwd-required-for-edit\`. ${jp}.`],
    ["portable code", () => renderPortableCodeBlock(), `Every call: top-level cwd; ${plain}. Working alone, omit lane`],
    ["read-only code", () => renderReadOnlyCodeBlock(), `Every call: own cwd at top level; ${plain}; alone omit lane`],
    ["Copilot standalone", () => renderBlock("copilot", "en", INSTRUCTIONS_VERSION, "full", "full", "standalone"), `Every call: own \`cwd\`; ${en}; shared workspace: fixed \`lane\``],
  ])("%s", (_name, render, sentence) => {
    expect(render()).toContain(sentence);
  });

  it("still requires cwd on the calls a model composes, and still runs a next verbatim", () => {
    const compact = renderCompactBlock("en");
    expect(compact).toContain("Each call: top-level `cwd` (no pwd; else `cwd-required-for-edit`)");
    expect(compact).toContain("`next` whole call, verbatim; hints advisory.");
    expect(compact).toContain("New files/tests=`edits:[{path,create:true,content}]`+explicit `cwd`");
    expect(renderCompactBlock("jp")).toContain("各callはtop-level `cwd`必須(pwd不要;");
  });
});
