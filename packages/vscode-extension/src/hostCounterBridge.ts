// B6: starts the host token counter for this window, only when the user named a model
// family in `tokenlighten.hostTokenCounter.modelFamily`. An MCP server cannot learn
// which model a chat is using, and a client name does not say, so the model is never
// guessed: no setting means no socket and no change to the server's environment.
//
// While it runs, reply text the server chooses a spelling for reaches
// `LanguageModelChat.countTokens` for that model. What a provider does with that text
// is up to the provider, which is why this is off unless asked for.

import { randomBytes } from "node:crypto";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { createHostCounterServer } from "./hostCounterServer.js";

let active: { socketPath: string; token: string } | undefined;

/** What the server's environment needs. Empty unless the bridge is running. */
export function hostCounterEnv(): Record<string, string> {
  return active === undefined ? {} : { TL_WIRE_HOST_COUNTER: active.socketPath, TL_WIRE_HOST_COUNTER_TOKEN: active.token };
}

export function startHostCounterBridge(context: vscode.ExtensionContext): void {
  const family = vscode.workspace.getConfiguration("tokenlighten").get<string>("hostTokenCounter.modelFamily", "").trim();
  if (family === "" || active !== undefined) return;
  let model: vscode.LanguageModelChat | undefined;
  const refresh = async (): Promise<void> => {
    try {
      model = (await vscode.lm.selectChatModels({ family }))[0];
    } catch {
      model = undefined;
    }
  };
  void refresh();
  context.subscriptions.push(vscode.lm.onDidChangeChatModels(() => void refresh()));

  const token = randomBytes(24).toString("hex");
  const server: net.Server = createHostCounterServer(token, {
    modelId: () => model?.id,
    count: async (text) => {
      if (model === undefined) throw new Error("no-model");
      const cancellation = new vscode.CancellationTokenSource();
      try {
        return await model.countTokens(text, cancellation.token);
      } finally {
        cancellation.dispose();
      }
    },
  });
  const unique = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\tokenlighten-host-counter-${unique}`
    : path.join(os.tmpdir(), `tokenlighten-host-counter-${unique}.sock`);
  server.on("error", () => { active = undefined; });
  server.listen(socketPath, () => { active = { socketPath, token }; });
  context.subscriptions.push({ dispose: () => { active = undefined; server.close(); } });
}
