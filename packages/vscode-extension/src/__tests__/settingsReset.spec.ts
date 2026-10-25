import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  state, mockShowInformationMessage, mockShowWarningMessage, mockUpdate,
} = vi.hoisted(() => ({
  state: {
    language: "en" as "en" | "ja",
    defaults: {} as Record<string, unknown>,
    user: {} as Record<string, unknown>,
    workspace: {} as Record<string, unknown>,
    failing: new Set<string>(),
  },
  mockShowInformationMessage: vi.fn(),
  mockShowWarningMessage: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (key: string, fallback?: unknown) =>
        state.workspace[key] ?? state.user[key] ?? state.defaults[key] ?? fallback,
      inspect: (key: string) => ({
        key: `tokenlighten.${key}`,
        defaultValue: state.defaults[key],
        globalValue: state.user[key],
        workspaceValue: state.workspace[key],
      }),
      update: mockUpdate,
    })),
  },
  window: {
    showInformationMessage: mockShowInformationMessage,
    showWarningMessage: mockShowWarningMessage,
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
}));
vi.mock("../statusBar.js", () => ({ getDisplayLanguage: () => state.language }));
vi.mock("../extensionUpdater.js", () => ({ installReleaseVsix: vi.fn() }));

import {
  CONFIRM_RESET_SETTING, SETTLED_VERSION_KEY, contributedSettingKeys,
  detectUnsettledUpdate, promptSettingsResetAfterUpdate, registerSettingsResetPrompt,
} from "../settingsReset.js";
import type { ExtensionContext } from "vscode";

const DEFAULTS: Record<string, unknown> = {
  enabled: true,
  "autoUpdate.enabled": true,
  "updateCheck.enabled": true,
  [CONFIRM_RESET_SETTING]: true,
  language: "auto",
  guideProfile: "compact",
  toolSurface: "full",
};

const manifest = (version: string) => ({
  version,
  contributes: {
    configuration: {
      title: "TokenLighten",
      properties: {
        ...Object.fromEntries(Object.entries(DEFAULTS)
          .map(([key, value]) => [`tokenlighten.${key}`, { default: value }])),
        "chat.useAgentsMdFile": { default: true },
      },
    },
  },
});

/** An ExtensionContext whose globalState is a Map, updated synchronously like VS Code's memento. */
function makeContext(version = "0.16.0", stored: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(stored));
  return {
    store,
    extension: { packageJSON: manifest(version) },
    globalState: {
      get: (key: string): unknown => store.get(key),
      keys: () => [...store.keys()],
      update: vi.fn(async (key: string, value: unknown) => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      }),
    },
  };
}
const asContext = (context: ReturnType<typeof makeContext>) => context as unknown as ExtensionContext;
const update = { version: "0.16.0", previous: "0.15.3" };
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("settings reset after an update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.language = "en";
    state.defaults = { ...DEFAULTS };
    state.user = {};
    state.workspace = {};
    state.failing = new Set();
    mockUpdate.mockImplementation(async (key: string, value: unknown, target: number) => {
      if (state.failing.has(key)) throw new Error("settings.json is read-only");
      const scope = target === 1 ? state.user : state.workspace;
      if (value === undefined) delete scope[key];
      else scope[key] = value;
    });
    mockShowInformationMessage.mockResolvedValue(undefined);
    mockShowWarningMessage.mockResolvedValue(undefined);
  });

  it("lists the tokenlighten settings a manifest contributes, in object or array form", () => {
    expect(contributedSettingKeys(manifest("0.16.0"))).toEqual(Object.keys(DEFAULTS));
    expect(contributedSettingKeys({ contributes: { configuration: [
      { properties: { "tokenlighten.language": {} } },
      { properties: { "tokenlighten.toolSurface": {}, "other.setting": {} } },
    ] } })).toEqual(["language", "toolSurface"]);
    expect(contributedSettingKeys(undefined)).toEqual([]);
    expect(contributedSettingKeys({ contributes: {} })).toEqual([]);
  });

  it("covers every setting of the real manifest, which contributes the opt-out in both languages", () => {
    const read = (name: string): string => readFileSync(join(__dirname, "..", "..", name), "utf8");
    const real = JSON.parse(read("package.json")) as {
      contributes: { configuration: { properties: Record<string, unknown> } };
    };
    expect(contributedSettingKeys(real)).toEqual(expect.arrayContaining([
      "enabled", "autoUpdate.enabled", "updateCheck.enabled", CONFIRM_RESET_SETTING,
      "language", "guideProfile", "copilotGuide", "toolSurface",
    ]));
    expect(real.contributes.configuration.properties[`tokenlighten.${CONFIRM_RESET_SETTING}`]).toEqual({
      type: "boolean",
      default: true,
      scope: "application",
      description: `%config.${CONFIRM_RESET_SETTING}%`,
    });
    const english = JSON.parse(read("package.nls.json")) as Record<string, string>;
    const japanese = JSON.parse(read("package.nls.ja.json")) as Record<string, string>;
    expect(english[`config.${CONFIRM_RESET_SETTING}`]).toMatch(/reset your TokenLighten user settings to their default values/);
    expect(english[`config.${CONFIRM_RESET_SETTING}`]).toMatch(/without answering asks again at the next startup/);
    expect(japanese[`config.${CONFIRM_RESET_SETTING}`]).toMatch(/デフォルト値に戻す/);
    expect(japanese[`config.${CONFIRM_RESET_SETTING}`]).toMatch(/次回起動時にもう一度確認/);
  });

  describe("detectUnsettledUpdate", () => {
    it("treats an empty globalState as a first install: settles the version, reports no update", () => {
      const context = makeContext("0.16.0");
      expect(detectUnsettledUpdate(asContext(context))).toBeUndefined();
      expect(context.store.get(SETTLED_VERSION_KEY)).toBe("0.16.0");
    });

    it("recognises an update from a version that kept no record by the state it left, and leaves it unsettled", () => {
      const context = makeContext("0.16.0", { "tokenlighten.mcpSchemaStamp": "stamp" });
      expect(detectUnsettledUpdate(asContext(context))).toEqual({ version: "0.16.0", previous: undefined });
      expect(context.store.has(SETTLED_VERSION_KEY)).toBe(false);
    });

    it("reports an upgrade from an older settled version and leaves it unsettled", () => {
      const context = makeContext("0.16.0", { [SETTLED_VERSION_KEY]: "0.15.3" });
      expect(detectUnsettledUpdate(asContext(context))).toEqual({ version: "0.16.0", previous: "0.15.3" });
      expect(context.store.get(SETTLED_VERSION_KEY)).toBe("0.15.3");
    });

    it.each(["0.16.0", "0.16.1", "not-a-version"])("reports no update after %s, and settles the running version", (previous) => {
      const context = makeContext("0.16.0", { [SETTLED_VERSION_KEY]: previous });
      expect(detectUnsettledUpdate(asContext(context))).toBeUndefined();
      expect(context.store.get(SETTLED_VERSION_KEY)).toBe("0.16.0");
    });

    it("treats a corrupt record as an unknown earlier version instead of throwing", () => {
      const context = makeContext("0.16.0", { [SETTLED_VERSION_KEY]: 15 });
      expect(detectUnsettledUpdate(asContext(context))).toEqual({ version: "0.16.0", previous: undefined });
    });
  });

  describe("promptSettingsResetAfterUpdate", () => {
    it("asks only about user values that differ from the new defaults, listing each one", async () => {
      state.user = { language: "ja", guideProfile: "medium", "autoUpdate.enabled": true };
      state.workspace = { toolSurface: "code" };
      await promptSettingsResetAfterUpdate(asContext(makeContext()), update);
      expect(mockShowInformationMessage).toHaveBeenCalledOnce();
      const [message, ...actions] = mockShowInformationMessage.mock.calls[0] as string[];
      expect(message).toContain("TokenLighten was updated to v0.16.0.");
      expect(message).toContain("Reset your TokenLighten user settings to their default values?");
      expect(message).toContain('tokenlighten.language: "ja" → "auto"');
      expect(message).toContain('tokenlighten.guideProfile: "medium" → "compact"');
      expect(message).not.toContain("autoUpdate");
      expect(message).not.toContain("toolSurface");
      expect(actions).toEqual(["Reset to Defaults", "Keep Current Settings", "Don't Ask Again"]);
    });

    it.each([
      ["no user values", {}],
      ["user values equal to the defaults", { "autoUpdate.enabled": true, language: "auto" }],
    ])("does not ask with %s, even when workspace values differ, and settles the update", async (_label, user) => {
      state.user = { ...user };
      state.workspace = { toolSurface: "code", enabled: false };
      const context = makeContext();
      expect(await promptSettingsResetAfterUpdate(asContext(context), update)).toBe("already-default");
      expect(mockShowInformationMessage).not.toHaveBeenCalled();
      expect(context.store.get(SETTLED_VERSION_KEY)).toBe("0.16.0");
    });

    it("does not ask once the question is turned off, and settles the update", async () => {
      state.user = { language: "ja", [CONFIRM_RESET_SETTING]: false };
      const context = makeContext();
      expect(await promptSettingsResetAfterUpdate(asContext(context), update)).toBe("prompt-disabled");
      expect(mockShowInformationMessage).not.toHaveBeenCalled();
      expect(context.store.get(SETTLED_VERSION_KEY)).toBe("0.16.0");
    });

    it("resets every user value, one equal to its default included, and leaves workspace values alone", async () => {
      state.user = { language: "ja", guideProfile: "medium", "autoUpdate.enabled": true };
      state.workspace = { toolSurface: "code", enabled: false };
      const context = makeContext();
      mockShowInformationMessage.mockResolvedValueOnce("Reset to Defaults");
      expect(await promptSettingsResetAfterUpdate(asContext(context), update)).toBe("reset");
      expect(mockUpdate.mock.calls).toEqual([
        ["autoUpdate.enabled", undefined, 1],
        ["language", undefined, 1],
        ["guideProfile", undefined, 1],
      ]);
      expect(state.user).toEqual({});
      expect(state.workspace).toEqual({ toolSurface: "code", enabled: false });
      expect(mockShowInformationMessage).toHaveBeenLastCalledWith(
        "TokenLighten user settings were reset to their default values.");
      expect(mockShowWarningMessage).not.toHaveBeenCalled();
      expect(context.store.get(SETTLED_VERSION_KEY)).toBe("0.16.0");
    });

    it("skips a value the user removed while the question was open", async () => {
      state.user = { language: "ja", guideProfile: "medium" };
      mockShowInformationMessage.mockImplementationOnce(async () => {
        delete state.user["language"];
        return "Reset to Defaults";
      });
      expect(await promptSettingsResetAfterUpdate(asContext(makeContext()), update)).toBe("reset");
      expect(mockUpdate.mock.calls).toEqual([["guideProfile", undefined, 1]]);
    });

    it("keeps the settings when the user keeps them, and settles the update", async () => {
      state.user = { language: "ja" };
      const context = makeContext();
      mockShowInformationMessage.mockResolvedValueOnce("Keep Current Settings");
      expect(await promptSettingsResetAfterUpdate(asContext(context), update)).toBe("kept");
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(state.user).toEqual({ language: "ja" });
      expect(context.store.get(SETTLED_VERSION_KEY)).toBe("0.16.0");
    });

    it("treats a closed notification as no answer: changes nothing and leaves the update unsettled", async () => {
      state.user = { language: "ja" };
      const context = makeContext("0.16.0", { [SETTLED_VERSION_KEY]: "0.15.3" });
      mockShowInformationMessage.mockResolvedValueOnce(undefined);
      expect(await promptSettingsResetAfterUpdate(asContext(context), update)).toBe("unanswered");
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(state.user).toEqual({ language: "ja" });
      expect(context.store.get(SETTLED_VERSION_KEY)).toBe("0.15.3");
    });

    it("turns the question off for later updates when told not to ask again", async () => {
      state.user = { language: "ja" };
      const context = makeContext();
      mockShowInformationMessage.mockResolvedValueOnce("Don't Ask Again");
      expect(await promptSettingsResetAfterUpdate(asContext(context), update)).toBe("never-ask");
      expect(mockUpdate.mock.calls).toEqual([[CONFIRM_RESET_SETTING, false, 1]]);
      expect(state.user).toEqual({ language: "ja", [CONFIRM_RESET_SETTING]: false });
      expect(context.store.get(SETTLED_VERSION_KEY)).toBe("0.16.0");

      mockShowInformationMessage.mockClear();
      const next = { version: "0.17.0", previous: "0.16.0" };
      expect(await promptSettingsResetAfterUpdate(asContext(makeContext("0.17.0")), next)).toBe("prompt-disabled");
      expect(mockShowInformationMessage).not.toHaveBeenCalled();
    });

    it("reports a setting it could not reset, still resets the others, and settles the answered update", async () => {
      state.user = { language: "ja", guideProfile: "medium" };
      state.failing = new Set(["language"]);
      const context = makeContext();
      mockShowInformationMessage.mockResolvedValueOnce("Reset to Defaults");
      expect(await promptSettingsResetAfterUpdate(asContext(context), update)).toBe("failed");
      expect(state.user).toEqual({ language: "ja" });
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("tokenlighten.language (settings.json is read-only)"));
      expect(mockShowInformationMessage).toHaveBeenCalledOnce();
      expect(context.store.get(SETTLED_VERSION_KEY)).toBe("0.16.0");
    });

    it("reports when the question cannot be turned off, and settles the answered update", async () => {
      state.user = { language: "ja" };
      state.failing = new Set([CONFIRM_RESET_SETTING]);
      const context = makeContext();
      mockShowInformationMessage.mockResolvedValueOnce("Don't Ask Again");
      expect(await promptSettingsResetAfterUpdate(asContext(context), update)).toBe("failed");
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining(`tokenlighten.${CONFIRM_RESET_SETTING}`));
      expect(context.store.get(SETTLED_VERSION_KEY)).toBe("0.16.0");
    });

    it("asks and answers in Japanese", async () => {
      state.language = "ja";
      state.user = { guideProfile: "medium" };
      mockShowInformationMessage.mockResolvedValueOnce("デフォルト値に戻す");
      expect(await promptSettingsResetAfterUpdate(asContext(makeContext()), update)).toBe("reset");
      expect(mockShowInformationMessage).toHaveBeenNthCalledWith(1,
        expect.stringContaining("TokenLightenのユーザー設定をデフォルト値に戻しますか？"),
        "デフォルト値に戻す", "現在の設定を維持", "今後は確認しない");
      expect(mockShowInformationMessage).toHaveBeenLastCalledWith(
        "TokenLightenのユーザー設定をデフォルト値に戻しました。");
      expect(state.user).toEqual({});
    });
  });

  describe("registerSettingsResetPrompt", () => {
    it("asks at every activation until answered, then not again for that version", async () => {
      state.user = { language: "ja" };
      const context = makeContext("0.16.0", { [SETTLED_VERSION_KEY]: "0.15.3" });
      // First activation: the notification is closed without an answer.
      registerSettingsResetPrompt(asContext(context));
      await vi.waitFor(() => expect(mockShowInformationMessage).toHaveBeenCalledTimes(1));
      await flush();
      expect(context.store.get(SETTLED_VERSION_KEY)).toBe("0.15.3");

      // The next activation asks again, and this time the user answers.
      mockShowInformationMessage.mockResolvedValueOnce("Keep Current Settings");
      registerSettingsResetPrompt(asContext(context));
      await vi.waitFor(() => expect(context.store.get(SETTLED_VERSION_KEY)).toBe("0.16.0"));
      expect(mockShowInformationMessage).toHaveBeenCalledTimes(2);

      // Answered: later activations of the same version ask nothing.
      registerSettingsResetPrompt(asContext(context));
      await flush();
      expect(mockShowInformationMessage).toHaveBeenCalledTimes(2);
    });

    it("asks again at the next activation when the window closed with the question still open", async () => {
      state.user = { language: "ja" };
      const context = makeContext("0.16.0", { [SETTLED_VERSION_KEY]: "0.15.3" });
      // A closing window takes its extension host along: the question never resolves.
      mockShowInformationMessage.mockImplementationOnce(() => new Promise(() => {}));
      registerSettingsResetPrompt(asContext(context));
      await flush();
      expect(mockShowInformationMessage).toHaveBeenCalledTimes(1);
      expect(context.store.get(SETTLED_VERSION_KEY)).toBe("0.15.3");

      registerSettingsResetPrompt(asContext(context));
      await vi.waitFor(() => expect(mockShowInformationMessage).toHaveBeenCalledTimes(2));
    });

    it("asks about the newer version when another update arrives before an answer", async () => {
      state.user = { language: "ja" };
      const context = makeContext("0.16.0", { [SETTLED_VERSION_KEY]: "0.15.3" });
      registerSettingsResetPrompt(asContext(context));
      await vi.waitFor(() => expect(mockShowInformationMessage).toHaveBeenCalledTimes(1));
      await flush();

      const later = makeContext("0.17.0", Object.fromEntries(context.store));
      registerSettingsResetPrompt(asContext(later));
      await vi.waitFor(() => expect(mockShowInformationMessage).toHaveBeenCalledTimes(2));
      expect(mockShowInformationMessage.mock.calls[1]?.[0]).toContain("updated to v0.17.0");
    });

    it("settles an unanswered update once the question has been turned off in the meantime", async () => {
      state.user = { language: "ja" };
      const context = makeContext("0.16.0", { [SETTLED_VERSION_KEY]: "0.15.3" });
      registerSettingsResetPrompt(asContext(context));
      await vi.waitFor(() => expect(mockShowInformationMessage).toHaveBeenCalledTimes(1));
      await flush();

      state.user[CONFIRM_RESET_SETTING] = false;
      registerSettingsResetPrompt(asContext(context));
      await vi.waitFor(() => expect(context.store.get(SETTLED_VERSION_KEY)).toBe("0.16.0"));
      expect(mockShowInformationMessage).toHaveBeenCalledTimes(1);
    });

    it("asks nothing on a first install, even with customized settings Settings Sync brought along", async () => {
      state.user = { language: "ja" };
      registerSettingsResetPrompt(asContext(makeContext("0.16.0")));
      await flush();
      expect(mockShowInformationMessage).not.toHaveBeenCalled();
    });

    it("never throws into activation, whether the state or the question fails", async () => {
      state.user = { language: "ja" };
      const broken = makeContext();
      broken.globalState.get = () => {
        throw new Error("state unavailable");
      };
      expect(() => registerSettingsResetPrompt(asContext(broken))).not.toThrow();

      mockShowInformationMessage.mockRejectedValueOnce(new Error("window closed"));
      const context = makeContext("0.16.0", { [SETTLED_VERSION_KEY]: "0.15.3" });
      expect(() => registerSettingsResetPrompt(asContext(context))).not.toThrow();
      await flush();
      expect(mockShowInformationMessage).toHaveBeenCalledOnce();
      expect(mockUpdate).not.toHaveBeenCalled();
      // A question that failed to show stays unsettled for the next activation.
      expect(context.store.get(SETTLED_VERSION_KEY)).toBe("0.15.3");
    });
  });
});
