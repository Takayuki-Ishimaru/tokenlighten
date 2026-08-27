import { describe, expect, it } from "vitest";
import { __testOnlyHtmlToMarkdown } from "../office/docx.js";
import { __testOnlyXmlTextContent } from "../office/ooxmlVisuals.js";

describe("office fallback sanitization", () => {
  it("single-decodes DOCX HTML entities without emitting raw markup", () => {
    const markdown = __testOnlyHtmlToMarkdown("<h1>Title &amp;lt;</h1><p>&lt;script&gt; &amp; &quot;quoted&quot;</p><table><tr><td>one</td><td>two</td></tr></table>");
    expect(markdown).toContain("# Title &lt;");
    expect(markdown).toContain("&lt;script&gt; & \"quoted\"");
    expect(markdown).toContain("| one | two |");
    expect(markdown).not.toContain("<script>");
  });

  it("keeps OOXML encoded markup as text rather than raw markup", () => {
    expect(__testOnlyXmlTextContent("&lt;script&gt;safe&lt;/script&gt;")).toBe("&lt;script&gt;safe&lt;/script&gt;");
    expect(__testOnlyXmlTextContent("plain &amp; ordinary")).toBe("plain & ordinary");
  });
});
