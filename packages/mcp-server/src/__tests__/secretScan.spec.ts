// secretScan.spec.ts — unit tests for looksLikeSecretFile.
//
// Positive cases: .env, id_rsa, .aws/credentials, etc.
// Negative cases: README.md, src/index.ts, etc.

import { describe, it, expect } from "vitest";
import { looksLikeSecretFile } from "../write/secretScan.js";

describe("secretScan — positive cases (should be rejected)", () => {
  it(".env", () => {
    expect(looksLikeSecretFile(".env")).toBe(true);
  });

  it(".env.local", () => {
    expect(looksLikeSecretFile(".env.local")).toBe(true);
  });

  it(".env.production", () => {
    expect(looksLikeSecretFile(".env.production")).toBe(true);
  });

  it("id_rsa", () => {
    expect(looksLikeSecretFile("id_rsa")).toBe(true);
  });

  it("id_dsa", () => {
    expect(looksLikeSecretFile("id_dsa")).toBe(true);
  });

  it("id_ecdsa", () => {
    expect(looksLikeSecretFile("id_ecdsa")).toBe(true);
  });

  it("id_ed25519", () => {
    expect(looksLikeSecretFile("id_ed25519")).toBe(true);
  });

  it(".ssh/id_rsa", () => {
    expect(looksLikeSecretFile(".ssh/id_rsa")).toBe(true);
  });

  it(".aws/credentials", () => {
    expect(looksLikeSecretFile(".aws/credentials")).toBe(true);
  });

  it(".aws/config (within .aws/ dir)", () => {
    expect(looksLikeSecretFile(".aws/config")).toBe(true);
  });

  it(".kube/config", () => {
    expect(looksLikeSecretFile(".kube/config")).toBe(true);
  });

  it(".ssh/known_hosts (within .ssh/)", () => {
    expect(looksLikeSecretFile(".ssh/known_hosts")).toBe(true);
  });

  it("private.pem", () => {
    expect(looksLikeSecretFile("private.pem")).toBe(true);
  });

  it("cert.key", () => {
    expect(looksLikeSecretFile("cert.key")).toBe(true);
  });

  it("keystore.p12", () => {
    expect(looksLikeSecretFile("keystore.p12")).toBe(true);
  });

  it("server.pfx", () => {
    expect(looksLikeSecretFile("server.pfx")).toBe(true);
  });

  it("app.keystore", () => {
    expect(looksLikeSecretFile("app.keystore")).toBe(true);
  });

  it("credentials.json", () => {
    expect(looksLikeSecretFile("credentials.json")).toBe(true);
  });

  it("src/credentials.ts (path component)", () => {
    expect(looksLikeSecretFile("src/credentials.ts")).toBe(true);
  });

  it("mysecretfile.txt", () => {
    expect(looksLikeSecretFile("mysecretfile.txt")).toBe(true);
  });

  it("service_account.json", () => {
    expect(looksLikeSecretFile("service_account.json")).toBe(true);
  });
});

describe("secretScan — negative cases (should be allowed)", () => {
  it("README.md", () => {
    expect(looksLikeSecretFile("README.md")).toBe(false);
  });

  it("src/index.ts", () => {
    expect(looksLikeSecretFile("src/index.ts")).toBe(false);
  });

  it(".env.example", () => {
    expect(looksLikeSecretFile(".env.example")).toBe(false);
  });

  it(".env.sample", () => {
    expect(looksLikeSecretFile(".env.sample")).toBe(false);
  });

  it("config.json", () => {
    expect(looksLikeSecretFile("config.json")).toBe(false);
  });

  it("package.json", () => {
    expect(looksLikeSecretFile("package.json")).toBe(false);
  });

  it("src/auth/user.ts", () => {
    expect(looksLikeSecretFile("src/auth/user.ts")).toBe(false);
  });

  it("docs/deployment.md", () => {
    expect(looksLikeSecretFile("docs/deployment.md")).toBe(false);
  });

  it("public/index.html", () => {
    expect(looksLikeSecretFile("public/index.html")).toBe(false);
  });

  it("src/components/Button.tsx", () => {
    expect(looksLikeSecretFile("src/components/Button.tsx")).toBe(false);
  });
});
