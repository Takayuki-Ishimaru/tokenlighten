import { describe, expect, it } from "vitest";
import {
  isMarkdownPath,
  markdownOutline,
  markdownSectionAtLine,
  parseMarkdownHeadings,
  selectMarkdownSections,
} from "../util/markdownSections.js";

describe("markdownSections", () => {
  it("only strips closing hashes preceded by whitespace", () => {
    expect(parseMarkdownHeadings("# C#\n### Heading ###\n").map((h) => h.text)).toEqual(["C#", "Heading"]);
  });

  it("parses long ATX whitespace runs without backtracking", () => {
    const padding = "\t".repeat(100_000);
    expect(parseMarkdownHeadings(`###${padding}Heading\n`).map((h) => h.text)).toEqual(["Heading"]);
    expect(parseMarkdownHeadings(`#######${padding}Not a heading\n`)).toEqual([]);
  });
  const document = [
    "# Guide",
    "Intro.",
    "",
    "```md",
    "## Fake heading",
    "Fake Setext",
    "-----------",
    "```",
    "",
    "Linux",
    "-----",
    "Linux notes.",
    "",
    "### Install ###",
    "Run the installer.",
    "",
    "Windows",
    "-------",
    "Windows notes.",
    "",
  ].join("\n");

  it("parses ATX and Setext headings while ignoring fenced examples", () => {
    const headings = parseMarkdownHeadings(document);
    expect(headings.map((heading) => [heading.text, heading.level, heading.style])).toEqual([
      ["Guide", 1, "atx"],
      ["Linux", 2, "setext"],
      ["Install", 3, "atx"],
      ["Windows", 2, "setext"],
    ]);
    expect(headings.map((heading) => heading.path)).toEqual([
      "Guide",
      "Guide > Linux",
      "Guide > Linux > Install",
      "Guide > Windows",
    ]);
    expect(headings[1]!.endLine).toBe(16);
    expect(markdownSectionAtLine(headings, 15)?.text).toBe("Install");
    expect(markdownOutline(headings).join("\n")).not.toContain("Fake");
  });

  it("selects a unique hierarchical section and refuses ambiguous short names", () => {
    const duplicate = [
      "# Guide",
      "## Linux",
      "### Install",
      "Linux steps.",
      "## Windows",
      "### Install",
      "Windows steps.",
    ].join("\n");
    const headings = parseMarkdownHeadings(duplicate);

    const exact = selectMarkdownSections(headings, ["Guide > Linux > Install"]);
    expect(exact.matches.map((heading) => heading.path)).toEqual(["Guide > Linux > Install"]);
    expect(exact.ambiguous).toEqual([]);

    const ambiguous = selectMarkdownSections(headings, ["Install"]);
    expect(ambiguous.matches).toEqual([]);
    expect(ambiguous.ambiguous[0]!.candidates.map((heading) => heading.path)).toEqual([
      "Guide > Linux > Install",
      "Guide > Windows > Install",
    ]);
  });

  it("auto-corrects a unique fuzzy full path without matching ancestor headings", () => {
    const headings = parseMarkdownHeadings([
      "# TokenLighten Design",
      "## Workstream C — Response & Schema Compaction",
      "### C1. Pack boilerplate trim (53% of pack bytes)",
      "Details.",
      "### C2. Verify hints",
      "More details.",
    ].join("\n"));
    const selected = selectMarkdownSections(headings, [
      "TokenLighten Design > Workstream C — Response & Schema Compaction > C1. mode task pack boilerplate trim (53% of pack bytes)",
    ]);
    expect(selected.matches.map((heading) => heading.text)).toEqual([
      "C1. Pack boilerplate trim (53% of pack bytes)",
    ]);
    expect(selected.ambiguous).toEqual([]);
  });

  it("does not treat YAML frontmatter delimiters as a Setext heading", () => {
    const headings = parseMarkdownHeadings([
      "---",
      "title: Operations Guide",
      "owner: platform",
      "---",
      "# Deployment",
      "Deploy safely.",
    ].join("\n"));

    expect(headings.map((heading) => heading.text)).toEqual(["Deployment"]);
  });

  it("recognizes both common Markdown extensions", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("guide.markdown")).toBe(true);
    expect(isMarkdownPath("guide.mdx")).toBe(false);
  });
});
