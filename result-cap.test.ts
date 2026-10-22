/**
 * result-cap tests: `bun test`
 *
 * The contract that matters: a read result is never trimmed. A trimmed read
 * loses the middle of the file, and read-guard then refuses to re-read the
 * range it believes is already in context, so the lines are gone for good.
 */
import { describe, expect, test } from "bun:test";
import resultCap, { capToolText, collectToolNames } from "./result-cap.ts";

type Handler = (event: any) => unknown;

function load() {
	const handlers: Record<string, Handler[]> = {};
	resultCap({
		on: (event: string, handler: Handler) => {
			(handlers[event] ??= []).push(handler);
		},
	});
	return (event: string, payload: unknown) => {
		for (const h of handlers[event] ?? []) h({ type: event, payload });
	};
}

function longText(lines: number): string {
	return Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("capToolText", () => {
	test("leaves small output alone", () => {
		expect(capToolText("hello")).toBe("hello");
	});

	test("caps long output with a marker", () => {
		const out = capToolText(longText(1000));
		expect(out).toContain("lines omitted (output capped)");
		expect(out.length).toBeLessThan(longText(1000).length);
	});
});

describe("read results are never capped", () => {
	test("OpenAI-style tool message", () => {
		const fire = load();
		const content = longText(1000);
		const payload = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "read" }],
				},
				{ role: "tool", tool_call_id: "call_1", content },
			],
		};
		// pi's OpenAI payload puts the call in `tool_calls`, the Anthropic one in a content block.
		(payload.messages[0] as any).content = undefined;
		(payload.messages[0] as any).tool_calls = [{ id: "call_1", type: "function", function: { name: "read" } }];

		fire("before_provider_request", payload);
		expect((payload.messages[1] as any).content).toBe(content);
	});

	test("Anthropic-style tool_result block", () => {
		const fire = load();
		const content = longText(1000);
		const payload = {
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: "call_2", name: "read" }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: content }] }] },
			],
		};
		fire("before_provider_request", payload);
		const block = (payload.messages[1] as any).content[0];
		expect(block.content[0].text).toBe(content);
	});
});

describe("other tool results are still capped", () => {
	test("bash output", () => {
		const fire = load();
		const content = longText(1000);
		const payload = {
			messages: [
				{ role: "assistant", tool_calls: [{ id: "call_3", type: "function", function: { name: "bash" } }] },
				{ role: "tool", tool_call_id: "call_3", content },
			],
		};
		fire("before_provider_request", payload);
		expect((payload.messages[1] as any).content).not.toBe(content);
		expect((payload.messages[1] as any).content).toContain("omitted");
	});
});

describe("collectToolNames", () => {
	test("reads names from both payload shapes", () => {
		const names = collectToolNames([
			{ role: "assistant", tool_calls: [{ id: "a", function: { name: "read" } }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "b", name: "bash" }] },
		]);
		expect(names.get("a")).toBe("read");
		expect(names.get("b")).toBe("bash");
	});
});

describe("fail-open", () => {
	test("a malformed payload is left untouched", () => {
		const fire = load();
		const payload = { messages: "not an array" };
		expect(() => fire("before_provider_request", payload)).not.toThrow();
		expect(payload.messages).toBe("not an array");
	});
});
