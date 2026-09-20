/**
 * Contract test for the installer.
 *
 * It writes into a real profile, so each case builds a throwaway one and clones this
 * checkout into it. The case worth pinning is a pristine patch layer, whose effective
 * content is an empty array: appending a sequence entry after `[]` produces a file a
 * YAML parser rejects, because it reads one document that is both.
 *
 * Run: npm test (from the package root; the script lists every suite)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The plugin id the installer must register exactly once. */
const PLUGIN_ID = "model-request-accelerator";

/**
 * Run the installer twice against a throwaway profile, so a second run is proven
 * idempotent as well.
 * @param patch - the patch file to start from, or `undefined` for none.
 * @returns the resulting patch file's text, and the profile root to clean up.
 */
function installTwice(patch) {
	const home = mkdtempSync(join(tmpdir(), "dsh-install-"));
	const profile = join(home, "profiles", "web");
	mkdirSync(join(profile, "plugins"), { recursive: true });
	writeFileSync(join(profile, "package.json"), '{ "name": "web" }\n');
	if (patch !== undefined) writeFileSync(join(profile, "cordis.patch.yml"), patch);
	execFileSync("git", ["clone", "--quiet", PACKAGE_ROOT, join(profile, "plugins", PLUGIN_ID)]);
	for (let run = 0; run < 2; run += 1) {
		execFileSync("sh", [join(PACKAGE_ROOT, "install.sh")], { env: { ...process.env, DSH_HOME: home }, encoding: "utf8" });
	}
	return { patch: readFileSync(join(profile, "cordis.patch.yml"), "utf8"), home };
}

/**
 * The property a YAML parser enforces here, without needing one: every line that is
 * not blank and not a comment must be part of one top-level block sequence. An empty
 * array left above the entries breaks exactly that.
 * @param patch - the patch file's text.
 * @returns the top-level entries, as id-bearing lines.
 */
function topLevelEntries(patch) {
	const lines = patch.split("\n").filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
	for (const line of lines) {
		assert.ok(line.startsWith("- ") || line.startsWith("  ") || line.startsWith("    "), `every line belongs to the sequence, saw ${JSON.stringify(line)}`);
	}
	return lines.filter((line) => line.startsWith("- "));
}

test("registers into a pristine patch layer instead of appending after []", () => {
	const pristine = "# Your patch layer for the web profile.\n#\n# Entries are applied in order.\n[]\n\n# Add your own rows below this line.\n";
	const { patch, home } = installTwice(pristine);
	try {
		assert.ok(!/^\s*\[\]\s*$/mu.test(patch), "the empty array is gone");
		assert.match(patch, /^# Your patch layer for the web profile\./mu, "and the original comments are kept");
		const entries = topLevelEntries(patch);
		assert.equal(entries.length, 1, `one entry after two runs, saw ${String(entries.length)}`);
		assert.match(patch, new RegExp(`id: ${PLUGIN_ID}`, "u"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("appends to a patch layer that already has entries, and to empty or absent ones", () => {
	const existing = "- insert:\n    - id: something-else\n      name: './plugins/other/lib/index.js'\n";
	for (const [label, patch] of [["with entries", existing], ["empty", ""], ["absent", undefined]]) {
		const result = installTwice(patch);
		try {
			const entries = topLevelEntries(result.patch);
			assert.equal(entries.length, patch === existing ? 2 : 1, `${label}: one entry added, saw ${String(entries.length)}`);
			if (patch === existing) assert.match(result.patch, /id: something-else/u, `${label}: the existing entry survives`);
		} finally {
			rmSync(result.home, { recursive: true, force: true });
		}
	}
});
