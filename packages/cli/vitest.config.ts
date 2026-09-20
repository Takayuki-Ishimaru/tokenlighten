import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    environment: "node",
    // S3 (v0.14.3 pre-release fix wave, test isolation leak): fails a spec
    // file loudly if it rewrites the developer's REAL managed/legacy
    // launcher shim instead of using an isolated installHome/homeDir or
    // TOKENLIGHTEN_HOME. Read-only guard; see the module itself.
    setupFiles: ["./src/__tests__/realLauncherGuard.setup.ts"],
  },
});
