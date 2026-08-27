import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildInterfaceAuthoritySurfaces,
  INTERFACE_AUTHORITY_BODY_BUDGET_BYTES,
  INTERFACE_AUTHORITY_MAX_SURFACES,
} from "../features/task-pack/interfaceAuthority.js";
import { buildTaskPack } from "../tools/readCodeTaskPack.js";

const workspaces: string[] = [];
const ORIGINAL_INTERFACE_AUTHORITY = process.env["TL_INTERFACE_AUTHORITY"];

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-interface-authority-"));
  workspaces.push(root);
  return root;
}

function write(root: string, relPath: string, content: string): void {
  const target = path.join(root, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function frontier(pathname: string, code: string) {
  return [{ role: "api", handle: "hfrontier", path: pathname, range: "1-20", code }];
}

afterEach(() => {
  if (ORIGINAL_INTERFACE_AUTHORITY === undefined) {
    delete process.env["TL_INTERFACE_AUTHORITY"];
  } else {
    process.env["TL_INTERFACE_AUTHORITY"] = ORIGINAL_INTERFACE_AUTHORITY;
  }
  for (const root of workspaces.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("interface authority task-pack helper", () => {
  it("resolves the include root of a nested project (Probe-2 Phase 1a regression)", () => {
    const root = workspace();
    write(root, "aeroctl/firmware/src/estimator/ekf.cpp", [
      "#include <estimator/ekf.hpp>",
      "bool poll() {",
      "  ekf_health_t health{};",
      "  return publish(health);",
      "}",
      "",
    ].join("\n"));
    write(root, "aeroctl/firmware/include/estimator/ekf.hpp", [
      "#pragma once",
      "typedef struct {",
      "  bool healthy;",
      "} ekf_health_t;",
      "",
    ].join("\n"));

    const surfaces = buildInterfaceAuthoritySurfaces({
      workspace: root,
      frontier: frontier(
        "aeroctl/firmware/src/estimator/ekf.cpp",
        "ekf_health_t health{};\nreturn publish(health);",
      ),
    });

    // The nested include root (aeroctl/firmware/include/) is neither the
    // owner's directory nor a workspace-root child — the pre-fix candidate
    // list returned zero surfaces here, which is exactly how IB-H1 failed.
    expect(surfaces.map((surface) => surface.path)).toContain("aeroctl/firmware/include/estimator/ekf.hpp");
    const declaration = surfaces.find((surface) => surface.path.endsWith("ekf.hpp"));
    expect(String(declaration?.code ?? "")).toContain("ekf_health_t");
  });

  it("ignores comment prose on both sides (real-aeroctl 188-surface noise regression)", () => {
    const root = workspace();
    write(root, "src/main.cpp", [
      "#include <util/flags.h>",
      "// battery values are below the threshold and most come from sensors",
      "void step() {",
      "  util_flags_t flags{};",
      "  apply(flags);",
      "}",
      "",
    ].join("\n"));
    write(root, "include/util/flags.h", [
      "#pragma once",
      "// most flags are below this line and come from sensors",
      "typedef struct {",
      "  unsigned raw;",
      "} util_flags_t;",
      "/* and another block comment about current math */",
      "",
    ].join("\n"));

    const surfaces = buildInterfaceAuthoritySurfaces({
      workspace: root,
      frontier: frontier(
        "src/main.cpp",
        "// below and most from sensors\nutil_flags_t flags{};\napply(flags);",
      ),
    });

    expect(surfaces.some((surface) => surface.symbol === "util_flags_t")).toBe(true);
    const prose = new Set(["and", "are", "most", "below", "from", "come", "sensors", "about", "current", "math", "values", "the", "this", "line", "another", "block", "comment"]);
    for (const surface of surfaces) {
      expect(prose.has(String(surface.symbol)), `prose symbol served: ${String(surface.symbol)}`).toBe(false);
    }
  });

  it("collapses nested declaration ranges and caps total surfaces", () => {
    const root = workspace();
    const declarations: string[] = [];
    const uses: string[] = [];
    for (let index = 0; index < 24; index++) {
      declarations.push(`typedef struct { int field${index}; } widget_${index}_t;`);
      uses.push(`widget_${index}_t value${index}{};`);
    }
    write(root, "include/gadget/widgets.h", ["#pragma once", ...declarations, ""].join("\n"));
    write(root, "src/gadget.cpp", [
      "#include <gadget/widgets.h>",
      "void build() {",
      ...uses.map((line) => "  " + line),
      "}",
      "",
    ].join("\n"));

    const surfaces = buildInterfaceAuthoritySurfaces({
      workspace: root,
      frontier: frontier("src/gadget.cpp", uses.join("\n")),
    });

    expect(surfaces.length).toBeGreaterThan(0);
    expect(surfaces.length).toBeLessThanOrEqual(INTERFACE_AUTHORITY_MAX_SURFACES);
    const spans = surfaces.map((surface) => String(surface.range).split("-").map(Number) as [number, number]);
    for (let index = 0; index < spans.length; index++) {
      for (let other = 0; other < spans.length; other++) {
        if (index === other || surfaces[index]!.path !== surfaces[other]!.path) continue;
        const strictlyContained = spans[other]![0] <= spans[index]![0]
          && spans[index]![1] <= spans[other]![1]
          && spans[other]![1] - spans[other]![0] > spans[index]![1] - spans[index]![0];
        expect(strictlyContained, `nested range served: ${surfaces[index]!.range} inside ${surfaces[other]!.range}`).toBe(false);
      }
    }
  });

  it("serves an exact declaration from a direct project-local C++ include", () => {
    const root = workspace();
    write(root, "src/control.cpp", [
      "#include <driver/drv_imu.h>",
      "void update() {",
      "  drv_imu_sample_t sample{};",
      "  consume(sample);",
      "}",
      "",
    ].join("\n"));
    write(root, "include/driver/drv_imu.h", [
      "#pragma once",
      "typedef struct {",
      "  float accel[3];",
      "  float gyro[3];",
      "} drv_imu_sample_t;",
      "typedef struct { int unrelated; } unrelated_t;",
      "",
    ].join("\n"));

    const surfaces = buildInterfaceAuthoritySurfaces({
      workspace: root,
      frontier: frontier("src/control.cpp", "drv_imu_sample_t sample{};"),
    });

    expect(surfaces).toEqual([
      expect.objectContaining({
        role: "contract",
        path: "include/driver/drv_imu.h",
        range: "2-5",
        symbol: "drv_imu_sample_t",
        code: expect.stringContaining("drv_imu_sample_t"),
        handle: expect.stringMatching(/^h[0-9a-z]+$/),
      }),
    ]);
    expect(surfaces[0]?.code).not.toContain("unrelated_t");
  });

  it("does not infer authority from an indirect or non-matching header declaration", () => {
    const root = workspace();
    write(root, "src/control.cpp", [
      "#include <driver/drv_imu.h>",
      "void update() { drv_imu_sample_t sample{}; }",
      "",
    ].join("\n"));
    write(root, "include/driver/drv_imu.h", [
      "typedef struct { int ignored; } unrelated_t;",
      "",
    ].join("\n"));

    expect(buildInterfaceAuthoritySurfaces({
      workspace: root,
      frontier: frontier("src/control.cpp", "drv_imu_sample_t sample{};"),
    })).toEqual([]);
  });

  it("keeps the default-off pack unchanged and enriches a flag-on change pack", async () => {
    const makeFixture = (): string => {
      const root = workspace();
      write(root, "src/control.cpp", [
        "#include <driver/drv_imu.h>",
        "void update() {",
        "  drv_imu_sample_t sample{};",
        "  consume(sample);",
        "}",
        "",
      ].join("\n"));
      write(root, "include/driver/drv_imu.h", [
        "typedef struct {",
        "  float accel[3];",
        "  float gyro[3];",
        "} drv_imu_sample_t;",
        "",
      ].join("\n"));
      return root;
    };
    const args = {
      path: "src/control.cpp",
      query: "Change update behavior in the requested source",
      taskProfile: "generic" as const,
    };

    delete process.env["TL_INTERFACE_AUTHORITY"];
    const disabled = await buildTaskPack(args, makeFixture());
    expect(disabled.surfaces.some((surface) => surface.path === "src/control.cpp")).toBe(true);
    expect(disabled.surfaces.some((surface) => surface.path === "include/driver/drv_imu.h")).toBe(false);

    process.env["TL_INTERFACE_AUTHORITY"] = "1";
    const enabled = await buildTaskPack(args, makeFixture());
    expect(enabled.surfaces).toContainEqual(expect.objectContaining({
      role: "contract",
      path: "include/driver/drv_imu.h",
      symbol: "drv_imu_sample_t",
      code: expect.stringContaining("drv_imu_sample_t"),
    }));
  }, 30000);

  it("keeps overflow declarations as honest name-and-handle pointers", () => {
    const root = workspace();
    const includes: string[] = [];
    const uses: string[] = [];
    // 20 candidate declarations, each large enough that the 8 KiB body
    // budget exhausts INSIDE the surface-count cap: bodies stop around ten
    // entries, honest pointers fill the remaining capped slots, and the
    // candidates beyond the cap are dropped entirely.
    for (let index = 0; index < 20; index++) {
      const name = "drv_type_" + String(index).padStart(2, "0") + "_t";
      const header = "driver/" + name + ".h";
      includes.push("#include <" + header + ">");
      uses.push(name + " value_" + String(index) + "{};");
      write(root, "include/" + header, [
        "typedef struct {",
        "  char bytes[768];",
        "  char first_padding_region_with_a_very_long_descriptive_field_name_" + String(index) + "[1024];",
        "  char second_padding_region_with_a_very_long_descriptive_field_name_" + String(index) + "[2048];",
        "  char third_padding_region_with_a_very_long_descriptive_field_name_" + String(index) + "[4096];",
        "  char fourth_padding_region_with_a_very_long_descriptive_field_name_" + String(index) + "[512];",
        "  char fifth_padding_region_with_a_very_long_descriptive_field_name_" + String(index) + "[256];",
        "  unsigned trailing_status_word_" + String(index) + ";",
        "} " + name + ";",
        "",
      ].join("\n"));
    }
    write(root, "src/control.cpp", [...includes, "void update() {", ...uses, "}", ""].join("\n"));

    const surfaces = buildInterfaceAuthoritySurfaces({
      workspace: root,
      frontier: frontier("src/control.cpp", uses.join("\n")),
    });
    const bodies = surfaces.filter((surface) => surface.code !== undefined);
    const overflow = surfaces.filter((surface) => surface.code === undefined);

    expect(Buffer.byteLength(JSON.stringify(bodies), "utf8")).toBeLessThanOrEqual(
      INTERFACE_AUTHORITY_BODY_BUDGET_BYTES,
    );
    expect(overflow.length).toBeGreaterThan(0);
    for (const surface of overflow) {
      expect(surface).toMatchObject({
        role: "contract",
        path: expect.stringMatching(/^include\/driver\/drv_type_\d+_t\.h$/),
        symbol: expect.stringMatching(/^drv_type_\d+_t$/),
        handle: expect.stringMatching(/^h[0-9a-z]+$/),
        remaining_ranges: [surface.range],
        content_completeness: "partial",
      });
      expect(surface.code).toBeUndefined();
      expect(surface.why).toBeUndefined();
    }
  });
});
