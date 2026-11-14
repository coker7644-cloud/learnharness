import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type JsonObject,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type StreamFunction,
	type ThinkingLevel,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

import { externalCliEnv } from "../../core/auth-env.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { addLiveProcess, getLiveProcess, removeLiveProcess, type LiveProcess } from "../claude-code/live-processes.ts";
import { configurationForReuse, conversationForReuse } from "../claude-code/reuse-context.ts";
import { AgyError } from "./constants.ts";
import { AgyLaunchError, createAgyLauncher } from "./launch.ts";
import {
	createToolBridge,
	mcpNameForTool,
	toolNameFromMcp,
	type PendingToolCall,
	type ToolBridge,
} from "./tool-bridge.ts";
import { toAgyInput, type AgyInput } from "./transcript.ts";

export type RunAgyOptions = { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal };

type AgyChild = ChildProcessWithoutNullStreams | null;
export type RunAgy = (args: string[], options: RunAgyOptions) => AgyChild | Promise<AgyChild>;

const THINKING_SUFFIXES: Partial<Record<ThinkingLevel | "off", string>> = {
	off: "low",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "high",
};

const STOP_REASONS: Record<string, "stop" | "length" | "error"> = {
	end_turn: "stop",
	stop_sequence: "stop",
	max_tokens: "length",
	refusal: "error",
};

const REFUSAL_MESSAGE = "The model refused to complete the request";
const ABORT_MESSAGE = "Request was aborted";
const START_FAILED_MESSAGE = "agy CLI failed to start";
const NO_STOP_REASON_MESSAGE = "agy CLI ended the message without a stop reason";

export function toAgyModelId(model: Model<Api>, level: ThinkingLevel | undefined): string {
	if (!model.reasoning) return model.id;
	const mapped = level ? model.thinkingLevelMap?.[level] ?? THINKING_SUFFIXES[level] : "medium";
	return `${model.id}-${mapped ?? "medium"}`;
}

export function toAgyArgs(geminiDir: string): string[] {
	return [
		"acp",
		"--stdio",
		"--app-data-dir",
		"app-data",
		"--cli_dir_name",
		"cli",
		"--gemini-dir",
		geminiDir,
		"--include-default-customizations=false",
	];
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function isNotSignedInError(message: string): boolean {
	return /\b(unauthenticated|not logged in|not signed in|authentication required|auth required)\b/i.test(message);
}

type AcpUsage = {
	inputTokens?: unknown;
	outputTokens?: unknown;
	cachedReadTokens?: unknown;
	cachedWriteTokens?: unknown;
	thoughtTokens?: unknown;
};

function nonNegInt(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

class AgyTurn {
	private readonly output: AssistantMessage & Pick<LhMessage, "cliContextWindow">;
	private activeBlock: { kind: "text" | "thinking"; contentIndex: number } | null = null;
	private usedTokens: number | undefined;
	started = false;
	finished = false;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		model: Model<Api>,
	) {
		this.output = createOutput(model);
	}

	appendThinking(delta: string): void {
		if (this.finished || !delta) return;
		this.start();
		if (this.activeBlock?.kind !== "thinking") {
			this.closeOpenBlock();
			const contentIndex = this.output.content.length;
			this.output.content.push({ type: "thinking", thinking: "" });
			this.activeBlock = { kind: "thinking", contentIndex };
			this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
		}
		const block = this.output.content[this.activeBlock.contentIndex];
		if (block?.type !== "thinking") return;
		block.thinking += delta;
		this.stream.push({ type: "thinking_delta", contentIndex: this.activeBlock.contentIndex, delta, partial: this.output });
	}

	appendText(delta: string): void {
		if (this.finished || !delta) return;
		this.start();
		if (this.activeBlock?.kind !== "text") {
			this.closeOpenBlock();
			const contentIndex = this.output.content.length;
			this.output.content.push({ type: "text", text: "" });
			this.activeBlock = { kind: "text", contentIndex };
			this.stream.push({ type: "text_start", contentIndex, partial: this.output });
		}
		const block = this.output.content[this.activeBlock.contentIndex];
		if (block?.type !== "text") return;
		block.text += delta;
		this.stream.push({ type: "text_delta", contentIndex: this.activeBlock.contentIndex, delta, partial: this.output });
	}

	closeOpenBlock(): void {
		if (!this.activeBlock || this.finished) return;
		const { kind, contentIndex } = this.activeBlock;
		this.activeBlock = null;
		const block = this.output.content[contentIndex];
		if (!block) return;
		if (kind === "text" && block.type === "text") {
			this.stream.push({ type: "text_end", contentIndex, content: block.text, partial: this.output });
		} else if (kind === "thinking" && block.type === "thinking") {
			this.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.output });
		}
	}

	setContextWindow(tokens: number | undefined): void {
		if (!this.finished && tokens !== undefined && Number.isSafeInteger(tokens) && tokens > 0) {
			this.output.cliContextWindow = tokens;
		}
	}

	setUsedTokens(tokens: number | undefined): void {
		if (!this.finished && tokens !== undefined && Number.isSafeInteger(tokens) && tokens > 0) {
			this.usedTokens = tokens;
		}
	}

	admit(calls: ToolCall[]): void {
		if (this.finished) return;
		this.start();
		this.closeOpenBlock();
		this.applyUsedFallback();
		for (const call of calls) {
			const contentIndex = this.output.content.length;
			this.output.content.push(call);
			this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
			this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
		}
		this.output.stopReason = "toolUse";
		this.finished = true;
		this.stream.push({ type: "done", reason: "toolUse", message: this.output });
		this.stream.end();
	}

	complete(stopReason: string | undefined, usage: AcpUsage | undefined): void {
		if (this.finished) return;
		this.start();
		this.closeOpenBlock();
		if (usage) {
			const input = nonNegInt(usage.inputTokens);
			const output = nonNegInt(usage.outputTokens);
			const cacheRead = nonNegInt(usage.cachedReadTokens);
			const cacheWrite = nonNegInt(usage.cachedWriteTokens);
			const reasoning = nonNegInt(usage.thoughtTokens);
			const totalTokens = input + output + cacheRead + cacheWrite;
			if (totalTokens > 0) {
				Object.assign(this.output.usage, {
					input,
					output,
					cacheRead,
					cacheWrite,
					reasoning,
					totalTokens,
				});
			} else {
				this.applyUsedFallback();
			}
		} else {
			this.applyUsedFallback();
		}

		if (stopReason === "cancelled") {
			this.fail(ABORT_MESSAGE, "aborted");
			return;
		}

		const mapped = stopReason ? STOP_REASONS[stopReason] : undefined;
		if (!mapped) {
			this.fail(stopReason ? `Unhandled stop reason: ${stopReason}` : NO_STOP_REASON_MESSAGE, "error");
			return;
		}
		if (mapped === "error") {
			this.fail(this.output.errorMessage ?? REFUSAL_MESSAGE, "error");
			return;
		}

		this.output.stopReason = mapped;
		this.finished = true;
		this.stream.push({ type: "done", reason: mapped, message: this.output });
		this.stream.end();
	}

	getMessage(): AssistantMessage {
		return this.output;
	}

	fail(message: string, reason: "aborted" | "error"): void {
		if (this.finished) return;

		this.closeOpenBlock();
		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}

	private start(): void {
		if (this.started) return;

		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private applyUsedFallback(): void {
		if (this.usedTokens === undefined || this.usedTokens <= 0) return;
		Object.assign(this.output.usage, {
			input: this.usedTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: this.usedTokens,
		});
	}
}

type TurnFiles = { cwd: string; privateDir: string };

async function createTurnFiles(): Promise<TurnFiles> {
	const cwd = await mkdtemp(join(tmpdir(), "agy-cwd-"));
	try {
		const privateDir = await mkdtemp(join(tmpdir(), "agy-private-"));
		return { cwd, privateDir };
	} catch (error) {
		await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		throw error;
	}
}

async function removeTurnResources(bridge: ToolBridge, files: TurnFiles): Promise<void> {
	await Promise.all([
		bridge.close(),
		rm(files.cwd, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }),
		rm(files.privateDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }),
	]);
}

type PermissionOption = { optionId?: unknown; kind?: unknown };
type PermissionRequest = {
	rpcId: number | string;
	acpToolCallId: string;
	toolName: string;
	allowOptionId: string;
	rejectOptionId: string | null;
};

type RpcMessage = {
	jsonrpc?: unknown;
	id?: number | string;
	method?: unknown;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { message?: unknown };
};

class AgyProcess implements LiveProcess {
	toolCallIds: string[] = [];
	private stderr = "";
	private closed = false;
	private stopping = false;
	private killTimer: NodeJS.Timeout | undefined;
	private signal: AbortSignal | undefined;
	private nextRpcId = 1;
	private readonly rpcPending = new Map<number | string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
	private acpSessionId: string | undefined;
	private readonly permissionQueue: PermissionRequest[] = [];
	private activePermission: { acpToolCallId: string; toolName: string } | null = null;
	private admitted: PendingToolCall[] = [];
	private pendingError: string | undefined;
	private contextWindow: number | undefined;
	private usedTokens: number | undefined;

	constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly bridge: ToolBridge,
		private readonly files: TurnFiles,
		private turn: AgyTurn,
		readonly owner: symbol,
		readonly sessionId: string | undefined,
		private readonly configuration: unknown,
		private conversation: unknown[],
		private readonly harnessToolNames: ReadonlySet<string>,
		private readonly acpModelId: string,
	) {}

	start(input: AgyInput, signal: AbortSignal | undefined): void {
		this.child.once("close", (code: number | null) => this.handleClose(`agy CLI exited with code ${code}`));
		this.child.once("error", (error) => {
			console.error("agy CLI process failed:", error);
			this.fail(START_FAILED_MESSAGE);
			this.handleClose(START_FAILED_MESSAGE);
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-65_536); });
		this.child.stdin.on("error", (error) => console.error("agy CLI stdin closed early:", error));

		createInterface({ input: this.child.stdout }).on("line", (line) => {
			if (this.stopping || !line.trim()) return;
			try {
				this.handleRpcMessage(JSON.parse(line) as RpcMessage);
			} catch {
				this.fail("agy CLI emitted malformed stream output");
			}
		});

		this.setSignal(signal);
		if (!this.stopping) {
			void this.runSession(input);
		}
	}

	admitMcpCall(name: string, _args: JsonObject): string | null {
		if (!this.activePermission || this.activePermission.toolName !== name) return null;
		const id = this.activePermission.acpToolCallId;
		this.activePermission = null;
		return id;
	}

	flushAdmissions(): void {
		if (this.stopping || this.turn.finished) return;
		const pending = this.bridge.getPendingToolCalls();
		if (pending.length === 0) return;

		const [first] = pending;
		if (!first) return;
		this.admitted = [first];
		this.toolCallIds = [first.id];
		this.turn.admit([{ type: "toolCall", id: first.id, name: first.name, arguments: first.arguments }]);
		this.conversation.push(...structuredClone(conversationForReuse([this.turn.getMessage()])));
		if (this.sessionId) addLiveProcess(this);
		else this.kill();
	}

	canContinue(owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], results: ToolResultMessage[]): boolean {
		const conversation = conversationForReuse(messages);
		return !this.stopping && owner === this.owner && !!sessionId && sessionId === this.sessionId
			&& isDeepStrictEqual(configuration, this.configuration)
			&& isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation)
			&& conversation.length === this.conversation.length + this.admitted.length
			&& results.length === this.admitted.length
			&& new Set(results.map((result) => result.toolCallId)).size === results.length
			&& this.admitted.every((call) => results.some((result) => result.toolCallId === call.id && result.toolName === call.name));
	}

	continueTurn(turn: AgyTurn, messages: Message[], results: ToolResultMessage[], signal: AbortSignal | undefined): void {
		removeLiveProcess(this);
		const admitted = this.admitted;
		this.admitted = [];
		this.conversation = structuredClone(conversationForReuse(messages));
		this.turn = turn;
		this.turn.setContextWindow(this.contextWindow);
		this.turn.setUsedTokens(this.usedTokens);
		this.setSignal(signal);
		if (this.stopping) return;
		for (const call of admitted) {
			const result = results.find((candidate) => candidate.toolCallId === call.id)!;
			this.bridge.resolveToolCall(call, result);
		}
		this.grantNextPermission();
		this.flushAdmissions();
	}

	kill(): void {
		removeLiveProcess(this);
		if (this.stopping || this.closed) return;
		this.stopping = true;
		for (const pending of this.rpcPending.values()) {
			pending.reject(new Error("agy CLI closed"));
		}
		this.rpcPending.clear();
		this.permissionQueue.length = 0;
		if (this.child.stdin.writable) this.child.stdin.end();
		this.child.kill();
		this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
		this.killTimer.unref();
	}

	fail(message: string): void {
		if (this.sessionId && this.turn.finished && this.toolCallIds.length > 0) this.pendingError = message;
		this.turn.fail(message, "error");
		this.kill();
		if (this.pendingError) addLiveProcess(this);
	}

	consumeFailure(owner: symbol, turn: AgyTurn): boolean {
		if (owner !== this.owner || !this.pendingError) return false;
		const message = this.pendingError;
		this.pendingError = undefined;
		this.kill();
		turn.fail(message, "error");
		return true;
	}

	cancelCall(call: PendingToolCall): void {
		if (this.stopping || this.closed || this.pendingError) return;
		if (this.turn.finished && this.admitted.some((admitted) => admitted.id === call.id)) {
			this.retireAdmittedWait();
			return;
		}
		if (this.activePermission?.acpToolCallId === call.id) {
			this.activePermission = null;
			this.grantNextPermission();
		}
	}

	private retireAdmittedWait(): void {
		if (this.stopping || this.closed || this.pendingError) return;
		this.admitted = [];
		this.toolCallIds = [];
		this.kill();
	}

	private readonly abort = () => {
		if (this.acpSessionId && !this.stopping && !this.closed) {
			this.writeRpc({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.acpSessionId } });
		}
		this.turn.fail(ABORT_MESSAGE, "aborted");
		this.kill();
	};

	private setSignal(signal: AbortSignal | undefined): void {
		this.signal?.removeEventListener("abort", this.abort);
		this.signal = signal;
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	private writeRpc(payload: object): void {
		if (this.stopping || this.closed || !this.child.stdin.writable) return;
		this.child.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	private sendRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = this.nextRpcId++;
		return new Promise((resolve, reject) => {
			if (this.stopping || this.closed) {
				reject(new Error("agy CLI closed"));
				return;
			}
			this.rpcPending.set(id, { resolve, reject });
			this.writeRpc({ jsonrpc: "2.0", id, method, params });
		});
	}

	private async runSession(input: AgyInput): Promise<void> {
		try {
			await this.sendRequest("initialize", { protocolVersion: 1 });
			if (this.stopping) return;

			const session = await this.sendRequest("session/new", {
				cwd: this.files.cwd,
				mcpServers: input.tools.length > 0 ? [this.bridge.mcpServer] : [],
				_meta: {
					antigravity: {
						systemPrompt: { append: input.systemPrompt },
					},
				},
			});
			const sessionId = typeof session.sessionId === "string" ? session.sessionId : "";
			if (!sessionId) throw new Error("agy CLI did not return an ACP sessionId");
			this.acpSessionId = sessionId;
			if (this.stopping) return;

			await this.sendRequest("session/set_model", {
				sessionId,
				modelId: this.acpModelId,
			});
			if (this.stopping) return;

			const result = await this.sendRequest("session/prompt", {
				sessionId,
				prompt: input.promptBlocks,
			});
			if (this.stopping) return;

			if (this.turn.finished || this.admitted.length > 0 || this.activePermission !== null) {
				this.fail("agy CLI moved on while harness tool calls were waiting for results");
				return;
			}

			const stopReason = typeof result.stopReason === "string" ? result.stopReason : undefined;
			const usage = result.usage && typeof result.usage === "object" ? (result.usage as AcpUsage) : undefined;
			this.turn.complete(stopReason, usage);
			this.kill();
		} catch (error) {
			if (this.stopping) return;
			const message = error instanceof Error ? error.message : String(error);
			this.fail(isNotSignedInError(message) ? AgyError.NotSignedIn : message);
		}
	}

	private handleRpcMessage(msg: RpcMessage): void {
		if (msg.id !== undefined && msg.method === undefined && this.rpcPending.has(msg.id)) {
			const entry = this.rpcPending.get(msg.id)!;
			this.rpcPending.delete(msg.id);
			if (msg.error) {
				const errMsg = typeof msg.error.message === "string" ? msg.error.message : "agy CLI request failed";
				entry.reject(new Error(errMsg));
			} else {
				entry.resolve(msg.result ?? {});
			}
			return;
		}

		if (msg.method === "session/request_permission" && msg.id !== undefined) {
			this.handlePermissionRequest(msg.id, msg.params ?? {});
			return;
		}

		if (msg.method === "session/update") {
			this.handleSessionUpdate(msg.params ?? {});
		}
	}

	private handlePermissionRequest(rpcId: number | string, params: Record<string, unknown>): void {
		const toolCall = params.toolCall && typeof params.toolCall === "object" ? (params.toolCall as Record<string, unknown>) : {};
		const rawName = typeof toolCall.name === "string" ? toolCall.name : "";
		const acpToolCallId = typeof toolCall.toolCallId === "string" && toolCall.toolCallId.trim()
			? toolCall.toolCallId
			: `agy_call_${rpcId}`;
		const options = Array.isArray(params.options) ? (params.options as PermissionOption[]) : [];
		const allowOption = options.find((opt) => opt.kind === "allow_once") ?? options.find((opt) => opt.optionId === "allow");
		const rejectOption = options.find((opt) => opt.kind === "reject_once") ?? options.find((opt) => opt.optionId === "deny");
		const rejectOptionId = typeof rejectOption?.optionId === "string" ? rejectOption.optionId : null;

		const bareName = toolNameFromMcp(rawName);
		const isAllowedHarnessTool = rawName === mcpNameForTool(bareName)
			&& this.harnessToolNames.has(bareName)
			&& typeof allowOption?.optionId === "string";

		if (!isAllowedHarnessTool) {
			this.replyPermission(rpcId, rejectOptionId);
			return;
		}

		this.permissionQueue.push({
			rpcId,
			acpToolCallId,
			toolName: bareName,
			allowOptionId: allowOption.optionId as string,
			rejectOptionId,
		});
		this.grantNextPermission();
	}

	private grantNextPermission(): void {
		if (this.stopping || this.turn.finished || this.activePermission !== null || this.admitted.length > 0) return;
		const next = this.permissionQueue.shift();
		if (!next) return;
		this.activePermission = { acpToolCallId: next.acpToolCallId, toolName: next.toolName };
		this.replyPermission(next.rpcId, next.allowOptionId);
	}

	private replyPermission(rpcId: number | string, optionId: string | null): void {
		this.writeRpc({
			jsonrpc: "2.0",
			id: rpcId,
			result: optionId
				? { outcome: { outcome: "selected", optionId } }
				: { outcome: { outcome: "cancelled" } },
		});
	}

	private handleSessionUpdate(params: Record<string, unknown>): void {
		const update = params.update && typeof params.update === "object" ? (params.update as Record<string, unknown>) : null;
		if (!update) return;
		const kind = update.sessionUpdate;
		if (kind === "usage_update") {
			const size = typeof update.size === "number" ? update.size : undefined;
			if (size !== undefined && Number.isSafeInteger(size) && size > 0) {
				this.contextWindow = size;
				this.turn.setContextWindow(size);
			}
			const used = typeof update.used === "number" ? update.used : undefined;
			if (used !== undefined && Number.isSafeInteger(used) && used > 0) {
				this.usedTokens = used;
				this.turn.setUsedTokens(used);
			}
			return;
		}
		if (kind === "tool_call_update") {
			const status = typeof update.status === "string" ? update.status : "";
			const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
			if (
				toolCallId
				&& this.turn.finished
				&& (status === "failed" || status === "cancelled")
				&& this.admitted.some((admitted) => admitted.id === toolCallId)
			) {
				this.retireAdmittedWait();
				return;
			}
			if (
				toolCallId
				&& this.activePermission?.acpToolCallId === toolCallId
				&& (status === "failed" || status === "cancelled" || status === "completed")
			) {
				this.activePermission = null;
				this.grantNextPermission();
			}
			return;
		}
		if (this.turn.finished) {
			if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
				this.fail("agy CLI moved on while harness tool calls were waiting for results");
			}
			return;
		}
		const content = update.content && typeof update.content === "object" ? (update.content as Record<string, unknown>) : null;
		const text = content?.type === "text" && typeof content.text === "string" ? content.text : "";
		if (!text) return;
		if (kind === "agent_thought_chunk") this.turn.appendThinking(text);
		else if (kind === "agent_message_chunk") this.turn.appendText(text);
	}

	private handleClose(message: string): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.killTimer);
		for (const pending of this.rpcPending.values()) {
			pending.reject(new Error(message));
		}
		this.rpcPending.clear();
		removeLiveProcess(this);
		if (this.pendingError) addLiveProcess(this);
		this.signal?.removeEventListener("abort", this.abort);
		if (this.stderr.trim() && !this.turn.finished) console.error("agy CLI stderr:", this.stderr.trim());
		this.turn.fail(message, "error");
		removeTurnResources(this.bridge, this.files).catch((error: unknown) => {
			console.error("agy CLI cleanup failed:", error);
		});
	}
}

function continueLiveProcess(
	turn: AgyTurn,
	owner: symbol,
	sessionId: string | undefined,
	configuration: unknown,
	messages: Message[],
	signal: AbortSignal | undefined,
): boolean {
	const assistantIndex = messages.findLastIndex((message) => message.role === "assistant");
	const assistant = messages[assistantIndex];
	if (assistant?.role !== "assistant") return false;
	const ids = assistant.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
	const process = getLiveProcess(ids, owner, sessionId);
	if (!(process instanceof AgyProcess)) return false;
	if (process.consumeFailure(owner, turn)) return true;
	const trailing = messages.slice(assistantIndex + 1);
	const results = trailing.filter((message) => message.role === "toolResult");
	if (trailing.length !== results.length || !process.canContinue(owner, sessionId, configuration, messages, results)) {
		process.kill();
		return false;
	}
	process.continueTurn(turn, messages, results, signal);
	return true;
}

async function startProcess(
	runAgy: RunAgy,
	turn: AgyTurn,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	owner: symbol,
	configuration: unknown,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	if (options?.signal?.aborted) {
		turn.fail(ABORT_MESSAGE, "aborted");
		return;
	}
	const input = toAgyInput(context.messages);
	const harnessToolNames = new Set(getCurrentTools(context.messages).map((tool) => tool.name));
	let cliProcess: AgyProcess | undefined;
	const bridge = await createToolBridge(input.tools, {
		admitCall: (name, args) => cliProcess?.admitMcpCall(name, args) ?? null,
		onCall: () => cliProcess?.flushAdmissions(),
		onError: (error) => cliProcess?.fail(error.message),
		onCancel: (call) => cliProcess?.cancelCall(call),
	});
	let files: TurnFiles;
	try {
		files = await createTurnFiles();
	} catch (error) {
		await bridge.close();
		throw error;
	}
	if (options?.signal?.aborted) {
		turn.fail(ABORT_MESSAGE, "aborted");
		await removeTurnResources(bridge, files);
		return;
	}

	const acpModelId = toAgyModelId(model, options?.reasoning);
	let child: ChildProcessWithoutNullStreams | null;
	try {
		child = await runAgy(toAgyArgs(files.privateDir), { cwd: files.cwd, env, signal: options?.signal });
	} catch (error) {
		await removeTurnResources(bridge, files);
		throw error;
	}

	if (!child) {
		turn.fail(AgyError.CliNotFound, "error");
		await removeTurnResources(bridge, files);
		return;
	}

	cliProcess = new AgyProcess(
		child,
		bridge,
		files,
		turn,
		owner,
		options?.sessionId,
		configuration,
		structuredClone(conversationForReuse(context.messages)),
		harnessToolNames,
		acpModelId,
	);
	cliProcess.start(input, options?.signal);
}

export function createAgyStreamFunction(runAgy: RunAgy): StreamFunction<Api, SimpleStreamOptions> {
	const owner = Symbol("agy stream owner");
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new AgyTurn(stream, model);

		const env = externalCliEnv();
		const configuration = { request: configurationForReuse(model, context, toAgyModelId(model, options?.reasoning)), env };
		if (continueLiveProcess(turn, owner, options?.sessionId, configuration, context.messages, options?.signal)) return stream;

		startProcess(runAgy, turn, model, context, options, owner, configuration, env).catch((error: unknown) => {
			console.error("agy CLI turn failed:", error);
			turn.fail(
				options?.signal?.aborted ? ABORT_MESSAGE : error instanceof AgyLaunchError ? error.message : START_FAILED_MESSAGE,
				options?.signal?.aborted ? "aborted" : "error",
			);
		});

		return stream;
	};
}

export const streamAgy = createAgyStreamFunction(createAgyLauncher());
