# pi-result-cap

Bounds every tool result at birth. A result over the caps is head+tail
truncated with a deterministic marker, so what the model sees is stable from
its first appearance — the prompt-cache prefix never diverges — while
per-request replay stays bounded.

Complements [token-diet](https://github.com/hakergeniusz/pi-token-diet) (static
trims). Replaces ObservationPack's mid-session placeholder rewrite, which
changes already-sent context.

## Install

Symlink into the global extensions dir, or install as a pi package:

```sh
gh repo clone hakergeniusz/pi-result-cap
cp pi-result-cap/result-cap.ts ~/.pi/agent/extensions/result-cap.ts
```

Or add to `packages` in `~/.pi/agent/settings.json`:

```json
"packages": ["git:github.com/hakergeniusz/pi-result-cap"]
```

## Caps

| Limit | Value |
| --- | --- |
| Max lines | 400 (keep first 320, last 72) |
| Max bytes | 16 KiB (keep first 13 KiB, last 2 KiB) |

Both apply, lines first, then bytes. The truncation marker names the omitted
count and tells the model how to page instead (`read` with `offset/limit`, or a
narrower command).

Byte slicing clamps to code-point boundaries so a multi-byte character is never
split — a split lead/continuation byte decodes to U+FFFD and would change
between passes, breaking cache stability.

Handles both OpenAI-style `role: "tool"` messages and Anthropic-style
`tool_result` blocks inside any message.

## Failure mode

Fail-open. On any error the payload goes out exactly as pi built it. A cap bug
must never break a request.