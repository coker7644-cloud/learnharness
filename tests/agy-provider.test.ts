/**
 * Antigravity CLI (agy) provider catalog (src/agent/agy/provider.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { clampThinkingLevel, createAssistantMessageEventStream, createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import { AGY_PROVIDER } from "../src/agent/agy/constants.ts";
import { createAgyProvider } from "../src/agent/agy/provider.ts";
import { toAgyModelId } from "../src/agent/agy/stream.ts";
import { needsSendToUser } from "../src/agent/tools/send-to-user.ts";

function createCollection() {
	const collection = createModels();
	collection.setProvider(createAgyProvider(() => createAssistantMessageEventStream()));
	return collection;
}

test("lists all curated Antigravity CLI models", () => {
	const models = createCollection().getModels(AGY_PROVIDER);
	assert.deepEqual(
		models.map((m) => m.id),
		[
			"gemini-4-hydrogen",
			"gemini-4-argon",
			"gemini-3.8-flash",
			"claude-opus-5-5",
			"claude-sonnet-5-5",
			"gemini-pro-orchestrator-g1-pro",
			"gpt-oss-120b-medium",
		],
	);
});

test("supports expected thinking levels and resolves ACP model IDs", () => {
	const models = createCollection().getModels(AGY_PROVIDER);
	const hydrogen = models.find((m) => m.id === "gemini-4-hydrogen")!;
	assert.deepEqual(getSupportedThinkingLevels(hydrogen), ["low", "medium", "high", "xhigh"]);
	assert.equal(clampThinkingLevel(hydrogen, "off"), "low");
	assert.equal(toAgyModelId(hydrogen, "xhigh"), "gemini-4-hydrogen-xhigh");
	assert.equal(toAgyModelId(hydrogen, "high"), "gemini-4-hydrogen-high");

	const sonnet = models.find((m) => m.id === "claude-sonnet-5-5")!;
	assert.deepEqual(getSupportedThinkingLevels(sonnet), ["low", "medium", "high"]);
	assert.equal(toAgyModelId(sonnet, "high"), "claude-sonnet-5-5-high");

	const orchestrator = models.find((m) => m.id === "gemini-pro-orchestrator-g1-pro")!;
	assert.deepEqual(getSupportedThinkingLevels(orchestrator), ["off"]);
	assert.equal(toAgyModelId(orchestrator, undefined), "gemini-pro-orchestrator-g1-pro");
});

test("accepts expected input modalities and has zero local cost", () => {
	for (const model of createCollection().getModels(AGY_PROVIDER)) {
		assert.deepEqual(model.input, model.id === "gpt-oss-120b-medium" ? ["text"] : ["text", "image"]);
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	}
});

test("uses send_to_user only for Claude models under agy", () => {
	assert.equal(needsSendToUser({ provider: AGY_PROVIDER, id: "claude-opus-5-5" }), true);
	assert.equal(needsSendToUser({ provider: AGY_PROVIDER, id: "claude-sonnet-5-5" }), true);
	assert.equal(needsSendToUser({ provider: AGY_PROVIDER, id: "gemini-4-hydrogen" }), false);
});

test("auth resolves as configured without any key", async () => {
	const collection = createCollection();
	assert.ok(await collection.checkAuth(AGY_PROVIDER));
	assert.equal((await collection.getAvailable(AGY_PROVIDER)).length, 7);
});
