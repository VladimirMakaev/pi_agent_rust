import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { _test, discoverResources, resolveBoundary } from "../extensions/index.js";

describe("pi-ancestor-discovery helpers", () => {
	it("resolves boundary aliases", () => {
		expect(resolveBoundary("home", process.cwd())).toBe(homedir());
		expect(resolveBoundary("~", process.cwd())).toBe(homedir());
		expect(resolveBoundary("root", process.cwd())).toBe(resolve("/"));
		expect(resolveBoundary("/", process.cwd())).toBe(resolve("/"));
	});

	it("discovers ancestor skills paths closest-first", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-ancestor-"));
		const level1 = join(base, "level1");
		const level2 = join(level1, "level2");
		const level1Skills = join(level1, ".pi", "skills");
		const level2Skills = join(level2, ".pi", "skills");

		mkdirSync(level2Skills, { recursive: true });
		mkdirSync(level1Skills, { recursive: true });

		const result = discoverResources({
			cwd: level2,
			boundary: level1,
			resources: {
				skills: { enabled: true, searchPaths: [".pi/skills"] },
				prompts: { enabled: false, searchPaths: [] },
				themes: { enabled: false, searchPaths: [] },
			},
		});

		expect(result.skillPaths).toEqual([resolve(level2Skills), resolve(level1Skills)]);
	});

	it("appends absolute search paths after ancestor discovery", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-ancestor-"));
		const level1 = join(base, "level1");
		const level2 = join(level1, "level2");
		const level1Skills = join(level1, ".pi", "skills");
		const absSkills = join(base, "abs-skills");

		mkdirSync(level2, { recursive: true });
		mkdirSync(level1Skills, { recursive: true });
		mkdirSync(absSkills, { recursive: true });

		const ancestors = _test.discoverAncestorDirs(level2, level1);
		const paths = _test.collectPaths({
			ancestors,
			searchPaths: [".pi/skills", absSkills],
		});

		expect(paths).toEqual([resolve(level1Skills), resolve(absSkills)]);
	});

	it("writes default config when none exists", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-ancestor-config-"));
		const projectConfigPath = join(base, "project", ".pi", "extensions", "pi-ancestor-discovery.json");
		const globalConfigPath = join(base, "global", "extensions", "pi-ancestor-discovery.json");

		const resolved = _test.ensureDefaultConfig(projectConfigPath, globalConfigPath);
		expect(resolved).toEqual(_test.DEFAULT_CONFIG);
		expect(existsSync(globalConfigPath)).toBe(true);

		const raw = readFileSync(globalConfigPath, "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed).toEqual(_test.DEFAULT_CONFIG);
	});
});
