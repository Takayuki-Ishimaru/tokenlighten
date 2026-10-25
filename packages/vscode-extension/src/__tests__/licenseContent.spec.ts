import { describe, expect, it } from "vitest";
import {
  parseDependencyNotices,
  renderLicenseContent,
  type ModelLicenseEntry,
} from "../licenseContent.js";

const NOTICES = [
  "# Third-party notices",
  "",
  "TokenLighten bundles the packages below.",
  "",
  "| Package | License | Publisher | Repository |",
  "| --- | --- | --- | --- |",
  "| `left-pad` | MIT | left-pad-team | https://github.com/example/left-pad |",
  "| `a&#124;b` | Apache-2.0 | Example&#124;Corp | https://example.com/a |",
  "| `c\\|d` | MIT | nobody | https://example.com/c |",
  "",
  "## Selected alternatives",
  "",
  "| Package | License | Publisher | Repository |",
  "| --- | --- | --- | --- |",
  "| `not-included` | MIT | ghost | https://example.com/nope |",
  "",
  "## Full license texts",
  "",
  "### left-pad",
  "",
  "MIT License\n\nPermission is hereby granted, free of charge.\n",
].join("\n");

const XSS = `"><img src=x onerror=alert(1)></td></tr></table><script>alert("</script>")</script>`;

const XSS_NOTICES = [
  "| Package | License | Publisher | Repository |",
  "| ------- | ------- | --------- | ---------- |",
  `| ${XSS} | ${XSS} | ${XSS} | ${XSS} |`,
  "",
  "</pre></details><script>alert(1)</script>",
].join("\n");

const MODELS: ModelLicenseEntry[] = [
  {
    id: "model-alpha",
    revision: "rev-123",
    license: "Example Community License",
    source: "https://example.com/alpha",
    licenseText: "Alpha license text\nline two",
    notice: "Alpha notice",
    installed: true,
  },
  {
    id: "model-beta",
    revision: "rev-456",
    license: "Restricted",
    licenseText: "Beta license text",
    installed: false,
  },
];

describe("parseDependencyNotices", () => {
  it("reads the generated inventory table into searchable rows", () => {
    expect(parseDependencyNotices(NOTICES)).toEqual([
      {
        name: "`left-pad`",
        license: "MIT",
        publisher: "left-pad-team",
        repository: "https://github.com/example/left-pad",
      },
      { name: "`a|b`", license: "Apache-2.0", publisher: "Example|Corp", repository: "https://example.com/a" },
      { name: "`c|d`", license: "MIT", publisher: "nobody", repository: "https://example.com/c" },
    ]);
  });

  it("excludes the selected-alternatives table", () => {
    const names = parseDependencyNotices(NOTICES).map((row) => row.name);
    expect(names).not.toContain("`not-included`");
  });

  it("returns no rows for empty or malformed inventories", () => {
    expect(parseDependencyNotices("")).toEqual([]);
    expect(parseDependencyNotices(undefined as unknown as string)).toEqual([]);
    expect(parseDependencyNotices("just prose, no table")).toEqual([]);
    expect(
      parseDependencyNotices("| Package | License |\n| --- | --- |\n| only | two |"),
    ).toEqual([]);
    expect(
      parseDependencyNotices("| Package | License | Publisher | Repository |\n| --- |\n| `x` |"),
    ).toEqual([]);
  });
});

describe("renderLicenseContent", () => {
  it("renders the parsed inventory and keeps the full notices text", () => {
    const html = renderLicenseContent({ notices: NOTICES, language: "en", nonce: "abc123" });
    expect(html).toContain("left-pad-team");
    expect(html).toContain("https://github.com/example/left-pad");
    expect(html).toContain("a|b");
    expect(html).toContain("Example|Corp");
    expect(html).toContain("c|d");
    const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
    expect(table).not.toContain("not-included");
    expect(html.match(/class="dep-row"/g)).toHaveLength(3);
    expect(html).toContain("<pre class=\"notices\">");
    expect(html).toContain("Permission is hereby granted, free of charge.");
    expect(html).toContain("<details>");
  });

  it("escapes markup and script breaks in every untrusted field", () => {
    const html = renderLicenseContent({ notices: XSS_NOTICES, language: "en", nonce: "n1" });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("</td></tr></table>");
    expect(html).not.toContain("<script>alert(");
    expect(html).not.toContain("</pre></details><script>");
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain("&lt;script&gt;alert(&quot;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
  });

  it("never interpolates metadata into the script and emits no executable href", () => {
    const html = renderLicenseContent({
      notices: `| Package | License | Publisher | Repository |\n| --- | --- | --- | --- |\n| ${XSS} | MIT | p | https://evil.example/?';alert(1);// |`,
      language: "en",
      nonce: "n2",
    });
    const script = html.slice(html.indexOf("<script"), html.indexOf("</script>"));
    expect(script).not.toContain("alert(1)");
    expect(script).not.toContain("evil.example");
    expect(html).not.toContain("<a href=");
    expect(html).not.toContain("javascript:");
  });

  it("applies the nonce CSP", () => {
    const html = renderLicenseContent({ notices: "", language: "en", nonce: "nonce-42" });
    expect(html).toContain(
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-nonce-42'\">",
    );
    expect(html).toContain("<script nonce=\"nonce-42\">");
  });

  it("strips a hostile nonce instead of letting it break out of the attribute", () => {
    const html = renderLicenseContent({
      notices: "",
      language: "en",
      nonce: `"><script>alert(1)</script>`,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain("<script nonce=\"\">");
  });

  it("renders model metadata with exact revision and installed/available labels", () => {
    const html = renderLicenseContent({ notices: "", models: MODELS, language: "en", nonce: "n3" });
    expect(html).toContain("model-alpha");
    expect(html).toContain("rev-123");
    expect(html).toContain("rev-456");
    expect(html).toContain(">Installed<");
    expect(html).toContain(">Available<");
    expect(html).toContain("Alpha license text\nline two");
    expect(html).toContain("Alpha notice");
    expect(html).toContain("Beta license text");
    expect(html).toContain("https://example.com/alpha");
  });

  it("labels models in Japanese when language is ja", () => {
    const ja = renderLicenseContent({ notices: NOTICES, models: MODELS, language: "ja", nonce: "n4" });
    const en = renderLicenseContent({ notices: NOTICES, models: MODELS, language: "en", nonce: "n4" });
    expect(ja).toContain("インストール済み");
    expect(ja).toContain("利用可能");
    expect(ja).toContain("依存パッケージ");
    expect(ja).toContain("ライセンス本文");
    expect(ja).toContain("パッケージ名またはライセンスで検索");
    expect(ja).toContain('lang="ja"');
    expect(en).toContain("Installed");
    expect(en).toContain("Dependencies");
    expect(en).toContain('lang="en"');
    expect(ja).not.toContain("Dependencies");
  });

  it("keeps dependency rows searchable by name and license", () => {
    const html = renderLicenseContent({ notices: NOTICES, language: "en", nonce: "n5" });
    expect(html).toContain('data-search="`left-pad` mit"');
    expect(html).toContain('data-search="`a|b` apache-2.0"');
    expect(html).toContain('id="search"');
    expect(html).toContain('class="dep-row"');
    expect(html).toContain("data-search");
  });

  it("keeps model metadata accessible when a search filter is present", () => {
    const html = renderLicenseContent({ notices: NOTICES, models: MODELS, language: "en", nonce: "n6" });
    const script = html.slice(html.indexOf("<script"), html.indexOf("</script>"));
    expect(script).toContain('.dep-row');
    expect(script).not.toContain(".model");
    expect(html).toContain('class="model"');
  });

  it("fails honestly on empty and malformed input by showing the original text", () => {
    const empty = renderLicenseContent({ notices: "", language: "en", nonce: "n7" });
    expect(empty).toContain("No dependency inventory was found");
    expect(empty).not.toContain("<table");

    const malformed = renderLicenseContent({
      notices: "Package | License | Publisher | Repository\nbroken row without a header\n",
      language: "en",
      nonce: "n8",
    });
    expect(malformed).toContain("could not be read as a table");
    expect(malformed).toContain("broken row without a header");
    expect(malformed).not.toContain("<table");
    expect(malformed).not.toContain("undefined");

    const noModels = renderLicenseContent({ notices: "", language: "ja", nonce: "n9" });
    expect(noModels).toContain("モデルライセンスの登録はありません。");
  });

  it("tolerates missing and empty model entries", () => {
    const html = renderLicenseContent({
      notices: "",
      models: [undefined as unknown as ModelLicenseEntry, {}, { id: "", installed: undefined }],
      language: "en",
      nonce: "n10",
    });
    expect(html).toContain("No license text is registered for this model.");
    expect(html).not.toContain("undefined");
    expect(html).toContain(">Available<");
  });
});
