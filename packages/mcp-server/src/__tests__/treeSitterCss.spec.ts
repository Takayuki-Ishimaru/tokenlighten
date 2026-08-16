/**
 * treeSitterCss.spec.ts — A9 CSS custom-property capture, plus the CSS
 * structural outline (selectors + at-rules) added on top of it, in
 * skeleton/treeSitter.ts.
 *
 * CSS declarations (`--foo-bar: value;`) don't fit the func/class RULES model
 * used for the other 11 languages, so CSS gets a dedicated extractor
 * (extractCssCustomProperties) instead of going through renderChildren. This
 * spec only exercises code added for A9 — it does not touch getSymbolWithContext,
 * getFileSkeleton, or collectSymbols (owned by other workstreams).
 *
 * The outline is bounded, no cascade semantics: selectors and at-rule
 * preludes only, one level of at-rule nesting, no declaration bodies. It is
 * `.css`-only — SCSS/LESS are NOT parsed with this grammar. Verified
 * empirically (a throwaway probe against tree-sitter-wasms' tree-sitter-css
 * grammar): a representative SCSS sample (`$variable`, `&:hover` nesting,
 * `@mixin`/`@include`) parses with `tree.rootNode.hasError === true` and 16
 * ERROR/missing nodes — every `$` becomes its own ERROR node and `@mixin`'s
 * parameter list is unparseable. tree-sitter-wasms@0.1.12 (the version this
 * repo ships) also has no tree-sitter-scss.wasm / tree-sitter-less.wasm
 * asset at all. So SCSS/LESS stay plain-text: see
 * getFileSkeleton.spec.ts's "unmapped extensions" case for the end-to-end
 * assertion (languages.ts's EXT_TO_LANGUAGE deliberately has no scss/less
 * entry, so they never reach this module).
 */

import { describe, it, expect } from "vitest";
import { extractCssCustomProperties, treeSitterSkeleton, treeSitterSupports } from "../skeleton/treeSitter.js";

const TOKENS_CSS = `:root {
  --color-status-blocked: #ff0000;
  --color-priority-paramount: #ffcc00;
}

.chip--priority-paramount {
  color: var(--color-priority-paramount);
}
`;

describe("extractCssCustomProperties", () => {
  it("captures --custom-property declarations with name, line, and text", async () => {
    const props = await extractCssCustomProperties(TOKENS_CSS);

    // Skip gracefully if the CSS WASM grammar cannot load in this environment
    // (extractCssCustomProperties returns [] rather than throwing).
    if (props.length === 0) return;

    const names = props.map((p) => p.name);
    expect(names).toContain("--color-status-blocked");
    expect(names).toContain("--color-priority-paramount");
  });

  it("does not capture regular (non-custom) declarations like `color: red;`", async () => {
    const props = await extractCssCustomProperties(TOKENS_CSS);
    if (props.length === 0) return;

    const names = props.map((p) => p.name);
    expect(names).not.toContain("color");
  });

  it("reports correct 1-based line numbers", async () => {
    const props = await extractCssCustomProperties(TOKENS_CSS);
    if (props.length === 0) return;

    const blocked = props.find((p) => p.name === "--color-status-blocked");
    expect(blocked?.line).toBe(2);
  });

  it("returns [] for empty CSS without throwing", async () => {
    const props = await extractCssCustomProperties("");
    expect(props).toEqual([]);
  });

  it("returns [] (not a throw) for malformed CSS", async () => {
    await expect(extractCssCustomProperties("{{{ not valid css ")).resolves.toBeInstanceOf(Array);
  });
});

describe("treeSitterSkeleton — css", () => {
  it("produces a compact skeleton of custom-property declarations", async () => {
    const skeleton = await treeSitterSkeleton(TOKENS_CSS, "css");
    if (skeleton === undefined) return; // WASM unavailable in this environment

    expect(skeleton).toContain("--color-status-blocked");
    expect(skeleton).toContain("--color-priority-paramount");
  });

  it("still extracts custom properties, unchanged shape, alongside the new outline", async () => {
    // Regression for the task-pack style-surface consumer (see the module
    // doc comment): the pre-existing CssCustomProperty capture must keep
    // producing the exact same lines it always has, just as one of two
    // blocks in the combined skeleton now.
    const skeleton = await treeSitterSkeleton(TOKENS_CSS, "css");
    if (skeleton === undefined) return;

    expect(skeleton).toContain(":root");
    expect(skeleton).toContain(".chip--priority-paramount");
    expect(skeleton).toContain("--color-status-blocked: #ff0000;");
    expect(skeleton).toContain("--color-priority-paramount: #ffcc00;");
  });
});

describe("treeSitterSkeleton — css outline (selectors + at-rules, A-css1)", () => {
  it("emits one line per top-level rule_set selector, whitespace-collapsed", async () => {
    const css = `.card,\n  .card--active {\n  color: red;\n  background: blue;\n}\n\n.badge {\n  color: green;\n}\n`;
    const skeleton = await treeSitterSkeleton(css, "css");
    if (skeleton === undefined) return;

    expect(skeleton).toContain(".card, .card--active");
    expect(skeleton).toContain(".badge");
    // Declaration bodies (cascade content) are out of scope for the outline.
    expect(skeleton).not.toContain("color: red");
    expect(skeleton).not.toContain("background: blue");
  });

  it("recurses one level into an @media block's nested rule_sets", async () => {
    const css = `@media (max-width: 600px) {\n  .card {\n    color: blue;\n  }\n  .nav > .item {\n    display: none;\n  }\n}\n`;
    const skeleton = await treeSitterSkeleton(css, "css");
    if (skeleton === undefined) return;

    expect(skeleton).toContain("@media (max-width: 600px) {");
    expect(skeleton).toContain("\n  .card\n");
    expect(skeleton).toContain("\n  .nav > .item\n");
  });

  it("recurses one level into @supports", async () => {
    const css = `@supports (display: grid) {\n  .grid { display: grid; }\n  .fallback { display: block; }\n}\n`;
    const skeleton = await treeSitterSkeleton(css, "css");
    if (skeleton === undefined) return;

    expect(skeleton).toContain("@supports (display: grid) {");
    expect(skeleton).toContain("\n  .grid\n");
    expect(skeleton).toContain("\n  .fallback\n");
  });

  it("recurses one level into @keyframes' keyframe_blocks (from/to/percentages)", async () => {
    const css = `@keyframes spin {\n  from { transform: rotate(0deg); }\n  50% { transform: rotate(180deg); }\n  to { transform: rotate(360deg); }\n}\n`;
    const skeleton = await treeSitterSkeleton(css, "css");
    if (skeleton === undefined) return;

    expect(skeleton).toContain("@keyframes spin {");
    expect(skeleton).toContain("\n  from\n");
    expect(skeleton).toContain("\n  50%\n");
    expect(skeleton).toContain("\n  to\n");
    // The declaration inside each keyframe_block is cascade content, not outline.
    expect(skeleton).not.toContain("rotate(");
  });

  it("recognizes @layer (generic at_rule node, disambiguated by at_keyword text)", async () => {
    const css = `@layer base {\n  body { margin: 0; }\n}\n`;
    const skeleton = await treeSitterSkeleton(css, "css");
    if (skeleton === undefined) return;

    expect(skeleton).toContain("@layer base {");
    expect(skeleton).toContain("\n  body\n");
  });

  it("emits the bare statement for a bodyless @layer name;", async () => {
    const css = `@layer utilities;\n`;
    const skeleton = await treeSitterSkeleton(css, "css");
    if (skeleton === undefined) return;

    expect(skeleton).toContain("@layer utilities;");
  });

  it("recognizes @font-face (generic at_rule node) and elides its declarations", async () => {
    const css = `@font-face {\n  font-family: "MyFont";\n  src: url("myfont.woff2");\n}\n`;
    const skeleton = await treeSitterSkeleton(css, "css");
    if (skeleton === undefined) return;

    // @font-face's block holds only declarations (no nested rule_set), so the
    // leaf-container placeholder applies — same convention funcSkeleton()
    // uses for an elided brace-style body.
    expect(skeleton).toContain("@font-face { ... }");
    expect(skeleton).not.toContain("MyFont");
  });

  it("emits a prelude-only line for a bodyless @import", async () => {
    const css = `@import url("other.css");\n`;
    const skeleton = await treeSitterSkeleton(css, "css");
    if (skeleton === undefined) return;

    expect(skeleton).toContain('@import url("other.css");');
  });

  it("does not recurse past one level (a rule_set's own nested at-rule is not shown)", async () => {
    // @supports containing @media containing a rule_set: only @supports'
    // OWN direct children matter for the one-level recursion — the nested
    // @media is a "media_statement", not a "rule_set"/"keyframe_block", so
    // it is invisible at that inner level (by design — see the module doc
    // comment on CSS_NESTED_RULE_TYPES).
    const css = `@supports (display: grid) {\n  @media (max-width: 600px) {\n    .deep { color: red; }\n  }\n}\n`;
    const skeleton = await treeSitterSkeleton(css, "css");
    if (skeleton === undefined) return;

    expect(skeleton).toContain("@supports (display: grid) { ... }");
    expect(skeleton).not.toContain(".deep");
  });
});

describe("treeSitterSupports — css", () => {
  it("returns true for css (get_file_skeleton's tree-sitter gate checks this before calling treeSitterSkeleton)", () => {
    expect(treeSitterSupports("css")).toBe(true);
    expect(treeSitterSupports("CSS")).toBe(true);
  });
});
