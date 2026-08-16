import { afterEach, describe, expect, it } from "vitest";
import {
  credentialEnvName,
  resolveCredentialRef,
} from "../security/credentials.js";

const touched = new Set<string>();

afterEach(() => {
  for (const name of touched) delete process.env[name];
  touched.clear();
});

describe("credentialRef resolution", () => {
  it("maps an opaque reference to a server environment variable", () => {
    const envName = credentialEnvName("project-docs");
    touched.add(envName);
    process.env[envName] = "test-secret";

    expect(resolveCredentialRef("project-docs")).toEqual({
      ok: true,
      credentialRef: "project-docs",
      password: "test-secret",
    });
  });

  it("never accepts a raw or malformed secret-shaped argument", () => {
    const result = resolveCredentialRef("contains spaces and secret text");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret text");
  });

  it("returns setup guidance without returning a password", () => {
    const result = resolveCredentialRef("missing-docs");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("credential-not-found");
    expect(result.hint).toContain("TOKENLIGHTEN_PASSWORD_MISSING_DOCS");
  });
});
