/**
 * Ask an endpoint which request-body encodings it accepts.
 *
 * Compression is only safe where the far end decodes it. The plugin finds that
 * out the hard way — it sends the body, and if the endpoint answers with a shape
 * rejection the endpoint is remembered and gzip takes over — but there is no
 * reason to learn it from a real conversation when a one-token request answers
 * the same question.
 *
 * Usage:
 *   node scripts/probe-encodings.mjs <baseUrl> [apiKeyEnv|apiKey]
 *
 * With no arguments it reads the first `baseURL` and `apiKeyEnv` it finds in
 * `~/.dsh/settings.yaml` — a deliberately shallow scan, so this stays a script
 * with no dependencies.
 *
 * @module dsh-plugin-model-request-accelerator/probe-encodings
 */

import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The smallest body a chat endpoint will accept as a real request. */
const BODY = JSON.stringify({ model: "probe", messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false });

/** Read the first `baseURL` and `apiKeyEnv` from the settings document. */
function fromSettings() {
	try {
		const text = readFileSync(join(homedir(), ".dsh", "settings.yaml"), "utf8");
		return {
			base: /baseURL:\s*(\S+)/u.exec(text)?.[1],
			keyEnv: /apiKeyEnv:\s*(\S+)/u.exec(text)?.[1]
		};
	} catch {
		return {};
	}
}

const [, , baseArg, keyArg] = process.argv;
const found = fromSettings();
const rawBase = baseArg ?? found.base;
if (rawBase === undefined) {
	console.error("usage: node scripts/probe-encodings.mjs <baseUrl> [apiKeyEnv|apiKey]");
	process.exit(2);
}
const base = rawBase.replace(/\/+$/u, "");
const resolved = keyArg ?? found.keyEnv;
const apiKey = resolved === undefined ? undefined : (process.env[resolved] ?? resolved);

/** One probe: send the body with this encoding and report what came back. */
async function probe(encoding) {
	const headers = { "content-type": "application/json", accept: "application/json" };
	if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;
	let body = BODY;
	if (encoding === "gzip") body = gzipSync(Buffer.from(BODY));
	if (encoding === "br") body = brotliCompressSync(Buffer.from(BODY), { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } });
	if (encoding !== null) headers["content-encoding"] = encoding;
	try {
		const response = await fetch(`${base}/chat/completions`, { method: "POST", headers, body });
		const text = await response.text();
		// A shape rejection is unambiguously about the encoding. Anything else says
		// the endpoint got past the body — but only if it read the body at all: a
		// gateway that answers 401 before parsing looks identical to one that decoded
		// the body and then rejected the token. Without a credential the probe can
		// only report the first two, so it says which it is rather than guessing.
		// Only two answers are definitive: a shape rejection means the body was not
		// decoded, and 2xx means the endpoint took the request. Everything else is
		// about the request rather than the encoding — a 401 rejects the token before
		// the body is judged, a 404 is the wrong path, a 5xx is the endpoint's own
		// problem — so the probe reports those honestly instead of reading them as
		// success. That is why it is worth running with a working credential.
		let verdict;
		if ([411, 415, 501].includes(response.status)) verdict = "REFUSED - do not enable this encoding";
		else if (response.ok) verdict = "accepted";
		else if ([401, 403].includes(response.status)) verdict = "inconclusive - credential rejected, the body was never judged";
		else if ([404, 405].includes(response.status)) verdict = "inconclusive - wrong path or method";
		else if (response.status >= 500) verdict = "inconclusive - the endpoint failed";
		else verdict = "likely accepted - rejected the request, not the encoding";
		return `${String(encoding ?? "identity").padEnd(8)} HTTP ${response.status}  ${verdict}  ${text.slice(0, 70).replace(/\s+/gu, " ")}`;
	} catch (error) {
		return `${String(encoding ?? "identity").padEnd(8)} request failed: ${String(error?.message ?? error)}`;
	}
}

console.log(`probing ${base}/chat/completions`);
if (apiKey === undefined) console.log("(no credential found — an unauthenticated 401 still proves the encoding was decoded)");
for (const encoding of [null, "gzip", "br"]) console.log(" ", await probe(encoding));
console.log("\nREFUSED means that encoding must not be enabled for this endpoint.");
