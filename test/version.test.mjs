/**
 * Unit tests for the three-part version handling.
 *
 * Run: node --test test/version.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, isNewer, parseVersion, versionFromPackage } from "../lib/version.js";

test("compares three-part versions by number, not by text", () => {
	assert.equal(compareVersions("1.0.0", "1.2.0"), -1);
	assert.equal(compareVersions("1.2.0", "1.0.0"), 1);
	assert.equal(compareVersions("2.0.1", "2.0.1"), 0);
	// The case a string comparison gets wrong.
	assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
	assert.equal(compareVersions("0.0.10", "0.0.9"), 1);
});

test("accepts a leading v and refuses anything that is not three parts", () => {
	assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3 });
	assert.equal(parseVersion("1.2"), undefined);
	assert.equal(parseVersion("1.2.3.4"), undefined);
	assert.equal(parseVersion("1.2.x"), undefined);
	assert.equal(parseVersion(""), undefined);
	assert.equal(parseVersion(undefined), undefined);
});

test("treats an unreadable version as no evidence of an update", () => {
	// Guessing here would offer an update that might be a downgrade.
	assert.equal(isNewer("abc", "1.0.0"), false);
	assert.equal(isNewer("1.0.0", "abc"), false);
	assert.equal(isNewer("1.0.0", "1.0.1"), true);
	assert.equal(isNewer("1.0.1", "1.0.1"), false);
	assert.equal(isNewer("2.0.0", "1.9.9"), false);
});

test("reads the version out of a manifest", () => {
	assert.equal(versionFromPackage('{"name":"x","version":"3.4.5"}'), "3.4.5");
	assert.equal(versionFromPackage({ version: "0.0.1" }), "0.0.1");
	assert.equal(versionFromPackage('{"version":"one"}'), undefined);
	assert.equal(versionFromPackage("not json"), undefined);
	assert.equal(versionFromPackage('{"name":"x"}'), undefined);
});
