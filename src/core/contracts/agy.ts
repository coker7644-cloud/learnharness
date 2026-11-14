import { CLAUDE_CODE_PROVIDER } from "./claude-code.ts";

export const AGY_PROVIDER = "agy";

/** Installation/version only. Never an authentication, quota, or billing verdict. */
export interface AgyStatus {
	state: "not-found" | "meets-minimum" | "update-required" | "version-unchecked";
	version: string | null;
	minimumVersion: string;
}

/** Minimum tested Antigravity CLI version supporting ACP HTTP MCP + systemPrompt.append. */
export const AGY_MINIMUM_VERSION = "1.5.0";

export function isCliProvider(provider: string | undefined): boolean {
	return provider === CLAUDE_CODE_PROVIDER || provider === AGY_PROVIDER;
}
