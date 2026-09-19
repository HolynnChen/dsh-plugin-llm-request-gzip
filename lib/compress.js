/**
 * Pure decision core for per-provider request-body gzip.
 *
 * Everything here is a plain function over plain JSON: no Cordis context, no
 * Node globals, no zlib. The Host half injects the real `gzip` implementation
 * and the real header objects, which keeps the decision logic directly
 * unit-testable and keeps the risky part (touching a live `RequestInit`)
 * confined to one place.
 *
 * @module dsh-plugin-llm-request-gzip/compress
 */

/** Minimum body size (bytes) below which compression is skipped by default. */
export const DEFAULT_MIN_BYTES = 1024;

/** Lower-cased header names this module manages. */
const CONTENT_ENCODING = "content-encoding";
const CONTENT_LENGTH = "content-length";

/**
 * Drop trailing slashes so a configured `baseURL` becomes a stable prefix.
 * @param baseURL - provider endpoint as authored in settings.
 * @returns the normalized endpoint, or `undefined` when absent or blank.
 */
export function normalizeEndpoint(baseURL) {
	if (typeof baseURL !== "string") return undefined;
	const trimmed = baseURL.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.replace(/\/+$/u, "");
}

/**
 * Walk a settings `settingsPath` into a resolved namespace value.
 * @param value - the namespace's resolved value.
 * @param path - ordered path segments; empty addresses the value itself.
 * @returns the addressed node, or `undefined` when the path does not resolve.
 */
export function walkPath(value, path) {
	let node = value;
	for (const segment of path) {
		if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
		node = node[segment];
	}
	return node;
}

/**
 * Read the endpoint a configurable-provider entry declares.
 * @param namespaceValue - resolved value of the entry's settings namespace.
 * @param settingsPath - the entry's path inside that namespace.
 * @returns the normalized `baseURL`, or `undefined` when the profile declares none.
 */
export function readEndpoint(namespaceValue, settingsPath) {
	const profile = walkPath(namespaceValue, settingsPath);
	if (profile === null || typeof profile !== "object" || Array.isArray(profile)) return undefined;
	return normalizeEndpoint(profile.baseURL);
}

/**
 * Compile the stored settings section into per-route policies.
 * An unreadable section yields no policies, which means "compress nothing" —
 * the safe direction for a transport-level switch.
 * @param raw - the resolved `llm-request-gzip` settings section.
 * @returns route -> `{ enabled, minBytes }`.
 */
export function compilePolicies(raw) {
	const policies = new Map();
	const providers = raw === null || typeof raw !== "object" ? undefined : raw.providers;
	if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return policies;
	for (const route of Object.keys(providers)) {
		const entry = providers[route];
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		policies.set(route, {
			enabled: entry.enabled === true,
			minBytes: Number.isFinite(entry.minBytes) && entry.minBytes >= 0 ? entry.minBytes : DEFAULT_MIN_BYTES,
			prewarm: entry.prewarm === true
		});
	}
	return policies;
}

/**
 * Invert `route -> endpoint` into `endpoint -> routes`, so one request URL can
 * be traced back to every route that owns it. Several routes may legitimately
 * share one gateway endpoint.
 * @param providerEndpoints - iterable of `[route, endpoint]` pairs.
 * @returns endpoint -> route list.
 */
export function indexEndpoints(providerEndpoints) {
	const byEndpoint = new Map();
	for (const [route, endpoint] of providerEndpoints) {
		if (endpoint === undefined) continue;
		const list = byEndpoint.get(endpoint);
		if (list === undefined) byEndpoint.set(endpoint, [route]);
		else list.push(route);
	}
	return byEndpoint;
}

/**
 * Resolve the policy that governs one outgoing request.
 *
 * Exact provider attribution (the streaming provider the request belongs to)
 * wins whenever it is known: a route that is not enabled then stays
 * uncompressed even if another route shares its endpoint. Only when
 * attribution is unavailable does the endpoint index decide, and then the
 * longest matching endpoint wins and the routes on it are OR-ed together.
 *
 * @param request - URL, attributed provider, policies, and the endpoint index.
 * @returns the governing policy, or `undefined` when the request is out of scope.
 */
export function resolvePolicy(request) {
	const { url, provider, policies, byEndpoint } = request;
	if (typeof provider === "string" && provider.length > 0) return policies.get(provider);
	if (typeof url !== "string") return undefined;
	let best;
	for (const [endpoint, routes] of byEndpoint) {
		if (!url.startsWith(endpoint)) continue;
		if (best === undefined || endpoint.length > best.endpoint.length) best = { endpoint, routes };
	}
	if (best === undefined) return undefined;
	const enabled = [];
	for (const route of best.routes) {
		const policy = policies.get(route);
		if (policy !== undefined && policy.enabled) enabled.push(policy);
	}
	if (enabled.length === 0) return undefined;
	let minBytes = enabled[0].minBytes;
	for (const policy of enabled) if (policy.minBytes < minBytes) minBytes = policy.minBytes;
	return { enabled: true, minBytes };
}

/**
 * Read one header case-insensitively from any of the shapes `fetch` accepts.
 * @param headers - plain object, pair array, or `Headers` instance.
 * @param name - lower-cased header name.
 * @returns the header value, or `undefined` when absent.
 */
export function readHeader(headers, name) {
	if (headers === undefined || headers === null) return undefined;
	if (typeof headers.get === "function") return headers.get(name) ?? undefined;
	if (Array.isArray(headers)) {
		for (const pair of headers) if (String(pair[0]).toLowerCase() === name) return pair[1];
		return undefined;
	}
	if (typeof headers !== "object") return undefined;
	for (const key of Object.keys(headers)) if (key.toLowerCase() === name) return headers[key];
	return undefined;
}

/**
 * Return a copy of `headers` carrying `content-encoding: gzip` and no stale
 * `content-length`. The result is always a plain object: the two shipped
 * adapters already pass plain objects, and normalizing here keeps the rewrite
 * in one branch instead of three.
 * @param headers - the original header container, in any accepted shape.
 * @returns new headers ready to be handed back to `fetch`.
 */
export function withGzipHeader(headers) {
	const next = {};
	const assign = (key, value) => {
		const lower = String(key).toLowerCase();
		if (lower === CONTENT_LENGTH || lower === CONTENT_ENCODING) return;
		next[key] = value;
	};
	if (headers !== undefined && headers !== null) {
		if (typeof headers.forEach === "function" && typeof headers.get === "function") headers.forEach((value, key) => assign(key, value));
		else if (Array.isArray(headers)) for (const pair of headers) assign(pair[0], pair[1]);
		else if (typeof headers === "object") for (const key of Object.keys(headers)) assign(key, headers[key]);
	}
	next[CONTENT_ENCODING] = "gzip";
	return next;
}

/**
 * Decide whether one `fetch` call should be rewritten, and produce the body.
 *
 * A string body is the only compressible input the shipped adapters produce;
 * anything else (FormData uploads, streams, `Request` objects) is left exactly
 * as the caller built it. The compressed body is used only when it is strictly
 * smaller, so the switch can never enlarge a request.
 *
 * @param request - body, already-known content-encoding, policy, and codecs.
 * @returns the compressed body and its sizes, or `undefined` to send as-is.
 */
export function planGzip(request) {
	const { body, policy, hasContentEncoding, byteLength, gzip } = request;
	if (typeof body !== "string") return undefined;
	if (hasContentEncoding !== undefined) return undefined;
	if (policy === undefined || !policy.enabled) return undefined;
	const originalBytes = byteLength(body);
	if (originalBytes < policy.minBytes) return undefined;
	const compressed = gzip(body);
	if (compressed.byteLength >= originalBytes) return undefined;
	return {
		body: compressed,
		originalBytes,
		compressedBytes: compressed.byteLength
	};
}
