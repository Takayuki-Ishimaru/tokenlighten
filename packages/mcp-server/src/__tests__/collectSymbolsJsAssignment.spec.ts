/**
 * collectSymbolsJsAssignment.spec.ts — CommonJS functions defined by
 * assignment (2026-10-29 field report, express 5).
 *
 * `res.redirect = function redirect(url) {}` was not a symbol: the walk fell
 * through to the function body and listed its locals (`var req = this.req`),
 * so a symbol read of `res.redirect` failed and offered `i` as a candidate.
 */

import { describe, it, expect } from "vitest";

import { collectSymbols } from "../symbols/collectSymbols.js";
import { treeSitterSkeleton } from "../skeleton/treeSitter.js";
import { getSymbolWithContext } from "../tools/getSymbolWithContext.js";

const RESPONSE_JS = [
  "'use strict';",
  "var res = Object.create(http.ServerResponse.prototype);",
  "module.exports = res;",
  "",
  "/**",
  " * Redirect to the given `url`.",
  " */",
  "res.redirect = function redirect(url) {",
  "  var address = url;",
  "  var req = this.req;",
  "  for (var i = 0; i < 2; i++) {}",
  "  this.location(address);",
  "};",
  "",
  "res.get = function(field){",
  "  return this.getHeader(field);",
  "};",
  "",
  "exports.send = async (body) => {",
  "  const chunk = body;",
  "  return chunk;",
  "};",
  "",
  "Router.prototype.handle = function handle(req, res, out) {",
  "  var idx = 0;",
  "};",
  "",
  "defineGetter(req, 'protocol', function protocol(){",
  "  var proto = this.connection.encrypted ? 'https' : 'http';",
  "  return proto;",
  "});",
  "",
  "app.View = class {",
  "  render(name) { return name; }",
  "};",
  "",
  "app[method] = function (path) { var route = path; };",
].join("\n") + "\n";

describe("collectSymbols — JS functions defined by assignment", () => {
  it("collects member, exports, prototype and accessor definitions by their dotted names", async () => {
    const symbols = await collectSymbols(RESPONSE_JS, "javascript");
    const byName = new Map(symbols.map((s) => [s.name, s]));
    expect(byName.get("res.redirect")).toMatchObject({ kind: "function", startLine: 5, signatureStartLine: 8, endLine: 13 });
    expect(byName.get("res.get")).toMatchObject({ kind: "function", startLine: 15, endLine: 17 });
    expect(byName.get("exports.send")).toMatchObject({ kind: "function", startLine: 19, endLine: 22 });
    expect(byName.get("Router.prototype.handle")).toMatchObject({ kind: "function", startLine: 24, endLine: 26 });
    expect(byName.get("req.protocol")).toMatchObject({ kind: "function", startLine: 28, endLine: 31 });
    expect(byName.get("app.View")).toMatchObject({ kind: "class", startLine: 33, endLine: 35 });
    expect(byName.get("render")).toMatchObject({ kind: "method", enclosingSymbol: { name: "app.View" } });
  });

  it("does not list the locals of an assigned function body", async () => {
    const names = (await collectSymbols(RESPONSE_JS, "javascript")).map((s) => s.name);
    for (const local of ["address", "req", "i", "chunk", "idx", "proto"]) {
      expect(names).not.toContain(local);
    }
    // Top-level declarations are still collected.
    expect(names).toContain("res");
  });

  it("names `module.exports = function name() {}` by the function's own name", async () => {
    const source = "module.exports = function createApplication() {\n  var app = 1;\n  return app;\n};\n";
    const symbols = await collectSymbols(source, "javascript");
    expect(symbols.map((s) => s.name)).toEqual(["createApplication"]);
    const anonymous = await collectSymbols("module.exports = function () {};\n", "javascript");
    expect(anonymous.map((s) => s.name)).toEqual(["module.exports"]);
  });

  it("collects the same shapes in TypeScript", async () => {
    const source = "exports.parse = function parse(input: string): number {\n  const n = Number(input);\n  return n;\n};\n";
    const symbols = await collectSymbols(source, "typescript");
    expect(symbols.map((s) => s.name)).toEqual(["exports.parse"]);
  });

  it("leaves computed members and non-function values alone", async () => {
    const source = "app[method] = function () {};\nres.locals = Object.create(null);\nthis.x = function () {};\n";
    const names = (await collectSymbols(source, "javascript")).map((s) => s.name);
    expect(names).not.toContain("res.locals");
    expect(names).not.toContain("this.x");
  });

  it("serves the body for both the dotted and the bare symbol name", async () => {
    const dotted = await getSymbolWithContext(RESPONSE_JS, { path: "lib/response.js", symbol: "res.redirect" });
    expect(dotted.ok).toBe(true);
    const bare = await getSymbolWithContext(RESPONSE_JS, { path: "lib/response.js", symbol: "redirect" });
    expect(bare.ok).toBe(true);
    if (dotted.ok && bare.ok) {
      expect(dotted.data.code).toContain("this.location(address);");
      expect(dotted.data.range).toEqual({ start: 5, end: 13 });
      expect(bare.data.range).toEqual(dotted.data.range);
    }
  });

  it("elides assigned function bodies in the file skeleton", async () => {
    const skeleton = await treeSitterSkeleton(RESPONSE_JS, "javascript");
    expect(skeleton).toBeDefined();
    expect(skeleton).toContain("res.redirect = function redirect(url) { ... };");
    expect(skeleton).toContain("exports.send = async (body) => { ... };");
    expect(skeleton).toContain("defineGetter(req, 'protocol', function protocol() { ... });");
    expect(skeleton).not.toContain("var req = this.req;");
    expect(skeleton).not.toContain("const chunk = body;");
  });
});
