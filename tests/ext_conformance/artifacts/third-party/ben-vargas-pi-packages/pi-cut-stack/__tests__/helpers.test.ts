import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { _test } from "../extensions/index.js";

describe("pi-cut-stack helpers", () => {
	it("falls back to defaults when file is missing", () => {
		const missingPath = join(tmpdir(), "pi-cut-stack-missing.json");
		const config = _test.readKeybindingsFile(missingPath);
		const keys = _test.resolveShortcutKeys(config);
		expect(keys).toEqual({ cut: ["alt+x"], pop: ["alt+p"] });
	});

	it("parses keybindings from file", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-cut-stack-"));
		const filePath = join(base, "keybindings.json");
		writeFileSync(
			filePath,
			JSON.stringify(
				{
					[_test.CUT_ACTION]: "ctrl+k",
					[_test.POP_ACTION]: ["alt+y", "alt+z"],
				},
				null,
				2,
			),
			"utf-8",
		);

		const config = _test.readKeybindingsFile(filePath);
		const keys = _test.resolveShortcutKeys(config);
		expect(keys).toEqual({ cut: ["ctrl+k"], pop: ["alt+y", "alt+z"] });
	});

	it("falls back to defaults when JSON is invalid", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-cut-stack-"));
		const filePath = join(base, "keybindings.json");
		writeFileSync(filePath, "{not valid}", "utf-8");

		const config = _test.readKeybindingsFile(filePath);
		const keys = _test.resolveShortcutKeys(config);
		expect(keys).toEqual({ cut: ["alt+x"], pop: ["alt+p"] });
	});
});
