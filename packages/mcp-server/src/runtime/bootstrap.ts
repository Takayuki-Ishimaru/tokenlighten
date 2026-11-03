import { ALL_TOOLS, resolveWorkspaceRoot } from "../serverOwned/read-admission2.js";
import { dispatchPropertiesFor, advertisedPropertiesFor } from "../serverOwned/tool-schema.js";
import { checkCwdOrRefuse, workspaceRoutingRefusal } from "../serverOwned/workspace-routing.js";
import { ALLOW_WRITE } from "./config.js";
import { setAdvertisedToolNames } from "../protocol/advertisedTools.js";
import { setEmittedToolCallValidator } from "../protocol/refusal.js";
import { requestShapeRefusal } from "../validation/requestShape.js";
import { installWorkspaceGuardStack } from "../write/guardedWorkspace.js";

setAdvertisedToolNames(ALL_TOOLS.filter((entry) => entry.enabled).map((entry) => entry.name));

setEmittedToolCallValidator((call) => {
  const definition = ALL_TOOLS.find((entry) => entry.name === call.tool);
  if (definition === undefined) return false;
  const argumentsRecord = call.arguments as Record<string, unknown>;
  // Producers are migrated independently: older ones reach this pre-wire gate
  // in the accepted dispatch spelling, while newer ones already author the
  // canonical public spelling. The finalizer canonicalizes both immediately
  // afterwards. Mirror inbound acceptance here so neither valid generation is
  // discarded before it can reach that projection, while an unknown field is
  // still rejected by both closed schemas.
  return requestShapeRefusal(call.tool, dispatchPropertiesFor(call.tool), argumentsRecord) === null
    || requestShapeRefusal(call.tool, advertisedPropertiesFor(call.tool), argumentsRecord) === null;
});

installWorkspaceGuardStack({
  checkCwd: (rawCwd, fallbackRoot) => checkCwdOrRefuse(rawCwd, fallbackRoot),
  routing: (toolName, args) => workspaceRoutingRefusal(toolName, args),
  resolve: (cwd, fallbackRoot) => resolveWorkspaceRoot(cwd, fallbackRoot),
  writesEnabled: () => ALLOW_WRITE,
});
