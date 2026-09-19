/**
 * Unit tests for the timing state machine.
 *
 * The store takes injected clocks, so every phase boundary is asserted at an
 * exact millisecond instead of a tolerance.
 *
 * Run: node --test test/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createTimingStore, isTokenDelta, MAX_PER_SESSION, pathnameOf } from "../lib/timing.js";

/** A clock that only moves when the test moves it. */
function fixedClock(start = 1000, wallStart = 1700000000000) {
	let monotonic = start;
	let wall = wallStart;
	return {
		now: () => monotonic,
		wallNow: () => wall,
		advance(ms) {
			monotonic += ms;
			wall += ms;
		}
	};
}

/** One undici-style request descriptor. */
const REQUEST = { origin: "https://gateway.example", path: "/v1/chat/completions?stream=1" };

/** The serialized body size every test pretends to send. */
const BODY_BYTES = 5000;

/** A store whose only record has already issued its request. */
function opened(clock) {
	const store = createTimingStore({ now: clock.now, wallNow: clock.wallNow });
	const record = store.begin({ provider: "sg", model: "deepseek-flash", sessionId: "s1" });
	store.noteFetch(record, "https://gateway.example/v1/chat/completions?stream=1", BODY_BYTES);
	return { store, record };
}

test("decomposes one request into every phase", () => {
	const clock = fixedClock();
	const store = createTimingStore({ now: clock.now, wallNow: clock.wallNow });
	const record = store.begin({ provider: "sg", model: "deepseek-flash", sessionId: "s1" });

	clock.advance(5); // serialization before the request exists
	assert.equal(store.noteFetch(record, "https://gateway.example/v1/chat/completions?stream=1", BODY_BYTES), true);
	clock.advance(20); // upload
	store.notePhase(record, "body-sent", clock.now());
	clock.advance(30); // server accepts and answers
	store.notePhase(record, "headers", clock.now());
	clock.advance(10); // prefill until the first token
	store.observeChunk(record, { type: "text-delta", index: 0, text: "hi" }, clock.now());
	clock.advance(200); // decode
	store.observeChunk(record, { type: "usage", usage: { inputTokens: 12, outputTokens: 100 } }, clock.now());
	clock.advance(10);
	store.finish(record, clock.now());

	const [measurement] = store.snapshot("s1");
	assert.equal(measurement.status, "complete");
	assert.equal(measurement.prepareMs, 5);
	assert.equal(measurement.sendMs, 20, "upload measured from the fetch call to bodySent");
	assert.equal(measurement.serverMs, 30);
	assert.equal(measurement.ttftMs, 40, "TTFT is measured from bodySent, not from the stream start");
	assert.equal(measurement.generationMs, 210);
	assert.equal(measurement.totalMs, 270, "from the fetch call, not from the stream start");
	assert.equal(measurement.outputTokens, 100);
	assert.equal(measurement.tokensPerSecond, 476.2, "100 tokens over 0.21s");
	assert.equal(measurement.attempts, 1);
	assert.equal(measurement.requestBytes, BODY_BYTES);
	assert.equal(measurement.sentBytes, BODY_BYTES, "uncompressed by default");
	assert.equal(measurement.compressed, false);
	assert.equal(measurement.responseBytes, 0);
});

test("claims only the request it measured", () => {
	const clock = fixedClock();
	const { store, record } = opened(clock);

	assert.equal(store.claimsRequest(record, REQUEST), true, "the query string is not part of the comparison");
	assert.equal(store.claimsRequest(record, { origin: "https://gateway.example", path: "/v1/files" }), false, "the Files API upload is not the model request");
	assert.equal(store.claimsRequest(record, { origin: "https://other.example", path: "/v1/chat/completions" }), false);
	assert.equal(store.claimsRequest(record, undefined), false);
	assert.equal(store.claimsRequest(store.begin({ provider: "sg", sessionId: "s2" }), REQUEST), false, "a record with no request yet claims nothing");
});

test("records each phase once", () => {
	const clock = fixedClock();
	const { store, record } = opened(clock);
	clock.advance(10);
	assert.equal(store.notePhase(record, "body-sent", clock.now()), true);
	clock.advance(10);
	assert.equal(store.notePhase(record, "body-sent", clock.now()), false, "a repeated diagnostic cannot move the boundary");
	assert.equal(store.snapshot("s1")[0].sendMs, 10);
});

test("reports the provider's prefix-cache accounting", () => {
	const clock = fixedClock();
	const store = createTimingStore({ now: clock.now, wallNow: clock.wallNow });
	const record = store.begin({ provider: "sg", sessionId: "s1" });
	store.noteFetch(record, "https://gateway.example/v1/chat/completions", BODY_BYTES);
	// `inputTokens` counts UNCACHED input only, so this prompt is 900 + 100.
	store.observeChunk(record, { type: "usage", usage: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0 } }, clock.now());
	store.finish(record, clock.now());

	const [measured] = store.snapshot("s1");
	assert.equal(measured.cacheReadTokens, 900);
	assert.equal(measured.cacheWriteTokens, 0);
	assert.equal(measured.cacheHitPercent, 90, "900 of the 1000 prompt tokens came from the prefix cache");
});

test("leaves the cache hit rate null when the provider reports no cache usage", () => {
	const clock = fixedClock();
	const store = createTimingStore({ now: clock.now, wallNow: clock.wallNow });
	const record = store.begin({ provider: "sg", sessionId: "s1" });
	store.noteFetch(record, "https://gateway.example/v1/chat/completions", BODY_BYTES);
	store.observeChunk(record, { type: "usage", usage: { inputTokens: 500, outputTokens: 10 } }, clock.now());
	store.finish(record, clock.now());
	assert.equal(store.snapshot("s1")[0].cacheHitPercent, null, "absent, not a misleading zero");
});

test("records the response encoding only when one was declared", () => {
	const clock = fixedClock();
	const encoded = opened(clock);
	encoded.store.noteResponseEncoding(encoded.record, "gzip");
	encoded.store.finish(encoded.record, clock.now());
	assert.equal(encoded.store.snapshot("s1")[0].responseEncoding, "gzip");

	const plain = opened(clock);
	plain.store.noteResponseEncoding(plain.record, undefined);
	plain.store.noteResponseEncoding(plain.record, "   ");
	plain.store.finish(plain.record, clock.now());
	assert.equal(plain.store.snapshot("s1")[0].responseEncoding, null, "an absent or blank header stays null");

	const trimmed = opened(clock);
	trimmed.store.noteResponseEncoding(trimmed.record, " gzip, br ");
	trimmed.store.finish(trimmed.record, clock.now());
	assert.equal(trimmed.store.snapshot("s1")[0].responseEncoding, "gzip, br");
});

test("accumulates response bytes as they arrive", () => {
	const clock = fixedClock();
	const { store, record } = opened(clock);
	store.noteResponseBytes(record, 100);
	store.noteResponseBytes(record, 250);
	store.noteResponseBytes(record, Number.NaN);
	store.finish(record, clock.now());
	assert.equal(store.snapshot("s1")[0].responseBytes, 350);
});

test("reports a compressed request only when the body really shrank", () => {
	const clock = fixedClock();
	const compressed = opened(clock);
	compressed.store.noteSent(compressed.record, 900);
	const small = compressed.store.snapshot("s1")[0];
	assert.equal(small.sentBytes, 900);
	assert.equal(small.compressed, true);
	assert.equal(small.requestBytes, BODY_BYTES, "the serialized size is kept alongside the sent size");

	const grown = opened(clock);
	grown.store.noteSent(grown.record, BODY_BYTES + 10);
	const larger = grown.store.snapshot("s1")[0];
	assert.equal(larger.compressed, false, "a rewrite that did not help is not reported as compression");
});

test("keeps a retry from restarting the clock", () => {
	const clock = fixedClock();
	const { store, record } = opened(clock);
	clock.advance(50);
	assert.equal(store.noteFetch(record, "https://gateway.example/v1/chat/completions", BODY_BYTES), false);
	clock.advance(50);
	store.notePhase(record, "body-sent", clock.now());
	store.finish(record, clock.now());

	const [measurement] = store.snapshot("s1");
	assert.equal(measurement.attempts, 2);
	assert.equal(measurement.sendMs, 100, "the second attempt does not reset the measurement");
});

test("reports absent phases as null instead of zero", () => {
	const clock = fixedClock();
	const store = createTimingStore({ now: clock.now, wallNow: clock.wallNow });
	const running = store.begin({ provider: "sg", sessionId: "s1" });
	store.noteFetch(running, "https://gateway.example/v1/chat/completions", BODY_BYTES);
	clock.advance(10);
	store.observeChunk(running, { type: "text-delta", index: 0, text: "a" }, clock.now());

	const [pending] = store.snapshot("s1");
	assert.equal(pending.status, "running");
	assert.equal(pending.sendMs, null, "no bodySent event was seen");
	assert.equal(pending.ttftMs, null, "TTFT has no send boundary to measure from");
	assert.equal(pending.totalMs, null, "the stream has not finished");
	assert.equal(pending.tokensPerSecond, null, "no usage and no generation window");
});

test("a stream that ends without tokens still closes", () => {
	const clock = fixedClock();
	const { store, record } = opened(clock);
	clock.advance(5);
	store.notePhase(record, "body-sent", clock.now());
	clock.advance(25);
	store.finish(record, clock.now(), "error");

	const [measurement] = store.snapshot("s1");
	assert.equal(measurement.status, "error");
	assert.equal(measurement.sendMs, 5);
	assert.equal(measurement.totalMs, 30);
	assert.equal(measurement.ttftMs, null);
	assert.equal(measurement.generationMs, null);
});

test("keeps sessions apart and bounds both dimensions", () => {
	const clock = fixedClock();
	const store = createTimingStore({ now: clock.now, wallNow: clock.wallNow });
	for (let index = 0; index < MAX_PER_SESSION + 5; index++) {
		const record = store.begin({ provider: "sg", sessionId: "s1" });
		store.finish(record, clock.now());
	}
	store.begin({ provider: "sg", sessionId: "s2" });

	assert.equal(store.snapshot("s1").length, MAX_PER_SESSION, "per-session history is capped");
	assert.equal(store.snapshot("s2").length, 1);
	assert.equal(store.snapshot("unknown").length, 0, "an unknown session reads as empty");
	assert.equal(store.snapshot(null).length, 0);
	const ids = store.snapshot("s1").map((measurement) => measurement.id);
	assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "oldest first");
});

test("recognises the same first-token shapes the Trajectory uses", () => {
	assert.equal(isTokenDelta({ type: "text-delta", text: "a" }), true);
	assert.equal(isTokenDelta({ type: "reasoning-delta", text: "a" }), true);
	assert.equal(isTokenDelta({ type: "tool-call-delta", argumentsDelta: "{}" }), true);
	assert.equal(isTokenDelta({ type: "tool-call-delta", name: "bash" }), true);
	assert.equal(isTokenDelta({ type: "text-delta", text: "" }), false);
	assert.equal(isTokenDelta({ type: "usage" }), false);
	assert.equal(isTokenDelta(undefined), false);
});

test("pathnameOf strips only the query", () => {
	assert.equal(pathnameOf("/v1/chat/completions?a=1&b=2"), "/v1/chat/completions");
	assert.equal(pathnameOf("/v1/chat/completions"), "/v1/chat/completions");
	assert.equal(pathnameOf(undefined), "");
});
