import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { setupMacAppActionTool } from "./action-tool";
import { setupMacAppClickTool } from "./click-tool";
import { setupMacAppFocusTool } from "./focus-tool";
import { setupMacAppQueryTool } from "./query-tool";
import { setupMacAppScrollToTool } from "./scroll-to-tool";
import { setupMacAppTypeTool } from "./type-tool";

export function setupMacAppTools(pi: ExtensionAPI) {
  setupMacAppQueryTool(pi);
  setupMacAppClickTool(pi);
  setupMacAppTypeTool(pi);
  setupMacAppScrollToTool(pi);
  setupMacAppActionTool(pi);
  setupMacAppFocusTool(pi);
}
