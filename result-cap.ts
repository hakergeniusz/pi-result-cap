// result-cap: bounds every tool result at birth. A result larger than the
// caps is head+tail truncated with a deterministic marker, so what the model
// sees is stable from its first appearance — the prompt-cache prefix never
// diverges — while per-request replay stays bounded. This complements
// token-diet (static trims) and replaces ObservationPack's mid-session
// placeholder rewrite, which changes already-sent context.
//
// Fail-open like token-diet: on any surprise the payload goes out untouched.

const MAX_LINES = 400;
const MAX_BYTES = 16 * 1024;
const HEAD_LINES = 320;
const TAIL_LINES = 72;
const HEAD_BYTES = 13 * 1024;
const TAIL_BYTES = 2 * 1024;

/**
 * Tools whose results are never capped.
 *
 * `read` bounds itself already (2000 lines / 50KB) and tells the model how to
 * page with offset/limit. Trimming a read result drops the middle of the file
 * from the context, and the model cannot get it back: read-guard blocks a
 * re-read of a range it believes is already in context, so the trimmed lines
 * are gone for good. A capped read destroys information instead of saving it,
 * and the model is pushed to shell out to `sed` for the rest of the file.
 */
const UNCAPPED_TOOLS = new Set(["read"]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const byteLen = (s: string) => encoder.encode(s).length;

// Slice by UTF-8 byte offsets, clamped to code-point boundaries so no
// character is split (a split lead/continuation byte would decode to U+FFFD
// and change between passes).
function byteSlice(text: string, startByte: number, endByte: number): string {
	const b = encoder.encode(text);
	const s = Math.max(0, Math.min(startByte, b.length));
	const e = Math.max(s, Math.min(endByte, b.length));
	let s2 = s;
	let e2 = e;
	while (s2 < e2 && (b[s2] & 0xc0) === 0x80) s2++;
	while (e2 > s2 && (b[e2] & 0xc0) === 0x80) e2--;
	return decoder.decode(b.subarray(s2, e2));
}

function capLines(text: string): string {
	const lines = text.split("\n");
	if (lines.length <= MAX_LINES) return text;
	const omitted = lines.length - HEAD_LINES - TAIL_LINES;
	const marker =
		`\n[... ${omitted} of ${lines.length} lines omitted (output capped). ` +
		`For files use read with offset/limit to page; for command output re-run with a narrower scope (rg, sed -n, tail) ...]\n`;
	return lines.slice(0, HEAD_LINES).join("\n") + marker + lines.slice(lines.length - TAIL_LINES).join("\n");
}

function capBytes(text: string): string {
	const size = byteLen(text);
	if (size <= MAX_BYTES) return text;
	const head = byteSlice(text, 0, HEAD_BYTES);
	const tail = byteSlice(text, size - TAIL_BYTES, size);
	const omitted = size - byteLen(head) - byteLen(tail);
	const marker =
		`\n[... ~${omitted} bytes omitted (output capped at ${MAX_BYTES} bytes). ` +
		`Re-run with a narrower scope (rg, sed -n, head/tail) or page a file with read offset/limit ...]\n`;
	return head + marker + tail;
}

export function capToolText(text: string): string {
	return capBytes(capLines(text));
}

function capContent(content: unknown): unknown {
	if (typeof content === "string") return capToolText(content);
	if (!Array.isArray(content)) return content;
	return content.map((b) =>
		b && typeof b === "object" && (b as Record<string, unknown>).type === "text" &&
		typeof (b as Record<string, unknown>).text === "string"
			? { ...(b as Record<string, unknown>), text: capToolText((b as Record<string, unknown>).text as string) }
			: b,
	);
}

/**
 * Map every tool call id in the transcript to the tool that produced it, so a
 * tool result can be recognised by name. Provider payloads carry the id, not
 * the name, so the name has to come from the assistant turn that made the
 * call.
 */
export function collectToolNames(messages: unknown[]): Map<string, string> {
	const names = new Map<string, string>();
	const addCalls = (calls: unknown) => {
		if (!Array.isArray(calls)) return;
		for (const tc of calls as Record<string, unknown>[]) {
			const id = tc?.id;
			const fn = tc?.function as Record<string, unknown> | undefined;
			const name = typeof fn?.name === "string" ? fn.name : typeof tc?.name === "string" ? tc.name : undefined;
			if (typeof id === "string" && name) names.set(id, name);
		}
	};
	for (const m of messages) {
		if (!m || typeof m !== "object") continue;
		const msg = m as Record<string, unknown>;
		// OpenAI-style assistant message: { tool_calls: [{ id, function: { name } }] }
		addCalls(msg.tool_calls);
		const content = msg.content;
		if (!Array.isArray(content)) continue;
		for (const b of content as Record<string, unknown>[]) {
			if (!b || typeof b !== "object") continue;
			// Anthropic-style assistant block: { type: "tool_use", id, name }
			if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
				names.set(b.id, b.name);
			}
			addCalls(b.tool_calls);
		}
	}
	return names;
}

function isUncapped(name: string | undefined): boolean {
	return name !== undefined && UNCAPPED_TOOLS.has(name);
}

export default function (pi: any) {
	pi.on("before_provider_request", (event: { payload: unknown }) => {
		try {
			const payload = event?.payload as Record<string, unknown> | undefined;
			if (!payload || !Array.isArray(payload.messages)) return;
			const messages = payload.messages;
			const toolNames = collectToolNames(messages);
			for (const m of messages) {
				if (!m || typeof m !== "object") continue;
				const msg = m as Record<string, unknown>;
				if (msg.role === "tool") {
					// OpenAI-style tool message
					const id = typeof msg.tool_call_id === "string" ? msg.tool_call_id : undefined;
					const name = typeof msg.name === "string" ? msg.name : id ? toolNames.get(id) : undefined;
					if (isUncapped(name)) continue;
					msg.content = capContent(msg.content);
				} else if (Array.isArray(msg.content)) {
					// Anthropic-style tool_result blocks riding in any message
					for (const b of msg.content as Record<string, unknown>[]) {
						if (b && typeof b === "object" && b.type === "tool_result") {
							const id = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined;
							const name = id ? toolNames.get(id) : undefined;
							if (isUncapped(name)) continue;
							b.content = capContent(b.content);
						}
					}
				}
			}
		} catch {
			// a cap bug must never break the request — payload stays as pi built it
		}
	});
}
