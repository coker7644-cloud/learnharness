import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after, type TestContext } from "node:test";

const testData = mkdtempSync(join(tmpdir(), "lh-agy-opt-in-data-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));
const { SETTINGS_FILE } = await import("../config.ts");
const { PUT } = await import("../app/api/settings/[section]/route.ts");
const { sanitizeUserSettings, providerKeyMissing } = await import("../src/core/settings.ts");
const { parseAgySettingsBody } = await import("../src/server/settings-body.ts");
const { agyAvailable, agyEnabled } = await import("../src/server/agy-config.ts");
const { agyInstallationResponse } = await import("../src/server/agy.ts");
const { modelCatalog, validateModelsSettings } = await import("../src/server/model-catalog.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { AGY_MODELS } = await import("../src/agent/agy/provider.ts");

function setup(t: TestContext) {
	const previous = readSettings();
	const path = process.env.PATH;
	const dir = mkdtempSync(join(tmpdir(), "agy-opt-in-"));
	writeFileSync(join(dir, process.platform === "win32" ? "agy.exe" : "agy"), "", { mode: 0o755 });
	process.env.PATH = `${dir}${delimiter}${path ?? ""}`;
	t.after(() => {
		if (previous) writeSettings(previous); else rmSync(SETTINGS_FILE, { force: true });
		if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
	});
	writeSettings({ version: 1 });
}

async function save(body: unknown) {
	return PUT(
		new Request("http://test/api/settings/agy", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ section: "agy" }) },
	);
}

test("opt-in parses strictly and malformed stored values never enable agy", () => {
	assert.deepEqual(parseAgySettingsBody({}), { ok: true, settings: {} });
	assert.deepEqual(parseAgySettingsBody({ enabled: true, ignored: true }), { ok: true, settings: { enabled: true } });
	assert.deepEqual(parseAgySettingsBody({ enabled: false }), { ok: true, settings: { enabled: false } });
	for (const raw of [true, null, [], "on", { enabled: "true" }, { enabled: 1 }]) {
		assert.equal(parseAgySettingsBody(raw).ok, false);
	}
	for (const raw of [null, [], true, "on", { enabled: "true" }, { enabled: 1 }]) {
		assert.notEqual(sanitizeUserSettings({ version: 1, agy: raw })?.agy?.enabled, true);
	}
	assert.equal(sanitizeUserSettings({ version: 1 })?.agy, undefined);
});

test("default off even with an installed binary; section writes toggle availability cleanly", async (t) => {
	setup(t);
	const models = {
		strong: { model: { provider: "agy", id: "gemini-4-hydrogen" } },
		cheap: { model: { provider: "agy", id: "gemini-3.8-flash" } },
	};
	writeSettings({ version: 1, models, graph: { enabled: false }, futureSection: { keep: 1 } });
	assert.equal(agyEnabled(), false);
	assert.equal(agyAvailable(), false);
	assert.equal(providerKeyPresent("agy"), false);
	assert(!modelCatalog().models.some((m) => m.provider === "agy"));
	assert.equal((await save({ enabled: true })).status, 200);
	assert.equal(agyEnabled(), true);
	assert.equal(agyAvailable(), true);
	assert.equal(modelCatalog().models.filter((m) => m.provider === "agy").length, AGY_MODELS.length);
	assert.equal((await save({ enabled: false })).status, 200);
	assert.equal(agyAvailable(), false);
	assert(!modelCatalog().models.some((m) => m.provider === "agy"));
	assert.deepEqual(readSettings()?.models, models);
	assert.deepEqual(readSettings()?.graph, { enabled: false });
	assert.deepEqual(readSettings()?.futureSection, { keep: 1 });
	assert.equal(validateModelsSettings(models, models).ok, true);
	assert.equal((await save({ enabled: "true" })).status, 400);
	assert.equal(agyEnabled(), false);
	assert.equal((await save({})).status, 200);
	assert.equal(agyEnabled(), false);
});

test("off cannot launch a version probe even through an otherwise authorized HTTP request", async (t) => {
	setup(t);
	const request = new Request("http://test/api/agy", { headers: { "x-learnharness-agy": "1" } });
	const response = await agyInstallationResponse(request, async () => assert.fail("disabled CLI must not execute"));
	assert.equal(response.status, 403);
});

test("a saved agy background job is refused before model execution while opt-in is off", async (t) => {
	setup(t);
	const chat = chatStore.createChat("agy opt-in job fixture");
	t.after(() => { jobStore.deleteJobsForChat(chat.id); chatStore.deleteChat(chat.id); });
	const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "agy-off-job" });
	let calls = 0;
	const runner = createJobRunner({
		chatStore,
		jobStore,
		deliver: async () => {},
		engineFor: () => ({ model: AGY_MODELS[0]!, streamFn: () => { calls++; assert.fail("must not run a disabled CLI model"); } }),
		providerKeyMissing: (provider, tier) => providerKeyPresent(provider) ? null : providerKeyMissing(provider, [tier]),
	});
	await runner.runJob(job.id, { question: "Synthetic fixture only" });
	assert.equal(calls, 0);
	const refused = jobStore.getJob(job.id)!;
	assert.equal(refused.status, "error");
	assert.match(JSON.stringify(refused.result), /Enable and set it up in Settings/);
});
