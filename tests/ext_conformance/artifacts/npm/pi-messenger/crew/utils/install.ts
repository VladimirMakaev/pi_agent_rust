/**
 * Crew - Agent & Skill Installer
 * 
 * Copies crew agent definitions and skills from extension source to user directories.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// Resolve paths relative to this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Agents: crew/agents/ -> ~/.pi/agent/agents/
const SOURCE_AGENTS_DIR = path.resolve(__dirname, "..", "agents");
const TARGET_AGENTS_DIR = path.join(homedir(), ".pi", "agent", "agents");

// Skills: skills/ -> ~/.pi/agent/skills/
const SOURCE_SKILLS_DIR = path.resolve(__dirname, "..", "..", "skills");
const TARGET_SKILLS_DIR = path.join(homedir(), ".pi", "agent", "skills");

// List of crew agents to install
const CREW_AGENTS = [
  "crew-planner.md",
  "crew-interview-generator.md",
  "crew-plan-sync.md",
  "crew-worker.md",
  "crew-reviewer.md",
];

// Agents removed in the planning redesign (scouts + gap-analyst replaced by single planner)
const DEPRECATED_AGENTS = [
  "crew-repo-scout.md",
  "crew-practice-scout.md",
  "crew-docs-scout.md",
  "crew-web-scout.md",
  "crew-github-scout.md",
  "crew-gap-analyst.md",
];

// List of skills to install (directory names)
const CREW_SKILLS = [
  "pi-messenger-crew",
];

export interface InstallResult {
  installed: string[];
  updated: string[];
  skipped: string[];
  errors: string[];
  targetDir: string;
}

/**
 * Check if an agent needs updating by comparing modification times.
 */
function needsUpdate(sourcePath: string, targetPath: string): boolean {
  if (!fs.existsSync(targetPath)) return true;
  
  try {
    const sourceStat = fs.statSync(sourcePath);
    const targetStat = fs.statSync(targetPath);
    return sourceStat.mtimeMs > targetStat.mtimeMs;
  } catch {
    return true;
  }
}

/**
 * Check which agents are missing or need updating.
 */
export function checkAgentStatus(): { missing: string[]; outdated: string[]; current: string[] } {
  const missing: string[] = [];
  const outdated: string[] = [];
  const current: string[] = [];

  for (const agent of CREW_AGENTS) {
    const sourcePath = path.join(SOURCE_AGENTS_DIR, agent);
    const targetPath = path.join(TARGET_AGENTS_DIR, agent);

    if (!fs.existsSync(sourcePath)) {
      // Source doesn't exist - skip
      continue;
    }

    if (!fs.existsSync(targetPath)) {
      missing.push(agent);
    } else if (needsUpdate(sourcePath, targetPath)) {
      outdated.push(agent);
    } else {
      current.push(agent);
    }
  }

  return { missing, outdated, current };
}

/**
 * Install or update crew agents.
 * 
 * @param force - If true, overwrite even if target is newer
 */
export function installAgents(force: boolean = false): InstallResult {
  const result: InstallResult = {
    installed: [],
    updated: [],
    skipped: [],
    errors: [],
    targetDir: TARGET_AGENTS_DIR,
  };

  // Ensure target directory exists
  if (!fs.existsSync(TARGET_AGENTS_DIR)) {
    try {
      fs.mkdirSync(TARGET_AGENTS_DIR, { recursive: true });
    } catch (err) {
      result.errors.push(`Failed to create directory: ${TARGET_AGENTS_DIR}`);
      return result;
    }
  }

  for (const agent of CREW_AGENTS) {
    const sourcePath = path.join(SOURCE_AGENTS_DIR, agent);
    const targetPath = path.join(TARGET_AGENTS_DIR, agent);

    // Check source exists
    if (!fs.existsSync(sourcePath)) {
      result.errors.push(`Source not found: ${agent}`);
      continue;
    }

    // Check if we need to copy
    const targetExists = fs.existsSync(targetPath);
    const shouldUpdate = force || needsUpdate(sourcePath, targetPath);

    if (!shouldUpdate) {
      result.skipped.push(agent);
      continue;
    }

    // Copy the file
    try {
      fs.copyFileSync(sourcePath, targetPath);
      if (targetExists) {
        result.updated.push(agent);
      } else {
        result.installed.push(agent);
      }
    } catch (err) {
      result.errors.push(`Failed to copy ${agent}: ${err}`);
    }
  }

  return result;
}

/**
 * Remove deprecated agent files from the target directory.
 * Runs on every ensureAgentsInstalled call (cheap: a few existsSync calls).
 */
function cleanupDeprecatedAgents(): void {
  for (const agent of DEPRECATED_AGENTS) {
    const targetPath = path.join(TARGET_AGENTS_DIR, agent);
    try {
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    } catch {
      // Best effort
    }
  }
}

/**
 * Uninstall crew agents (remove from target directory).
 * Also removes any deprecated agents that may still be lingering.
 */
export function uninstallAgents(): { removed: string[]; notFound: string[]; errors: string[] } {
  const removed: string[] = [];
  const notFound: string[] = [];
  const errors: string[] = [];

  const allAgents = [...CREW_AGENTS, ...DEPRECATED_AGENTS];
  for (const agent of allAgents) {
    const targetPath = path.join(TARGET_AGENTS_DIR, agent);

    if (!fs.existsSync(targetPath)) {
      notFound.push(agent);
      continue;
    }

    try {
      fs.unlinkSync(targetPath);
      removed.push(agent);
    } catch (err) {
      errors.push(`Failed to remove ${agent}: ${err}`);
    }
  }

  return { removed, notFound, errors };
}

/**
 * Ensure agents are installed (auto-install if missing).
 * Returns true if all agents are available.
 */
export function ensureAgentsInstalled(): boolean {
  cleanupDeprecatedAgents();

  const status = checkAgentStatus();
  
  if (status.missing.length === 0 && status.outdated.length === 0) {
    return true;
  }

  const result = installAgents();
  return result.errors.length === 0;
}

// =============================================================================
// Skills Installation
// =============================================================================

export interface SkillInstallResult {
  installed: string[];
  updated: string[];
  skipped: string[];
  errors: string[];
  targetDir: string;
}

/**
 * Check if a skill directory needs updating.
 */
function skillNeedsUpdate(sourceDir: string, targetDir: string): boolean {
  if (!fs.existsSync(targetDir)) return true;
  
  const skillFile = path.join(sourceDir, "SKILL.md");
  const targetFile = path.join(targetDir, "SKILL.md");
  
  return needsUpdate(skillFile, targetFile);
}

/**
 * Check which skills are missing or need updating.
 */
export function checkSkillStatus(): { missing: string[]; outdated: string[]; current: string[] } {
  const missing: string[] = [];
  const outdated: string[] = [];
  const current: string[] = [];

  for (const skill of CREW_SKILLS) {
    const sourceDir = path.join(SOURCE_SKILLS_DIR, skill);
    const targetDir = path.join(TARGET_SKILLS_DIR, skill);

    if (!fs.existsSync(sourceDir)) {
      continue;
    }

    if (!fs.existsSync(targetDir)) {
      missing.push(skill);
    } else if (skillNeedsUpdate(sourceDir, targetDir)) {
      outdated.push(skill);
    } else {
      current.push(skill);
    }
  }

  return { missing, outdated, current };
}

/**
 * Install or update skills.
 */
export function installSkills(force: boolean = false): SkillInstallResult {
  const result: SkillInstallResult = {
    installed: [],
    updated: [],
    skipped: [],
    errors: [],
    targetDir: TARGET_SKILLS_DIR,
  };

  // Ensure target directory exists
  if (!fs.existsSync(TARGET_SKILLS_DIR)) {
    try {
      fs.mkdirSync(TARGET_SKILLS_DIR, { recursive: true });
    } catch (err) {
      result.errors.push(`Failed to create directory: ${TARGET_SKILLS_DIR}`);
      return result;
    }
  }

  for (const skill of CREW_SKILLS) {
    const sourceDir = path.join(SOURCE_SKILLS_DIR, skill);
    const targetDir = path.join(TARGET_SKILLS_DIR, skill);

    if (!fs.existsSync(sourceDir)) {
      result.errors.push(`Source not found: ${skill}`);
      continue;
    }

    const targetExists = fs.existsSync(targetDir);
    const shouldUpdate = force || skillNeedsUpdate(sourceDir, targetDir);

    if (!shouldUpdate) {
      result.skipped.push(skill);
      continue;
    }

    try {
      // Create target directory
      if (!targetExists) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // Copy all files from skill directory
      const files = fs.readdirSync(sourceDir);
      for (const file of files) {
        const srcFile = path.join(sourceDir, file);
        const dstFile = path.join(targetDir, file);
        if (fs.statSync(srcFile).isFile()) {
          fs.copyFileSync(srcFile, dstFile);
        }
      }

      if (targetExists) {
        result.updated.push(skill);
      } else {
        result.installed.push(skill);
      }
    } catch (err) {
      result.errors.push(`Failed to copy ${skill}: ${err}`);
    }
  }

  return result;
}

/**
 * Uninstall skills.
 */
export function uninstallSkills(): { removed: string[]; notFound: string[]; errors: string[] } {
  const removed: string[] = [];
  const notFound: string[] = [];
  const errors: string[] = [];

  for (const skill of CREW_SKILLS) {
    const targetDir = path.join(TARGET_SKILLS_DIR, skill);

    if (!fs.existsSync(targetDir)) {
      notFound.push(skill);
      continue;
    }

    try {
      fs.rmSync(targetDir, { recursive: true });
      removed.push(skill);
    } catch (err) {
      errors.push(`Failed to remove ${skill}: ${err}`);
    }
  }

  return { removed, notFound, errors };
}

/**
 * Ensure skills are installed (auto-install if missing).
 */
export function ensureSkillsInstalled(): boolean {
  const status = checkSkillStatus();
  
  if (status.missing.length === 0 && status.outdated.length === 0) {
    return true;
  }

  const result = installSkills();
  return result.errors.length === 0;
}
