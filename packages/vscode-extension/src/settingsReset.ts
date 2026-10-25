import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import { getDisplayLanguage } from "./statusBar.js";
import { isVersionNewer } from "./updateChecker.js";

// After TokenLighten is updated (by the automatic updater or by hand), asks
// whether to reset the user's TokenLighten settings to the defaults the new
// version ships, until the user answers once for that version: a notification
// closed unanswered, or still open when its window closes, asks again at the
// next activation. A user value keeps a setting where it was even when a
// release changes its default, so without the question such a user never
// picks up new defaults. Only user (global) values are touched: workspace and
// folder values belong to the project and may be shared.

const SECTION = "tokenlighten";

/**
 * `context.globalState` key: the newest version whose question is settled,
 * that is answered or not needed (a first install, nothing to reset, or the
 * question turned off).
 */
export const SETTLED_VERSION_KEY = "tokenlighten.settingsReset.settledVersion";

/** Setting, within the `tokenlighten` section, that turns the question off. */
export const CONFIRM_RESET_SETTING = "confirmResetOnUpdate";

export interface ExtensionUpdate {
  /** The running, newly installed version. */
  version: string;
  /** The last settled version; undefined when the earlier version kept no record. */
  previous: string | undefined;
}

export type SettingsResetOutcome =
  | "prompt-disabled"
  | "already-default"
  | "unanswered"
  | "kept"
  | "reset"
  | "never-ask"
  | "failed";

interface CustomizedSetting {
  /** Key within the `tokenlighten` section. */
  key: string;
  value: unknown;
  defaultValue: unknown;
}

/** The `tokenlighten.*` settings a manifest contributes, as keys within the section. */
export function contributedSettingKeys(packageJson: unknown): string[] {
  const configuration = (packageJson as { contributes?: { configuration?: unknown } } | undefined)
    ?.contributes?.configuration;
  const keys: string[] = [];
  for (const entry of Array.isArray(configuration) ? configuration : [configuration]) {
    const properties = (entry as { properties?: unknown } | undefined)?.properties;
    if (!properties || typeof properties !== "object") continue;
    for (const id of Object.keys(properties)) {
      if (id.startsWith(`${SECTION}.`)) keys.push(id.slice(SECTION.length + 1));
    }
  }
  return keys;
}

/** User (global) values that differ from the defaults the running version declares. */
function customizedUserSettings(keys: readonly string[]): CustomizedSetting[] {
  const config = vscode.workspace.getConfiguration(SECTION);
  const customized: CustomizedSetting[] = [];
  for (const key of keys) {
    const inspected = config.inspect(key);
    if (inspected?.globalValue === undefined) continue;
    if (isDeepStrictEqual(inspected.globalValue, inspected.defaultValue)) continue;
    customized.push({ key, value: inspected.globalValue, defaultValue: inspected.defaultValue });
  }
  return customized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Removes every user (global) value of the given settings, including one that
 * equals today's default: it would pin the setting when a later release
 * changes that default. Returns the settings that could not be reset.
 */
async function resetUserSettings(keys: readonly string[]): Promise<Array<{ key: string; error: string }>> {
  const config = vscode.workspace.getConfiguration(SECTION);
  const failures: Array<{ key: string; error: string }> = [];
  // One write at a time: every update rewrites the same user settings.json.
  for (const key of keys) {
    if (config.inspect(key)?.globalValue === undefined) continue;
    try {
      await config.update(key, undefined, vscode.ConfigurationTarget.Global);
    } catch (error) {
      failures.push({ key, error: errorMessage(error) });
    }
  }
  return failures;
}

function settle(context: vscode.ExtensionContext, version: string): void {
  void context.globalState.update(SETTLED_VERSION_KEY, version).then(undefined, () => {});
}

/**
 * Returns the update whose question is not settled yet. With nothing to ask
 * about (a first install, the same version again, or an older one) the running
 * version is settled at once; an update stays unsettled, and is asked about at
 * every activation, until promptSettingsResetAfterUpdate settles it. Versions
 * before this one kept no record, so without one any state an earlier
 * activation left in `globalState` (the MCP schema stamp, for instance) marks
 * an update, while an empty `globalState` is a first install, which gets no
 * question even when Settings Sync brought customized settings along. That is
 * why activate() calls this before any other module writes `globalState`.
 */
export function detectUnsettledUpdate(context: vscode.ExtensionContext): ExtensionUpdate | undefined {
  const packageJson = context.extension.packageJSON as Record<string, unknown>;
  const version = typeof packageJson["version"] === "string" ? packageJson["version"] : "";
  if (!version) return undefined;
  const recorded = context.globalState.get<unknown>(SETTLED_VERSION_KEY);
  const previous = typeof recorded === "string" ? recorded : undefined;
  if (previous === version) return undefined;
  const activatedBefore = recorded !== undefined || context.globalState.keys().length > 0;
  if (activatedBefore && (previous === undefined || isVersionNewer(version, previous))) {
    return { version, previous };
  }
  settle(context, version);
  return undefined;
}

/**
 * Asks whether to reset the user's customized TokenLighten settings and acts
 * on the answer. The update is settled once answered or when there is nothing
 * to ask; a notification closed without an answer leaves it unsettled.
 */
export async function promptSettingsResetAfterUpdate(
  context: vscode.ExtensionContext,
  update: ExtensionUpdate,
): Promise<SettingsResetOutcome> {
  const config = vscode.workspace.getConfiguration(SECTION);
  if (!config.get<boolean>(CONFIRM_RESET_SETTING, true)) {
    settle(context, update.version);
    return "prompt-disabled";
  }
  const keys = contributedSettingKeys(context.extension.packageJSON);
  const customized = customizedUserSettings(keys);
  if (customized.length === 0) {
    settle(context, update.version);
    return "already-default";
  }

  const ja = getDisplayLanguage() === "ja";
  const version = /^v/i.test(update.version) ? update.version : `v${update.version}`;
  const changed = customized
    .map(({ key, value, defaultValue }) =>
      `${SECTION}.${key}: ${JSON.stringify(value)} → ${JSON.stringify(defaultValue)}`)
    .join(ja ? "、" : ", ");
  const resetAction = ja ? "デフォルト値に戻す" : "Reset to Defaults";
  const keepAction = ja ? "現在の設定を維持" : "Keep Current Settings";
  const neverAction = ja ? "今後は確認しない" : "Don't Ask Again";
  const question = ja
    ? `TokenLighten ${version} に更新されました。TokenLightenのユーザー設定をデフォルト値に戻しますか？ デフォルト値から変更されている設定: ${changed}。ワークスペースとフォルダーの設定は変更しません。`
    : `TokenLighten was updated to ${version}. Reset your TokenLighten user settings to their default values? Changed from the default: ${changed}. Workspace and folder settings are not changed.`;
  const choice = await vscode.window.showInformationMessage(question, resetAction, keepAction, neverAction);
  // Closing the notification is no answer, so the next activation asks again.
  // A window closed with the question still open never resumes here at all.
  if (choice === undefined) return "unanswered";
  settle(context, update.version);

  if (choice === neverAction) {
    try {
      await config.update(CONFIRM_RESET_SETTING, false, vscode.ConfigurationTarget.Global);
    } catch (error) {
      void vscode.window.showWarningMessage(ja
        ? `TokenLightenは確認をオフにできませんでした（${SECTION}.${CONFIRM_RESET_SETTING}）: ${errorMessage(error)}`
        : `TokenLighten could not turn the question off (${SECTION}.${CONFIRM_RESET_SETTING}): ${errorMessage(error)}`);
      return "failed";
    }
    return "never-ask";
  }
  if (choice !== resetAction) return "kept";

  const failures = await resetUserSettings(keys);
  if (failures.length > 0) {
    const detail = failures
      .map(({ key, error }) => `${SECTION}.${key} (${error})`)
      .join(ja ? "、" : ", ");
    void vscode.window.showWarningMessage(ja
      ? `TokenLightenは次のユーザー設定をデフォルト値に戻せませんでした: ${detail}`
      : `TokenLighten could not reset these user settings to their default values: ${detail}`);
    return "failed";
  }
  void vscode.window.showInformationMessage(ja
    ? "TokenLightenのユーザー設定をデフォルト値に戻しました。"
    : "TokenLighten user settings were reset to their default values.");
  return "reset";
}

/**
 * After an update, asks whether to reset the user's TokenLighten settings to
 * the new defaults, at each activation until the question is settled.
 * activate() calls this first; see detectUnsettledUpdate.
 */
export function registerSettingsResetPrompt(context: vscode.ExtensionContext): void {
  try {
    const update = detectUnsettledUpdate(context);
    if (!update) return;
    void promptSettingsResetAfterUpdate(context, update).catch(() => {
      // Best-effort, like the update check: the question must never fail
      // activation. A question that failed to show stays unsettled, so the
      // next activation asks again.
    });
  } catch {
    // An unreadable manifest or state only skips the question.
  }
}
