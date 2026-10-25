import { describe, it, expect } from "vitest";
import { classifyLicense } from "./licenses-check.mjs";
import { onnxRuntimeLegalFiles } from "./onnxruntime-licenses.mjs";

describe("runtime dependency license classification", () => {
  it.each(["MIT AND GPL-3.0-only", "Apache-2.0 AND AGPL-3.0-only", "MIT AND (Apache-2.0 OR GPL-3.0-only) AND SSPL-1.0",
    "MIT AND BSL-1.1", "MIT; GPL v3"])("does not discard mandatory prohibited terms: %s", license => {
    expect(classifyLicense(license)).toBe("denied");
  });
  it.each(["MIT OR GPL-3.0-only", "MIT AND (Apache-2.0 OR GPL-3.0-only)", "(MIT AND GPL-3.0-only) OR Apache-2.0"])("permits a complete allowed alternative: %s", license => {
    expect(classifyLicense(license)).toBe("ok");
  });
  it.each(["onnxruntime-node@1.30.0", "onnxruntime-web@1.31.0-dev.20260914-8d85527a0"])("includes actual MIT terms and binary third-party notices for %s", packageId => {
    const files = onnxRuntimeLegalFiles(packageId);
    expect(files.map(file => file.name)).toEqual(["LICENSE", "ThirdPartyNotices.txt"]);
    expect(files[0].bytes.toString("utf8")).toContain("Copyright (c) Microsoft Corporation");
    expect(files[0].bytes.toString("utf8")).toContain("Permission is hereby granted, free of charge");
    expect(files[1].bytes.toString("utf8")).toContain("THIRD PARTY SOFTWARE NOTICES AND INFORMATION");
    expect(files[0].source).toMatch(/onnxruntime\/[a-f0-9]{40}\/LICENSE$/);
  });
  it.each(["onnxruntime-common@1.30.0", "onnxruntime-common@1.31.0-dev.20260911-2a43ec07e"])("includes MIT terms for the JavaScript package %s", packageId => {
    expect(onnxRuntimeLegalFiles(packageId).map(file => file.name)).toEqual(["LICENSE"]);
  });
  it("requires a fresh legal review for an unrecognized runtime version", () => {
    expect(() => onnxRuntimeLegalFiles("onnxruntime-web@0.0.0-unreviewed")).toThrow("must be reviewed");
  });
  it.each(["GPL-1.0", "GPL-2.0-only", "GPL-3.0-or-later", "AGPL-3.0", "SSPL-1.0", "BUSL-1.1", "Elastic-2.0"])("continues rejecting %s", license => {
    expect(classifyLicense(license)).toBe("denied");
  });
  it.each(["LGPL-2.1-only", "LGPL-3.0-or-later", "Apache-2.0 AND LGPL-3.0-or-later AND MIT"])("keeps the LGPL review category distinct from GPL: %s", license => {
    expect(classifyLicense(license)).toBe("lgpl");
  });
});
