import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerSystemPromptCommand } from "./system-prompt";
import { registerThemeCommand } from "./theme";

export function registerCommands(pi: ExtensionAPI) {
  registerThemeCommand(pi);
  registerSystemPromptCommand(pi);
}
