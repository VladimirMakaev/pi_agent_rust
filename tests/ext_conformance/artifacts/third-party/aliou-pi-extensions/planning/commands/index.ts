import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { setupListPlansCommand } from "./list-plans";
import { setupSaveAsPlanCommand } from "./save-as-plan";

export function setupPlanningCommands(pi: ExtensionAPI) {
  setupListPlansCommand(pi);
  setupSaveAsPlanCommand(pi);
}
