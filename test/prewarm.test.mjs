/**
 * Unit tests for the pre-transmission helpers.
 *
 * Run: node --test test/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ASSISTANT_VARIANTS, headersMatch, isShapeRejection, messagesPrefixEnd, predictAssistantCommonIncrement, predictAssistantIncrement, prewarmPrefix } from "../lib/prewarm.js";

/** One OpenAI-compatible body with a two-message history and trailing fields. */
const BODY = JSON.stringify({
	model: "deepseek-flash",
	messages: [
		{ role: "system", content: "be brief" },
		{ role: "user", content: "hello" }
	],
	stream: true,
	temperature: 0.2
});

test("finds the end of the last message, not the end of the body", () => {
	const end = messagesPrefixEnd(BODY);
	const prefix = prewarmPrefix(BODY);
	assert.equal(prefix, BODY.slice(0, end));
	assert.ok(prefix.endsWith('"hello"}'), "the prefix stops at the last message");
	assert.ok(!prefix.includes('"stream"'), "the fields after messages are not part of the prefix");

	// The follow-up appends to the history, so the prefix must still hold.
	const followUp = JSON.stringify({
		model: "deepseek-flash",
		messages: [
			{ role: "system", content: "be brief" },
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" }
		],
		stream: true,
		temperature: 0.2
	});
	assert.ok(followUp.startsWith(prefix), "the next request shares the prefix byte for byte");
});

test("is not fooled by braces, brackets, or escaped quotes inside content", () => {
	const body = JSON.stringify({
		messages: [
			{ role: "user", content: 'curly } and [bracket] and an escaped \\" quote' }
		],
		stream: true
	});
	const prefix = prewarmPrefix(body);
	assert.ok(prefix.endsWith("}"), "the prefix ends at the message object");
	const replayed = JSON.parse(`${prefix}]}`);
	assert.equal(replayed.messages.length, 1, "the prefix reparses as one complete message");
	assert.match(replayed.messages[0].content, /escaped \\" quote/u, "escapes survive the scan");
});

test("declines a body with no usable history", () => {
	assert.equal(prewarmPrefix(JSON.stringify({ model: "m", stream: true })), undefined, "no messages key");
	assert.equal(prewarmPrefix(JSON.stringify({ messages: [], stream: true })), undefined, "empty history");
	assert.equal(prewarmPrefix(undefined), undefined);
	assert.equal(prewarmPrefix(42), undefined);
});

test("tolerates whitespace after the messages key", () => {
	const body = '{ "messages" : [ {"role":"user","content":"x"} ], "stream": true }';
	const prefix = prewarmPrefix(body);
	assert.equal(prefix, '{ "messages" : [ {"role":"user","content":"x"}');
});

test("compares headers case-insensitively and rejects any difference", () => {
	const prewarmed = { authorization: "Bearer k", "content-type": "application/json" };
	assert.equal(headersMatch(prewarmed, { Authorization: "Bearer k", "Content-Type": "application/json" }), true);
	assert.equal(headersMatch(prewarmed, { authorization: "Bearer other", "content-type": "application/json" }), false, "a different credential must not reuse the request");
	assert.equal(headersMatch(prewarmed, { authorization: "Bearer k" }), false, "a missing header is a difference");
	assert.equal(headersMatch(prewarmed, { authorization: "Bearer k", "content-type": "application/json", "x-deepseek-harness-compact": "1" }), false, "an added marker is a difference");
	assert.equal(headersMatch(undefined, {}), true, "nothing declared, nothing to contradict");
});

test("only shape rejections are worth resending", () => {
	assert.equal(isShapeRejection(411), true, "Length Required — a chunked body");
	assert.equal(isShapeRejection(415), true, "Unsupported Media Type");
	assert.equal(isShapeRejection(501), true);
	assert.equal(isShapeRejection(400), false, "a real provider answer; the adapter owns it");
	assert.equal(isShapeRejection(429), false, "resending would duplicate a rate-limited call");
	assert.equal(isShapeRejection(200), false);
});

test("the framing variants differ exactly where adapters do", () => {
	const body = JSON.stringify({
		messages: [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "text", tool_calls: [{ id: "a", type: "function", function: { name: "read", arguments: '{"p":1}' } }] }
		]
	});
	const assistant = { text: "", toolCalls: [{ id: "b", name: "bash", arguments: '{ "cmd" : "ls" }' }] };

	// An adapter that re-serializes the arguments and keeps a (empty) content.
	const reserialized = predictAssistantIncrement(body, assistant, "reserialized");
	assert.match(reserialized.appended, /"content":"",/u);
	assert.match(reserialized.appended, /"arguments":"\{\\"cmd\\":\\"ls\\"\}"/u, "the arguments are re-serialized");

	// One that re-serializes and omits `content` on a turn with no text.
	const terse = predictAssistantIncrement(body, assistant, "terse");
	assert.doesNotMatch(terse.appended, /"content"/u);
	assert.match(terse.appended, /"arguments":"\{\\"cmd\\":\\"ls\\"\}"/u);

	// One that passes the model's own bytes through.
	const raw = predictAssistantIncrement(body, assistant, "raw");
	assert.match(raw.appended, /\{ \\"cmd\\" : \\"ls\\" \}/u, "the model's own bytes survive");

	// All three place the turn at the same point in the body.
	assert.equal(reserialized.from, terse.from);
	assert.equal(terse.from, raw.from);
});

test("the common prefix is a prefix of every framing, and no longer", () => {
	const body = JSON.stringify({
		messages: [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "earlier", tool_calls: [{ id: "a", type: "function", function: { name: "read", arguments: '{"p":1}' } }] }
		]
	});
	const assistant = { text: "Let me look.", toolCalls: [{ id: "b", name: "bash", arguments: '{ "cmd" : "ls" }' }] };
	const common = predictAssistantCommonIncrement(body, assistant);
	assert.notEqual(common, undefined);

	// Whatever framing the adapter turns out to use, the pre-sent bytes continue it.
	for (const variant of ASSISTANT_VARIANTS) {
		const predicted = predictAssistantIncrement(body, assistant, variant);
		assert.ok(predicted.appended.startsWith(common.appended), `${variant} must continue the common prefix`);
	}
	// And it stops where they diverge rather than guessing past it: the framing
	// that omits `content` already differs within the common prefix's own length.
	const terse = predictAssistantIncrement(body, assistant, "terse");
	assert.ok(common.appended.length < terse.appended.length, "some of the turn is left for the request itself");
	assert.ok(common.appended.includes('"role":"assistant"'), "but the skeleton goes out early");
});
