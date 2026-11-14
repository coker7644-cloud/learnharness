/**
 * Antigravity CLI (agy) provider driven through the real chat handler:
 * - Opt-in gating before write-ahead / liveness / agent creation
 * - In-flight opt-out does not interrupt an admitted turn
 * - Question answered before idle timeout continues the waiting ACP process
 * - Multiple questions in one CLI response stay paused until prior answer
 * - Non-MCP built-in CLI tool permission requests are rejected
 * - Idle timeout triggers replay on next process cleanly
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { after, type TestContext } from "node:test";

import { normalizeContext } from "@earendil-works/pi-ai";
import type { RunAgy } from "../src/agent/agy/stream.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { workerRequestStream } from "../src/agent/worker-request-admission.ts";

const testData = mkdtempSync(join(tmpdir(), "lh-agy-harness-data-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));

const { PATHS, SETTINGS_FILE } = await import("../config.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { LIVE_PROCESS_IDLE_TIMEOUT_MS, liveProcessIdleTimeoutMs } = await import("../src/agent/claude-code/live-processes.ts");
const { AGY_MODELS } = await import("../src/agent/agy/provider.ts");
const { createAgyStreamFunction } = await import("../src/agent/agy/stream.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { measuredContextTokens } = await import("../src/core/context-usage.ts");
const { cliContextWindowOf, danglingQuestionOf } = await import("../src/core/native-messages.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");

const FAKE_AGY = fileURLToPath(new URL("./fixtures/agy/fake-agy.mjs", import.meta.url));
const TURN_TIMEOUT_MS = 8000;

const ASK_ID = "call_agy_ask_1";
const ASK_QUESTION = "What do you already know about TCP handshakes?";
const ANSWER_TEXT = "SYN, SYN-ACK, ACK";

type FakeScenario = {
	window?: number;
	used?: number;
	checkpointWait?: boolean;
	thought?: string;
	text?: string;
	afterText?: string;
	calls?: Array<
		| {
			kind: "mcp";
			id: string;
			tool: string;
			arguments?: Record<string, unknown>;
			used?: number;
			preMcpFail?: boolean;
			waitAction?: "timeout" | "dropHttp" | "abandon";
		}
		| { kind: "builtin_denied"; id: string; name: string; used?: number }
	>;
};

type FakeRun = { runAgy: RunAgy; children: ChildProcessWithoutNullStreams[]; stdinFiles: string[] };

function createFakeRun(t: TestContext, scenarios: FakeScenario[]): FakeRun {
	const settings = readSettings();
	writeSettings({ ...(settings ?? { version: 1 }), agy: { enabled: true } });
	t.after(() => { if (settings) writeSettings(settings); else rmSync(SETTINGS_FILE, { force: true }); });
	const dir = mkdtempSync(join(tmpdir(), "agy-harness-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, process.platform === "win32" ? "agy.exe" : "agy"), "", { mode: 0o755 });
	const savedPath = process.env.PATH;
	process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
	t.after(() => { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; });

	const children: ChildProcessWithoutNullStreams[] = [];
	const stdinFiles: string[] = [];

	const runAgy: RunAgy = (args, options) => {
		const scenario = scenarios[children.length];
		assert.ok(scenario, `unexpected agy spawn #${children.length + 1}`);

		const scenarioFile = join(dir, `scenario-${children.length}.json`);
		const stdinFile = join(dir, `stdin-${children.length}.jsonl`);
		writeFileSync(scenarioFile, JSON.stringify(scenario));

		const child = spawn(process.execPath, [FAKE_AGY, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_AGY_SCENARIO: scenarioFile, FAKE_AGY_STDIN: stdinFile },
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));

		children.push(child);
		stdinFiles.push(stdinFile);
		return child;
	};

	return { runAgy, children, stdinFiles };
}

function createAgyChat(t: TestContext): string {
	const chat = chatStore.createChat("Agy: question answered later");
	chatStore.saveSettings(chat.id, { model: { provider: "agy", id: "gemini-4-hydrogen" } });
	t.after(() => unlinkSync(join(PATHS.chats, `${chat.id}.json`)));
	return chat.id;
}

function createAgentFactory(fakeRun: FakeRun): Parameters<typeof handleChatRequest>[1] {
	const model = AGY_MODELS.find((candidate) => candidate.id === "gemini-4-hydrogen");
	assert.ok(model);
	const engine: PiEngine = { model, streamFn: createAgyStreamFunction(fakeRun.runAgy) };
	return (options) => createTeacherAgent(undefined, { engine, chatId: options.chatId, messages: options.messages });
}

async function runChatTurn(chatId: string, input: object, agentFactory: Parameters<typeof handleChatRequest>[1]): Promise<void> {
	const request = new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
	const ack = await handleChatRequest(request, agentFactory);
	assert.equal(ack.status, 200, await ack.clone().text());

	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();

	const deadline = Date.now() + TURN_TIMEOUT_MS;
	while (isTurnRunning(chatId)) {
		assert.ok(Date.now() < deadline, "turn did not settle");
		await sleep(10);
	}
}

function toAnswerInput(toolCallId = ASK_ID, text = ANSWER_TEXT): object {
	return {
		type: "answer",
		toolCallId,
		answer: { kind: "ask", questionText: ASK_QUESTION, dontKnow: false, answers: [], text, answeredAt: new Date().toISOString() },
	};
}

function getLastAssistantText(chatId: string): string {
	const messages = chatStore.getChat(chatId)?.messages ?? [];
	const assistant = messages.findLast((message) => message.role === "assistant");
	assert.ok(assistant?.role === "assistant");
	return assistant.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await once(child, "exit", { signal: AbortSignal.timeout(TURN_TIMEOUT_MS) });
}

test("disabled agy opt-in refuses a saved CLI chat before write-ahead, liveness, or agent creation", async (t) => {
	const fakeRun = createFakeRun(t, [{ text: "never" }]);
	const chatId = createAgyChat(t);
	writeSettings({ ...(readSettings() ?? { version: 1 }), agy: { enabled: false } });
	const before = chatStore.getChat(chatId)!.messages;
	const response = await handleChatRequest(
		new Request("http://test/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId, input: { type: "text", text: "must not start" } }),
		}),
		() => assert.fail("disabled work must not build an agent"),
	);
	assert.equal(response.status, 503);
	assert.match((await response.json()).error, /Enable and set it up in Settings/);
	assert.equal(isTurnRunning(chatId), false);
	assert.equal(fakeRun.children.length, 0);
	assert.deepEqual(chatStore.getChat(chatId)!.messages, before);
});

test("switching agy off blocks future requests without killing an already admitted turn", async (t) => {
	const fakeRun = createFakeRun(t, [{ checkpointWait: true, text: "Admitted agy response" }]);
	const run = fakeRun.runAgy;
	let ready!: (child: ChildProcessWithoutNullStreams) => void;
	let failed!: (error: unknown) => void;
	const checkpoint = new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => { ready = resolve; failed = reject; });
	fakeRun.runAgy = async (args, options) => {
		const child = await run(args, options);
		assert(child);
		void once(child, "message", { signal: AbortSignal.timeout(TURN_TIMEOUT_MS) }).then(() => ready(child), failed);
		return child;
	};
	const chatId = createAgyChat(t);
	const response = await handleChatRequest(
		new Request("http://test/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId, input: { type: "text", text: "complete this admitted fixture" } }),
		}),
		createAgentFactory(fakeRun),
	);
	assert.equal(response.status, 200);
	const child = await checkpoint;
	const handle = runningTurn(chatId);
	assert(handle);
	const finished = new Response(handle.subscribe()).text();
	writeSettings({ ...(readSettings() ?? { version: 1 }), agy: { enabled: false } });
	assert.equal(child.signalCode, null, "opt-out must not kill an already running process");
	child.send("continue");
	await finished;
	assert.equal(getLastAssistantText(chatId), "Admitted agy response");
	await waitForExit(child);
});

test("a question answered before the idle timeout continues the waiting agy ACP process and denies built-in tools", async (t) => {
	const fakeRun = createFakeRun(t, [{
		window: 1000000,
		thought: "thinking first",
		calls: [
			{ kind: "builtin_denied", id: "builtin_1", name: "run_command" },
			{ kind: "mcp", id: ASK_ID, tool: "ask_user_question", arguments: { question: ASK_QUESTION } },
		],
		afterText: "Done:",
	}]);
	const agentFactory = createAgentFactory(fakeRun);
	const chatId = createAgyChat(t);

	await runChatTurn(chatId, { type: "text", text: "teach me TCP" }, agentFactory);

	assert.equal(danglingQuestionOf(chatStore.getChat(chatId)?.messages ?? [])?.toolCallId, ASK_ID);
	const [waiting] = fakeRun.children;
	assert.ok(waiting);
	assert.equal(waiting.exitCode, null, "agy process should stay alive on the held MCP question call");

	await runChatTurn(chatId, toAnswerInput(), agentFactory);

	assert.equal(fakeRun.children.length, 1);
	assert.deepEqual(cliContextWindowOf(chatStore.getChat(chatId)!.messages), { model: "agy:gemini-4-hydrogen", tokens: 1000000 });
	const finalText = getLastAssistantText(chatId);
	assert.ok(finalText.includes("builtin_1:deny"), finalText);
	assert.ok(finalText.includes(ANSWER_TEXT), finalText);
	await waitForExit(waiting);
});

test("two queued MCP question permissions stay serialized until the learner answers the first", async (t) => {
	const secondId = "call_agy_ask_2";
	const fakeRun = createFakeRun(t, [{
		calls: [
			{ kind: "mcp", id: ASK_ID, tool: "ask_user_question", arguments: { question: ASK_QUESTION } },
			{ kind: "mcp", id: secondId, tool: "ask_user_question", arguments: { question: "What next?" } },
		],
		afterText: "All answered:",
	}]);
	const factory = createAgentFactory(fakeRun);
	const chatId = createAgyChat(t);

	await runChatTurn(chatId, { type: "text", text: "teach me TCP" }, factory);
	assert.equal(danglingQuestionOf(chatStore.getChat(chatId)?.messages ?? [])?.toolCallId, ASK_ID);
	assert.equal(JSON.stringify(chatStore.getChat(chatId)?.messages).includes(secondId), false);

	await runChatTurn(chatId, toAnswerInput(ASK_ID, "first answer"), factory);
	assert.equal(danglingQuestionOf(chatStore.getChat(chatId)?.messages ?? [])?.toolCallId, secondId);

	await runChatTurn(chatId, toAnswerInput(secondId, "second answer"), factory);
	assert.equal(fakeRun.children.length, 1);
	const finalText = getLastAssistantText(chatId);
	assert.ok(finalText.includes("first answer"), finalText);
	assert.ok(finalText.includes("second answer"), finalText);
	await waitForExit(fakeRun.children[0]!);
});

test("an expired idle timeout replays the answered turn onto a fresh agy process", async (t) => {
	liveProcessIdleTimeoutMs.current = 20;
	t.after(() => { liveProcessIdleTimeoutMs.current = LIVE_PROCESS_IDLE_TIMEOUT_MS; });

	const fakeRun = createFakeRun(t, [
		{
			calls: [{ kind: "mcp", id: ASK_ID, tool: "ask_user_question", arguments: { question: ASK_QUESTION } }],
			afterText: "never-reached",
		},
		{ text: `Replayed answer: ${ANSWER_TEXT}` },
	]);
	const factory = createAgentFactory(fakeRun);
	const chatId = createAgyChat(t);

	await runChatTurn(chatId, { type: "text", text: "teach me TCP" }, factory);
	const [first] = fakeRun.children;
	assert.ok(first);
	await waitForExit(first);

	await runChatTurn(chatId, toAnswerInput(), factory);
	assert.equal(fakeRun.children.length, 2);
	assert.equal(getLastAssistantText(chatId), `Replayed answer: ${ANSWER_TEXT}`);
	await waitForExit(fakeRun.children[1]!);
});

test("toolUse turns report usage_update.used as measured context tokens and recover from pre-MCP failed tool_call_update", async (t) => {
	const fakeRun = createFakeRun(t, [{
		window: 1048576,
		used: 8969,
		calls: [
			{ kind: "mcp", id: "failed_call_1", tool: "ask_user_question", arguments: { question: "ignored" }, preMcpFail: true },
			{ kind: "mcp", id: ASK_ID, tool: "ask_user_question", arguments: { question: ASK_QUESTION }, used: 9321 },
		],
		afterText: "Recovered:",
	}]);
	const agentFactory = createAgentFactory(fakeRun);
	const chatId = createAgyChat(t);

	await runChatTurn(chatId, { type: "text", text: "teach me TCP" }, agentFactory);

	const messages = chatStore.getChat(chatId)?.messages ?? [];
	assert.equal(danglingQuestionOf(messages)?.toolCallId, ASK_ID);
	assert.equal(measuredContextTokens(messages), 9321);
	assert.deepEqual(cliContextWindowOf(messages), { model: "agy:gemini-4-hydrogen", tokens: 1048576 });

	await runChatTurn(chatId, toAnswerInput(), agentFactory);
	assert.equal(fakeRun.children.length, 1);
	assert.ok(getLastAssistantText(chatId).includes(ANSWER_TEXT));
	await waitForExit(fakeRun.children[0]!);
});

test("workerRequestStream reuses live agy ACP process across toolUse iterations", async (t) => {
	const fakeRun = createFakeRun(t, [{
		window: 1048576,
		used: 4200,
		calls: [{ kind: "mcp", id: "call_pdf_1", tool: "pdf_info", arguments: {} }],
		afterText: "Brief ready:",
	}]);
	const model = AGY_MODELS.find((candidate) => candidate.id === "gemini-4-hydrogen");
	assert.ok(model);
	const wrappedStream = workerRequestStream(createAgyStreamFunction(fakeRun.runAgy));
	const tools = [{ name: "pdf_info", description: "triage", parameters: { type: "object", properties: {} } as never }];
	const sessionId = "worker-reuse-session";

	const firstMessages = [{ role: "user" as const, content: "Read PDF", timestamp: Date.now() }];
	const firstRes = await wrappedStream(model, normalizeContext({ systemPrompt: "PDF reader", messages: firstMessages, tools }), { sessionId }).result();
	assert.equal(firstRes.stopReason, "toolUse");
	assert.equal(firstRes.usage.input, 4200);
	assert.equal(fakeRun.children.length, 1);
	assert.equal(fakeRun.children[0]!.exitCode, null, "clean toolUse completion must not abort live agy process");

	const nextMessages = [
		...firstMessages,
		firstRes,
		{ role: "toolResult" as const, toolCallId: "call_pdf_1", toolName: "pdf_info", content: [{ type: "text" as const, text: "Pages: 14" }], isError: false, timestamp: Date.now() },
	];
	const secondRes = await wrappedStream(model, normalizeContext({ systemPrompt: "PDF reader", messages: nextMessages, tools }), { sessionId }).result();
	assert.equal(secondRes.stopReason, "stop");
	assert.equal(fakeRun.children.length, 1, "subsequent worker iteration must reuse the live agy process");
	assert.ok(secondRes.content.some((b) => b.type === "text" && b.text.includes("Pages: 14")));
	await waitForExit(fakeRun.children[0]!);
});

test("an MCP call timeout while waiting for a learner answer retires cleanly and replays onto a fresh agy process", async (t) => {
	const fakeRun = createFakeRun(t, [
		{
			calls: [{ kind: "mcp", id: ASK_ID, tool: "ask_user_question", arguments: { question: ASK_QUESTION }, waitAction: "timeout" }],
			afterText: "CLI timed out wait:",
		},
		{ text: `Recovered after MCP timeout: ${ANSWER_TEXT}` },
	]);
	const factory = createAgentFactory(fakeRun);
	const chatId = createAgyChat(t);

	await runChatTurn(chatId, { type: "text", text: "teach me TCP" }, factory);
	assert.equal(danglingQuestionOf(chatStore.getChat(chatId)?.messages ?? [])?.toolCallId, ASK_ID);
	fakeRun.children[0]!.send("timeout");
	await waitForExit(fakeRun.children[0]!);

	await runChatTurn(chatId, toAnswerInput(), factory);
	assert.equal(fakeRun.children.length, 2);
	assert.equal(getLastAssistantText(chatId), `Recovered after MCP timeout: ${ANSWER_TEXT}`);
	await waitForExit(fakeRun.children[1]!);
});

test("dropping the held MCP HTTP response without notifications/cancelled still retires cleanly for replay", async (t) => {
	const fakeRun = createFakeRun(t, [
		{
			calls: [{ kind: "mcp", id: ASK_ID, tool: "ask_user_question", arguments: { question: ASK_QUESTION }, waitAction: "dropHttp" }],
			afterText: "CLI dropped wait:",
		},
		{ text: `Recovered after HTTP drop: ${ANSWER_TEXT}` },
	]);
	const factory = createAgentFactory(fakeRun);
	const chatId = createAgyChat(t);

	await runChatTurn(chatId, { type: "text", text: "teach me TCP" }, factory);
	assert.equal(danglingQuestionOf(chatStore.getChat(chatId)?.messages ?? [])?.toolCallId, ASK_ID);
	fakeRun.children[0]!.send("dropHttp");
	await waitForExit(fakeRun.children[0]!);

	await runChatTurn(chatId, toAnswerInput(), factory);
	assert.equal(fakeRun.children.length, 2);
	assert.equal(getLastAssistantText(chatId), `Recovered after HTTP drop: ${ANSWER_TEXT}`);
	await waitForExit(fakeRun.children[1]!);
});

test("moving on while the held MCP call is still open still fails continuation", async (t) => {
	const fakeRun = createFakeRun(t, [
		{
			calls: [{ kind: "mcp", id: ASK_ID, tool: "ask_user_question", arguments: { question: ASK_QUESTION }, waitAction: "abandon" }],
			afterText: "CLI moved on unexpectedly:",
		},
	]);
	const factory = createAgentFactory(fakeRun);
	const chatId = createAgyChat(t);

	await runChatTurn(chatId, { type: "text", text: "teach me TCP" }, factory);
	assert.equal(danglingQuestionOf(chatStore.getChat(chatId)?.messages ?? [])?.toolCallId, ASK_ID);
	fakeRun.children[0]!.send("abandon");
	await waitForExit(fakeRun.children[0]!);

	await runChatTurn(chatId, toAnswerInput(), factory);
	assert.equal(fakeRun.children.length, 1);
	const last = chatStore.getChat(chatId)?.messages.at(-1);
	assert.equal(last?.role, "assistant");
	assert.equal(last.stopReason, "error");
	assert.match(last.errorMessage ?? "", /moved on while harness tool calls were waiting for results/);
});

