import {describe, expect, it} from "vitest";
import {goTestInvokesFocal, samePackageGoTest} from "../util/goVerification.js";
describe("direct Go test context", () => {
  const source = "package balance\nfunc Compute() {}";
  it("requires a real invocation, and ignores comments, strings and declarations", () => {
    expect(goTestInvokesFocal('package balance\nfunc TestIt() { Compute() }', "Compute")).toBe(true);
    for (const text of ['// Compute()\n', 'var s = "Compute()"', 'func Compute() {}'])
      expect(goTestInvokesFocal(text, "Compute")).toBe(false);
  });
  it("requires the same directory and declared package, not comment text", () => {
    expect(samePackageGoTest("p/compute.go", source, "p/compute_test.go", "package balance\n")).toBe(true);
    for (const [file, text] of [["other/compute_test.go", "package balance"], ["p/compute_test.go", "package other"],
      ["p/compute_test.go", "/*\npackage balance\n*/"], ["p/compute.go", "package balance"]])
      expect(samePackageGoTest("p/compute.go", source, file!, text!)).toBe(false);
  });
});
