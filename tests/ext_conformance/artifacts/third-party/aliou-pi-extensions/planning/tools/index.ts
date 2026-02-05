/**
 * Planning extension tools
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createAskUserTool } from "./ask-user";

export function setupPlanningTools(pi: ExtensionAPI) {
  pi.registerTool(createAskUserTool(pi));
}
