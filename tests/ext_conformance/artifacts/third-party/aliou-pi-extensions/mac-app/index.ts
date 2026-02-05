import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { setupMacAppTools } from "./tools";

export default function (pi: ExtensionAPI) {
  setupMacAppTools(pi);
}
