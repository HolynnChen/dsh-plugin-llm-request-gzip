/**
 * Three-part version handling for the update button in the settings panel.
 *
 * The published version is the `package.json` on the repository's `main` branch —
 * the tags are for readers, and nothing here consults them — and the running
 * version is read from the installed `package.json`. An update is a fast-forward
 * pull in the plugin's own directory, the same thing the installer does, so the
 * panel is only ever reporting and triggering what a manual `git pull` would
 * have done.
 *
 * @module dsh-plugin-model-request-accelerator/version
 */

/** Exactly three numeric parts, the only shape that compares reliably. */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Parse a three-part version.
 * @param text - the candidate, with or without a leading `v`.
 * @returns the parts, or `undefined` when it is not three numeric parts.
 */
export function parseVersion(text) {
	if (typeof text !== "string") return undefined;
	const match = VERSION_RE.exec(text.trim().replace(/^v/u, ""));
	if (match === null) return undefined;
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Compare two three-part versions.
 * @param left - one version.
 * @param right - the other.
 * @returns `-1`, `0`, or `1`, or `undefined` when either cannot be parsed.
 */
export function compareVersions(left, right) {
	const a = parseVersion(left);
	const b = parseVersion(right);
	if (a === undefined || b === undefined) return undefined;
	for (const part of ["major", "minor", "patch"]) {
		if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
	}
	return 0;
}

/**
 * Whether `candidate` is a version worth installing over `current`.
 *
 * Anything unparseable on either side is not: a version the plugin cannot read
 * is not evidence of a newer one, and guessing would offer an update that might
 * be a downgrade.
 * @param current - the running version.
 * @param candidate - the published version.
 * @returns whether the candidate is strictly newer.
 */
export function isNewer(current, candidate) {
	return compareVersions(current, candidate) === -1;
}

/**
 * Read the version out of a `package.json` document.
 * @param text - the file's contents, or the parsed object.
 * @returns the version, or `undefined` when it is absent or not three parts.
 */
export function versionFromPackage(text) {
	let parsed = text;
	if (typeof text === "string") {
		try {
			parsed = JSON.parse(text);
		} catch {
			return undefined;
		}
	}
	if (parsed === null || typeof parsed !== "object") return undefined;
	return parseVersion(parsed.version) === undefined ? undefined : String(parsed.version).trim().replace(/^v/u, "");
}
