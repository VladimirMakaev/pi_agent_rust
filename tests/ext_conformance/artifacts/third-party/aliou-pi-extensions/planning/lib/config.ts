/**
 * Planning extension configuration
 *
 * Settings are loaded from ~/.pi/agent/extensions/planning.json
 * No local fallback - must be configured globally.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const GLOBAL_CONFIG_PATH = resolve(
  homedir(),
  ".pi/agent/extensions/planning.json",
);

export interface PlanningConfig {
  /** Directory where archived plans are stored (should be a git repo) */
  archiveDir?: string;
}

class ConfigLoader {
  private config: PlanningConfig | null = null;

  async load(): Promise<void> {
    this.config = await this.loadConfigFile(GLOBAL_CONFIG_PATH);
  }

  private async loadConfigFile(path: string): Promise<PlanningConfig | null> {
    try {
      const content = await readFile(path, "utf-8");
      return JSON.parse(content) as PlanningConfig;
    } catch {
      return null;
    }
  }

  getConfig(): PlanningConfig {
    return this.config ?? {};
  }

  hasConfig(): boolean {
    return this.config !== null;
  }

  async save(config: PlanningConfig): Promise<void> {
    await mkdir(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    await writeFile(
      GLOBAL_CONFIG_PATH,
      `${JSON.stringify(config, null, 2)}\n`,
      "utf-8",
    );
    this.config = config;
  }
}

export const configLoader = new ConfigLoader();
