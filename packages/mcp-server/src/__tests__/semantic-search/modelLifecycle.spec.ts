import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MULTILINGUAL_E5_MODEL, E5_MIT_NOTICE } from "@tokenlighten/types";
import { readSemanticModelStatus } from "../../features/semantic-search/modelLifecycle.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("model provenance and offline status", () => {
  it("pins model/revision, distinguishes inherited MIT, and provides the full notice", () => {
    expect(MULTILINGUAL_E5_MODEL.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(MULTILINGUAL_E5_MODEL.license).toBe("MIT");
    expect(MULTILINGUAL_E5_MODEL.licenseProvenance).toBe("upstream-model-card");
    expect(MULTILINGUAL_E5_MODEL.source).toContain(MULTILINGUAL_E5_MODEL.revision);
    expect(E5_MIT_NOTICE).toContain("Copyright (c) Microsoft Corporation");
    expect(E5_MIT_NOTICE).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it("checks missing/incomplete/present assets and fingerprints without inference or network", async () => {
    const root = await mkdtemp(join(tmpdir(), "tl-semantic-status-")); roots.push(root);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    expect((await readSemanticModelStatus({ cacheDir: root })).status).toBe("missing");
    const modelRoot = join(root, MULTILINGUAL_E5_MODEL.id, MULTILINGUAL_E5_MODEL.revision);
    await mkdir(join(modelRoot, "onnx"), { recursive: true });
    await writeFile(join(modelRoot, "config.json"), "{}");
    expect((await readSemanticModelStatus({ cacheDir: root })).status).toBe("incomplete");
    for (const file of ["tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"]) await writeFile(join(modelRoot, file), "asset");
    const complete = await readSemanticModelStatus({ cacheDir: root });
    expect(complete.status).toBe("ready");
    expect(complete.missingFiles).toEqual([]);
    expect(complete.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect((await readSemanticModelStatus({ cacheDir: root })).fingerprint).toBe(complete.fingerprint);
    await writeFile(join(modelRoot, "config.json"), "updated");
    expect((await readSemanticModelStatus({ cacheDir: root })).fingerprint).not.toBe(complete.fingerprint);
    expect(network).not.toHaveBeenCalled();
  });

  it("does not report a symlink or empty model payload as installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "tl-semantic-links-")); roots.push(root);
    const modelRoot = join(root, MULTILINGUAL_E5_MODEL.id, MULTILINGUAL_E5_MODEL.revision);
    await mkdir(join(modelRoot, "onnx"), { recursive: true });
    await writeFile(join(root, "foreign"), "not a model");
    await symlink(join(root, "foreign"), join(modelRoot, "config.json"));
    await writeFile(join(modelRoot, "onnx/model_quantized.onnx"), "");
    const status = await readSemanticModelStatus({ cacheDir: root });
    expect(status.missingFiles).toContain("config.json");
    expect(status.missingFiles).toContain("onnx/model_quantized.onnx");
  });
});
