import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PDF } from "@libpdf/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { editArtifact } from "../write/artifactEdit.js";
import { unsafeGuardedWorkspaceRootForTests, type GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";

describe("real encrypted PDF artifact edit", () => {
  let workspace: GuardedWorkspaceRoot;

  beforeEach(() => {
    workspace = unsafeGuardedWorkspaceRootForTests(fs.mkdtempSync(path.join(os.tmpdir(), "tl-pdf-edit-")));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("fills a form and rotates password protection", async () => {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    const form = pdf.getOrCreateForm();
    const name = form.createTextField("name", { fontSize: 12 });
    await page.drawField(name, { x: 72, y: 700, width: 200, height: 24 });
    pdf.setProtection({
      userPassword: "reader-secret",
      ownerPassword: "owner-secret",
      algorithm: "AES-256",
    });
    fs.writeFileSync(path.join(workspace, "form.pdf"), await pdf.save());

    const result = await editArtifact({
      path: "form.pdf",
      artifact: { kind: "pdf", form: { name: "Ada Lovelace" } },
      credentialPassword: "owner-secret",
      outputPassword: "rotated-secret",
      outputCredentialSupplied: true,
    }, workspace, true, "test-session");

    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      kind: "pdf",
      changes: 1,
      encrypted: true,
    });
    const verified = await PDF.load(
      fs.readFileSync(path.join(workspace, "form.pdf")),
      { credentials: "rotated-secret" },
    );
    expect(verified.isEncrypted).toBe(true);
    expect(verified.getForm()?.getTextField("name")?.getValue()).toBe("Ada Lovelace");
  });
});
