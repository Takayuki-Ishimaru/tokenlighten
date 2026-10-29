import { describe, expect, it } from "vitest";
import { splitCompileCommand } from "../features/task-pack/cIncludes.js";

describe("compile command path and quote splitting", () => {
  it.each(["-I", "-isystem", "-iquote", "-idirafter", "/I", "-external:I", "-imsvc"])("preserves native paths attached to %s", (flag) => {
    expect(splitCompileCommand(String.raw`cc ${flag}C:\new\test -c C:\src\unit.cpp`, true))
      .toEqual(["cc", flag + String.raw`C:\new\test`, "-c", String.raw`C:\src\unit.cpp`]);
  });

  it("preserves separated and double-quoted native include paths", () => {
    expect(splitCompileCommand(String.raw`"C:\Program Files\cc.exe" -I C:\sdk\include -isystem "C:\Program Files\sdk\include"`, true))
      .toEqual([String.raw`C:\Program Files\cc.exe`, "-I", String.raw`C:\sdk\include`, "-isystem", String.raw`C:\Program Files\sdk\include`]);
  });

  it("handles paired backslashes before the closing native quote", () => {
    expect(splitCompileCommand(String.raw`cc -I"C:\sdk\\" -c x.cpp`, true))
      .toEqual(["cc", "-I" + "C:\\sdk\\", "-c", "x.cpp"]);
  });

  it("preserves a native UNC path", () => {
    expect(splitCompileCommand(String.raw`cc -I\\server\share\include x.cpp`, true))
      .toEqual(["cc", "-I" + String.raw`\\server\share\include`, "x.cpp"]);
  });

  it("retains mixed separators and drive-relative paths on Windows", () => {
    expect(splitCompileCommand(String.raw`cc -IC:/sdk\include -I C:relative\include`, true))
      .toEqual(["cc", String.raw`-IC:/sdk\include`, "-I", String.raw`C:relative\include`]);
  });

  it("keeps an escaped quote inside a native quoted word", () => {
    expect(splitCompileCommand(String.raw`cc -I"C:\sdk\"quoted" x.cpp`, true))
      .toEqual(["cc", '-IC:\\sdk"quoted', "x.cpp"]);
  });

  it("uses POSIX escapes for unquoted drive-shaped words outside Windows", () => {
    expect(splitCompileCommand(String.raw`cc -IC:\sdk\include`, false)).toEqual(["cc", "-IC:sdkinclude"]);
  });

  it.each([false, true])("retains shell escaping without a native path prefix (windows=%s)", (windows) => {
    expect(splitCompileCommand(String.raw`cc -I../with\ space -I 'literal\path' -DNAME=\"value\"`, windows))
      .toEqual(["cc", "-I../with space", "-I", String.raw`literal\path`, '-DNAME="value"']);
    expect(splitCompileCommand(String.raw`cc -I"../with\path" -I"../with space"`, windows))
      .toEqual(["cc", String.raw`-I../with\path`, "-I../with space"]);
    expect(splitCompileCommand("cc -I foo\\\nbar", windows)).toEqual(["cc", "-I", "foobar"]);
  });
});
