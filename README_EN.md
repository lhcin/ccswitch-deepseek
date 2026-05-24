# ccswitch-deepseek

[中文](README.md)

---

This project provides a protocol translation proxy for Codex CLI and Claude CLI, enabling them to work with DeepSeek and OpenCode.ai.

- **Codex CLI**: Supports both **DeepSeek** and **OpenCode.ai** through this proxy (translates Responses API → Chat Completions)
- **Claude CLI**: The native DeepSeek API already works; this project focuses on adding **OpenCode.ai compatibility** (translates Messages API → Chat Completions)

## Quick Start

### 1. Install Node.js

This project requires Node.js. Download and install the latest LTS version from [nodejs.org](https://nodejs.org/).

Verify the installation in your terminal:

```bash
node --version
npm --version
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure API Key

Copy `.env_example` and rename it to `.env`, then edit:

```
api_key=sk-your-deepseek-api-key
```

### 4. Start the Service

```bash
npm start
```

Once running, start Codex CLI or Claude CLI to connect through this proxy to DeepSeek / OpenCode.ai.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `api_key` | (required) | API Key |
| `model` | `deepseek-v4-flash` | Model name |
| `port` | `11435` | Server port |
| `base_url` | `https://opencode.ai/zen/go/v1` | Upstream API URL |
| `is_deepseek` | `true` | Inject identity prompt |
| `skip_title_gen` | `true` | Skip title generation intercept |
| `max_body_size` | `10485760` | Max request body size (10MB) |

## Files

| File | Description |
|------|-------------|
| `index.js` | HTTP server entry |
| `lib/log.js` | Colored logging |
| `lib/translate.js` | Input translation (Responses -> Chat) |
| `lib/sse.js` | SSE event translation (Chat -> Responses) |
| `lib/sse-messages.js` | SSE message builder |
| `lib/recover.js` | reasoning_content auto-restore |
| `test_translate.js` | 29 unit tests |
| `start.bat` | Windows launch script |

## Translations

### Codex CLI (Responses API → Chat Completions)

#### Input Translation

- message items (`input_text` / `output_text` / `reasoning_text`)
- `function_call` -> assistant `tool_calls`
- `function_call_output` -> `tool` message
- `reasoning` items (skip, retain `reasoning_content`)
- `developer` role -> `system`
- `input_image` -> `image_url` (multimodal)
- `input_file` / `input_audio` -> skip with stats

#### Output Translation (Chat Completions -> Responses SSE)

- `response.created` / `in_progress` / `completed`
- `output_item.added` / `done`
- `output_text.delta` / `done` + `content_part.added` / `done`
- `reasoning_text.delta` / `done` + `content_part.added` / `done`
- `function_call_arguments.delta` / `done`
- `usage` (token stats) in `response.completed`

#### Parameters

- `instructions` -> system message
- `temperature` / `top_p` / `max_output_tokens` passthrough
- `tools` / `tool_choice` translation
- `thinking` / `reasoning` -> DeepSeek thinking mode
- `reasoning_content` auto-restore across rounds

### Claude CLI (Messages API → Chat Completions)

#### Input Translation

- `system` (string / content array) -> system message
- `user` message (text content array) -> user message
- `assistant` reasoning_content -> Chat Completions `reasoning_content`
- `assistant` tool_calls -> Chat Completions `tool_calls`
- `tool` message -> `tool` role message

#### Output Translation (Chat Completions -> Messages API JSON)

- `id` / `object` / `model` / `created` construction
- `content` (text blocks) assembly
- `tool_use` blocks (id, name, input)
- `stop_reason` mapping (tool_calls -> tool_use, length -> max_tokens, stop -> end_turn)
- `usage` (input_tokens, output_tokens)

## Tests

```bash
npm run test:translate
```

29 unit tests covering Responses API translation logic.

## License

ISC
