import { describe, it, expect } from "vitest";
import { classifySurface } from "../util/impact.js";

describe("classifySurface — firmware/C++ paths", () => {
  it("classifies include/ headers with no recognized subdir as contract", () => {
    expect(classifySurface("include/app/types.hpp")).toBe("contract");
    expect(classifySurface("firmware/include/estimator.h")).toBe("contract");
    // A truly top-level public header (no domain/api/config subdir) still
    // falls through to contract even after the 2b/2c/2d reorder.
    expect(classifySurface("include/acmectl/config.hpp")).toBe("contract");
  });

  it("classifies headers under generic structural subdirs, not project vocabulary", () => {
    // C1: the include/inc → contract rule now runs AFTER the domain/api/config
    // subdir checks, so a header living under a known subdir classifies by
    // what it is. Previously these collapsed to "contract" because the
    // include/ rule ran first, hiding them from a firmware fix pack.
    expect(classifySurface("include/control/gain_controller.hpp")).toBe("domain");
    expect(classifySurface("firmware/include/mode/gear_manager.hpp")).toBe("domain");
    expect(classifySurface("include/protocol/foo.hpp")).toBe("api");
    expect(classifySurface("include/telemetry/foo.hpp")).toBe("contract");
    expect(classifySurface("firmware/include/driver/drv_motor.h")).toBe("config");
  });

  it("keeps project-specific subsystem names neutral while generic logic directories remain domain", () => {
    expect(classifySurface("firmware/src/estimator/qkf.cpp")).toBe("unknown");
    expect(classifySurface("src/control/pid.cpp")).toBe("domain");
    expect(classifySurface("src/failsafe/handler.cpp")).toBe("domain");
  });

  it("classifies structural call-boundary names and generic protocol/transport directories as api", () => {
    expect(classifySurface("firmware/src/telemetry/reporter.cpp")).toBe("api");
    expect(classifySurface("firmware/src/arbitrary/reporter.cpp")).toBe("api");
    expect(classifySurface("firmware/src/telemetry/foo.cpp")).toBe("unknown");
    expect(classifySurface("src/protocol/udplink.cpp")).toBe("api");
    expect(classifySurface("src/transport/serial.cpp")).toBe("api");
  });

  it("classifies driver/hal/platform as config", () => {
    expect(classifySurface("src/driver/spi.cpp")).toBe("config");
    expect(classifySurface("firmware/hal/gpio.c")).toBe("config");
    expect(classifySurface("src/platform/stm32.cpp")).toBe("config");
  });

  it("classifies native test files as test", () => {
    expect(classifySurface("test/test_qkf.cpp")).toBe("test");
    expect(classifySurface("tests/unit/pid_test.cpp")).toBe("test");
  });

  it("does not regress existing web paths", () => {
    expect(classifySurface("src/components/Button.tsx")).toBe("ui");
    expect(classifySurface("packages/types/src/mcp.ts")).toBe("contract");
    expect(classifySurface("src/services/auth.ts")).toBe("api");
    expect(classifySurface("src/styles/theme.css")).toBe("style");
  });
});
