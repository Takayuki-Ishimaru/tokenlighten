import { describe, expect, it } from "vitest";
import { API_HANDLER_EXTRACTORS, extractApiHandlers } from "../apiGraph.js";

describe("apiGraph handler extraction", () => {
  it("exposes a registry of language/framework extractors", () => {
    expect(API_HANDLER_EXTRACTORS.length).toBeGreaterThanOrEqual(8);
  });

  it("extracts Ktor routes from Kotlin routing blocks", () => {
    const src = [
      "fun Application.routes() {",
      "  routing {",
      "    route(\"/api/users\") {",
      "      get(\"/{id}\") { call.respondText(\"ok\") }",
      "      post(\"\", ::createUser)",
      "    }",
      "  }",
      "}",
    ].join("\n");

    const handlers = extractApiHandlers(src, "kotlin", "src/Routes.kt");

    expect(handlers).toEqual([
      expect.objectContaining({
        file: "src/Routes.kt",
        method: "GET",
        path: "/api/users/{id}",
        handler: "<inline>",
        confidence: "medium",
      }),
      expect.objectContaining({
        file: "src/Routes.kt",
        method: "POST",
        path: "/api/users",
        handler: "createUser",
        confidence: "high",
      }),
    ]);
  });

  it("keeps existing Express extraction behavior", () => {
    const src = "router.get('/api/health', healthHandler);\n";
    const handlers = extractApiHandlers(src, "typescript", "routes.ts");

    expect(handlers).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/api/health",
        handler: "healthHandler",
      }),
    ]);
  });
});
