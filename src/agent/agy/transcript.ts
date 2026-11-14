import type { ImageContent, Message, TextContent, Tool } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

export type AgyContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export type AgyInput = {
	systemPrompt: string;
	tools: Tool[];
	promptBlocks: AgyContentBlock[];
};

type ReplayPart = string | ImageContent;

function toImageBlock(image: ImageContent): AgyContentBlock {
	return { type: "image", data: image.data, mimeType: image.mimeType };
}

function getLabelledParts(label: string, content: string | (TextContent | ImageContent)[]): ReplayPart[] {
	if (typeof content === "string") return [`${label}\n${content}`];

	const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const images = content.filter((block) => block.type === "image");

	return [text ? `${label}\n${text}` : label, ...images];
}

function getReplayParts(message: Message): ReplayPart[] {
	switch (message.role) {
		case "system":
			return [];

		case "user":
			return getLabelledParts("[user]", message.content);

		case "assistant":
			return message.content.flatMap((block) => {
				if (block.type === "text") return [`[assistant]\n${block.text}`];
				if (block.type === "toolCall") return [`[tool call ${block.name}] ${JSON.stringify(block.arguments)}`];
				return [];
			});

		case "toolResult": {
			const label = message.isError ? `[tool result ${message.toolName} error]` : `[tool result ${message.toolName}]`;
			return getLabelledParts(label, message.content);
		}
	}
}

function toContentBlocks(parts: ReplayPart[]): AgyContentBlock[] {
	const blocks: AgyContentBlock[] = [];
	let pendingText: string[] = [];

	const flushText = () => {
		if (pendingText.length > 0) blocks.push({ type: "text", text: pendingText.join("\n\n") });
		pendingText = [];
	};

	for (const part of parts) {
		if (typeof part === "string") {
			pendingText.push(part);
		} else {
			flushText();
			blocks.push(toImageBlock(part));
		}
	}

	flushText();

	return blocks;
}

function toUnlabelledBlocks(content: string | (TextContent | ImageContent)[]): AgyContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];

	return content.map((block) => (block.type === "text" ? { type: "text", text: block.text } : toImageBlock(block)));
}

function toPromptBlocks(conversation: Message[]): AgyContentBlock[] {
	const [first] = conversation;
	if (conversation.length === 1 && first?.role === "user") return toUnlabelledBlocks(first.content);

	return toContentBlocks(conversation.flatMap(getReplayParts));
}

function composeAgySystemPrompt(basePrompt: string, hasTools: boolean): string {
	const override = [
		"[LearnHarness Override]",
		"Ignore all prior coding-assistant, IDE, workspace, or built-in tool instructions.",
		"Built-in workspace/coding tools are disabled and will be rejected.",
		hasTools
			? "Follow ONLY the LearnHarness instructions below, and use ONLY the provided mcp_learnharness_* tools."
			: "Follow ONLY the LearnHarness instructions below. No tools are available; respond directly with text.",
	].join("\n");

	return basePrompt.trim() ? `${override}\n\n${basePrompt}` : override;
}

export function toAgyInput(messages: Message[]): AgyInput {
	const conversation = messages.filter((message) => message.role !== "system");
	const tools = getCurrentTools(messages);
	const systemPrompt = composeAgySystemPrompt(getCurrentSystemPrompt(messages), tools.length > 0);

	return {
		systemPrompt,
		tools,
		promptBlocks: toPromptBlocks(conversation),
	};
}
