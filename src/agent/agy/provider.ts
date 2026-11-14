import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";

import { AGY_API, AGY_PROVIDER } from "./constants.ts";

const SHARED_MODEL_FIELDS = {
	api: AGY_API,
	provider: AGY_PROVIDER,
	baseUrl: "",
	// Pi-required placeholders, not prices: the CLI's own auth/routing
	// determines charges. Server pricing and the client catalog report unpriced.
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 65_536,
} satisfies Omit<Model<Api>, "id" | "name" | "input" | "reasoning" | "thinkingLevelMap">;

const LOW_HIGH_LEVELS = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } as const;
const LOW_XHIGH_LEVELS = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null } as const;
const FIXED_LEVELS = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null } as const;

export const AGY_MODELS: readonly Model<Api>[] = [
	{ ...SHARED_MODEL_FIELDS, id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", input: ["text", "image"], reasoning: true, thinkingLevelMap: LOW_XHIGH_LEVELS },
	{ ...SHARED_MODEL_FIELDS, id: "gemini-4-argon", name: "Gemini 4 Argon", input: ["text", "image"], reasoning: true, thinkingLevelMap: LOW_HIGH_LEVELS },
	{ ...SHARED_MODEL_FIELDS, id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", input: ["text", "image"], reasoning: true, thinkingLevelMap: LOW_HIGH_LEVELS },
	{ ...SHARED_MODEL_FIELDS, id: "claude-opus-5-5", name: "Claude Opus 5.5", input: ["text", "image"], reasoning: true, thinkingLevelMap: LOW_HIGH_LEVELS },
	{ ...SHARED_MODEL_FIELDS, id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", input: ["text", "image"], reasoning: true, thinkingLevelMap: LOW_HIGH_LEVELS },
	{ ...SHARED_MODEL_FIELDS, id: "gemini-pro-orchestrator-g1-pro", name: "Orchestrator (Argon)", input: ["text", "image"], reasoning: false, thinkingLevelMap: FIXED_LEVELS },
	{ ...SHARED_MODEL_FIELDS, id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", input: ["text"], reasoning: false, thinkingLevelMap: FIXED_LEVELS },
];

export function createAgyProvider(streamSimple: StreamFunction<Api, SimpleStreamOptions>): Provider {
	return createProvider({
		id: AGY_PROVIDER,
		name: "Antigravity CLI",
		auth: { apiKey: { name: "Antigravity CLI", resolve: async () => ({ auth: {}, source: "agy CLI" }) } },
		models: AGY_MODELS,
		api: { stream: streamSimple, streamSimple },
	});
}
