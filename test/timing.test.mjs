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

/** One undici-style request descriptor for the transport events. */
const REQUEST = { origin: "https://gateway.example", path: "/v1/chat/completions?stream=1" };

test("decomposes one request into every phase", () => {
	const clock = fixedClock();
	const store = createTimingStore({ now: clock.now, wallNow: clock.wallNow });
	const record = store.begin({ provider: "sg", model: "deepseek-flash", sessionId: "s1" });

	clock.advance(5); // serialization before the request exists
	assert.equal(store.noteFetch(record, "https://gateway.example/v1/chat/completions?stream=1"), true);
	clock.advance(20); // upload
	store.noteTransport(record, "body-sent", REQUEST, clock.now());
	clock.advance(30); // server accepts and answers
	store.noteTransport(record, "headers", REQUEST, clock.now());
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
});

test("matches transport events by origin and path, ignoring the query", () => {
	const clock = fixedClock();
	const store = createTimingStore({ now: clock.now, wallNow: clock.wallNow });
	const record = store.begin({ provider: "sg", sessionId: "s1" });
	store.noteFetch(record, "https://gateway.example/v1/chat/completions?stream=1");

	const other = { origin: "https://gateway.example", path: "/v1/files" };
	assert.equal(store.noteTransport(record, "body-sent", other, clock.now()), false, "the Files API upload is not the model request");
	const elsewhere = { origin: "https://other.example", path: "/v1/chat/completions" };
	assert.equal(store.noteTransport(record, "body-sent", elsewhere, clock.now()), false);
	assert.equal(store.noteTransport(record, "body-sent", { origin: REQUEST.origin, path: "/v1/chat/completions" }, clock.now()), true);
	assert.equal(store.noteTransport(record, "body-sent", REQUEST, clock.now()), false, "one phase is recorded once");
});

test("keeps a retry from restarting the clock", () => {
	const clock = fixedClock();
	const store = createTimingStore({ now: clock.now, wallNow: clock.wallNow });
	const record = store.begin({ provider: "sg", sessionId: "s1" });
	assert.equal(store.noteFetch(record, "https://gateway.example/v1/chat/completions"), true);
	clock.advance(50);
	assert.equal(store.noteFetch(record, "https://gateway.example/v1/chat/completions"), false);
	clock.advance(50);
	store.noteTransport(record, "body-sent", { origin: "https://gateway.example", path: "/v1/chat/completions" }, clock.now());
	store.finish(record, clock.now());

	const [measurement] = store.snapshot("s1");
	assert.equal(measurement.attempts, 2);
	assert.equal(measurement.sendMs, 100, "the second attempt does not reset the measurement");
});

test("reports absent phases as null instead of zero", () => {
	const clock = fixedClock();
	const store = createTimingStore({ now: clock.now, wallNow: clock.wallNow });
	const running = store.begin({ provider: "sg", sessionId: "s1" });
	store.noteFetch(running, "https://gateway.example/v1/chat/completions");
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
	const store = createTimingStore({ now: clock.now, wallNow: clock.wallNow });
	const record = store.begin({ provider: "sg", sessionId: "s1" });
	store.noteFetch(record, "https://gateway.example/v1/chat/completions");
	clock.advance(5);
	store.noteTransport(record, "body-sent", { origin: "https://gateway.example", path: "/v1/chat/completions" }, clock.now());
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
