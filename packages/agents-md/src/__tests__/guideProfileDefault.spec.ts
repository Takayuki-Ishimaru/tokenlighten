// guideProfileDefault.spec.ts — P2-3(1) (v0.14.1 hands-on report).
//
// `tl workspace setup --tool-surface code` used to still write the full
// 12 KB guide because nothing coupled --guide-profile's default to
// --tool-surface. defaultGuideProfileForSurface() is the single exported
// pure function every call site (packages/cli, packages/vscode-extension,
// and — transitively via the CLI — packages/desktop-app) now applies
// instead of re-deriving the same rule independently.
import { describe, it, expect } from "vitest";
import { defaultGuideProfileForSurface } from "../guideProfileDefault.js";
import { defaultGuideProfileForSurface as reExported } from "../render.js";
import { defaultGuideProfileForSurface as fromIndex } from "../index.js";

describe("defaultGuideProfileForSurface", () => {
  it('returns "compact" for the code tool surface', () => {
    expect(defaultGuideProfileForSurface("code")).toBe("compact");
  });

  it('returns "full" for the full tool surface', () => {
    expect(defaultGuideProfileForSurface("full")).toBe("full");
  });

  it('returns "full" when no tool surface was selected (undefined)', () => {
    expect(defaultGuideProfileForSurface(undefined)).toBe("full");
  });

  it("is re-exported unchanged from render.js and index.js (single source of truth)", () => {
    expect(reExported).toBe(defaultGuideProfileForSurface);
    expect(fromIndex).toBe(defaultGuideProfileForSurface);
  });
});
