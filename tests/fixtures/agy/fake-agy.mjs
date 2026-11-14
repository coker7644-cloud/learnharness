import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const scenarioPath = process.env.FAKE_AGY_SCENARIO;
const stdinLogPath = process.env.FAKE_AGY_STDIN;
if (!scenarioPath) throw new Error("FAKE_AGY_SCENARIO is required");
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));

let nextRpcId = 9000;
const pendingReplies = new Map();
let mcpClientPromise = null;
let mcpUrl = "";
let mcpHeaders = {};
const sessionId = "fake-agy-session-1";
let waitRelease = null;

function send(msg) {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendUpdate(update) {
	send({
		jsonrpc: "2.0",
		method: "session/update",
		params: { sessionId, update },
	});
}

function requestFromHost(method, params) {
	const id = nextRpcId++;
	return new Promise((resolve, reject) => {
		pendingReplies.set(id, { resolve, reject });
		send({ jsonrpc: "2.0", id, method, params });
	});
}

async function getMcpClient() {
	if (!mcpClientPromise) {
		mcpClientPromise = (async () => {
			const client = new Client({ name: "fake-agy", version: "1.0.0" });
			const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: mcpHeaders } });
			await client.connect(transport);
			return client;
		})();
	}
	return mcpClientPromise;
}

async function callMcpTool(toolName, args, signal) {
	const client = await getMcpClient();
	const result = await client.callTool({ name: toolName, arguments: args }, undefined, signal ? { signal } : undefined);
	return result.content?.map((c) => c.text).join("\n") ?? JSON.stringify(result);
}

async function openRawMcpSession() {
	const baseHeaders = {
		...mcpHeaders,
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
	const initRes = await fetch(mcpUrl, {
		method: "POST",
		headers: baseHeaders,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fake-agy-raw", version: "1.0.0" } },
		}),
	});
	const mcpSessionId = initRes.headers.get("mcp-session-id") ?? "";
	const sessionHeaders = { ...baseHeaders, "mcp-session-id": mcpSessionId };
	await fetch(mcpUrl, {
		method: "POST",
		headers: sessionHeaders,
		body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
	});
	return sessionHeaders;
}

const ipcWaiters = new Map();
function waitForIpc(expected) {
	return new Promise((resolve) => {
		ipcWaiters.set(expected, resolve);
	});
}

process.on("message", (msg) => {
	if (msg === "continue" && waitRelease) {
		const release = waitRelease;
		waitRelease = null;
		release();
		return;
	}
	const waiter = ipcWaiters.get(msg);
	if (waiter) {
		ipcWaiters.delete(msg);
		waiter();
	}
});

async function handlePrompt(rpcId) {
	if (scenario.window || scenario.used) {
		sendUpdate({
			sessionUpdate: "usage_update",
			...(scenario.window ? { size: scenario.window } : {}),
			...(scenario.used ? { used: scenario.used } : {}),
		});
	}
	if (scenario.checkpointWait) {
		process.send?.("checkpoint");
		await new Promise((resolve) => { waitRelease = resolve; });
	}
	if (scenario.thought) {
		sendUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: scenario.thought } });
	}
	if (scenario.text) {
		sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: scenario.text } });
	}
	const results = [];
	for (const step of scenario.calls ?? []) {
		if (step.used) {
			sendUpdate({ sessionUpdate: "usage_update", used: step.used });
		}
		if (step.kind === "builtin_denied") {
			const perm = await requestFromHost("session/request_permission", {
				sessionId,
				toolCall: { toolCallId: step.id, name: step.name },
				options: [
					{ optionId: "allow", kind: "allow_once" },
					{ optionId: "deny", kind: "reject_once" },
				],
			});
			results.push({ id: step.id, outcome: perm.outcome?.optionId });
			continue;
		}
		if (step.kind === "mcp") {
			const mcpName = `mcp_learnharness_${step.tool}`;
			const perm = await requestFromHost("session/request_permission", {
				sessionId,
				toolCall: { toolCallId: step.id, name: mcpName },
				options: [
					{ optionId: "allow", kind: "allow_once" },
					{ optionId: "deny", kind: "reject_once" },
				],
			});
			if (perm.outcome?.optionId !== "allow") {
				throw new Error(`Permission rejected for ${mcpName}`);
			}
			if (step.preMcpFail) {
				sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: step.id, status: "failed" });
				results.push({ id: step.id, text: "pre-mcp-failed" });
				continue;
			}
			if (step.waitAction === "timeout") {
				const ac = new AbortController();
				const pending = callMcpTool(step.tool, step.arguments ?? {}, ac.signal);
				await waitForIpc("timeout");
				ac.abort("timeout");
				await pending.catch(() => {});
				sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: step.id, status: "failed" });
				results.push({ id: step.id, text: "mcp-timeout" });
				continue;
			}
			if (step.waitAction === "dropHttp") {
				const sessionHeaders = await openRawMcpSession();
				const ac = new AbortController();
				const pending = fetch(mcpUrl, {
					method: "POST",
					headers: sessionHeaders,
					signal: ac.signal,
					body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: step.tool, arguments: step.arguments ?? {} } }),
				});
				await waitForIpc("dropHttp");
				ac.abort("dropHttp");
				await pending.catch(() => {});
				results.push({ id: step.id, text: "http-dropped" });
				continue;
			}
			if (step.waitAction === "abandon") {
				void callMcpTool(step.tool, step.arguments ?? {}).catch(() => {});
				await waitForIpc("abandon");
				results.push({ id: step.id, text: "abandoned-wait" });
				continue;
			}
			const text = await callMcpTool(step.tool, step.arguments ?? {});
			results.push({ id: step.id, text });
		}
	}
	if (scenario.afterUsed) {
		sendUpdate({ sessionUpdate: "usage_update", used: scenario.afterUsed });
	}
	if (scenario.afterText) {
		const suffix = results.map((r) => `${r.id}:${r.text ?? r.outcome}`).join(" | ");
		sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${scenario.afterText} ${suffix}` } });
	}
	send({
		jsonrpc: "2.0",
		id: rpcId,
		result: {
			stopReason: scenario.stopReason ?? "end_turn",
			usage: scenario.usage ?? { inputTokens: 120, outputTokens: 30, cachedReadTokens: 10, cachedWriteTokens: 0 },
		},
	});
}

createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	if (stdinLogPath) appendFileSync(stdinLogPath, `${line}\n`);
	const msg = JSON.parse(line);
	if (msg.id !== undefined && !msg.method) {
		const waiter = pendingReplies.get(msg.id);
		if (waiter) {
			pendingReplies.delete(msg.id);
			waiter.resolve(msg.result ?? {});
		}
		return;
	}
	if (msg.method === "initialize") {
		send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
	} else if (msg.method === "session/new") {
		const server = msg.params?.mcpServers?.[0];
		if (server) {
			mcpUrl = server.url;
			mcpHeaders = Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value]));
		}
		send({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
	} else if (msg.method === "session/set_model") {
		send({ jsonrpc: "2.0", id: msg.id, result: {} });
	} else if (msg.method === "session/prompt") {
		void handlePrompt(msg.id);
	} else if (msg.method === "session/cancel") {
		process.exit(0);
	}
});
