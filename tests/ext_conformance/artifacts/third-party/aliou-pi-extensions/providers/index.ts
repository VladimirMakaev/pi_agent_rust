import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { setupUsageCommands } from "./commands";
import { setupUsageHooks } from "./hooks";

export default function providersExtension(pi: ExtensionAPI): void {
  setupUsageCommands(pi);
  setupUsageHooks(pi);
}
