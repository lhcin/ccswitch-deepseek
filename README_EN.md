# ccswitch-deepseek

[中文](README.md)

---

Codex CLI / Claude CLI -> OpenCode.ai DeepSeek proxy. The native DeepSeek API supports Claude CLI, but **OpenCode.ai's interface is not fully compatible**. This project runs a local protocol translation proxy, converting OpenCode.ai's Chat Completions format to what Codex and Claude CLI expect.

**Supported clients**:

- `/v1/responses` → Codex CLI (OpenAI Responses API)
- `/v1/messages` → Claude CLI (Anthropic Messages API)

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

Copy `env_example` and rename it to `.env`, then edit:

```
api_key=sk-your-deepseek-api-key
```

### 4. Start the Service

```bash
npm start
```

Once running, Codex CLI will automatically connect to DeepSeek through this proxy.

## Files

| File | Description |
|------|-------------|
| `index.js` | HTTP server entry |
| `lib/log.js` | Colored logging |
| `lib/translate.js` | Input translation (Responses -> Chat) |
| `lib/sse.js` | SSE event translation (Chat -> Responses) |
| `lib/sse-messages.js` | SSE message builder |
| `lib/recover.js` | reasoning_content auto-restore |
| `patch-index.cjs` | Patch script for index.js |
| `patch-recover.cjs` | Patch script for recover.js |
| `test_translate.js` | 33 unit tests |
| `start.bat` / `start-hidden.vbs` | Windows launch scripts |
| `setup-autostart.ps1` / `setup-autostart-user.ps1` | Autostart configuration |

## Translations

### Input (Responses -> Chat Completions)

- message items (`input_text` / `output_text` / `reasoning_text`)
- `function_call` -> assistant `tool_calls`
- `function_call_output` -> `tool` message
- `reasoning` items (skip, retain `reasoning_content`)
- `developer` role -> `system`
- `input_image` -> `image_url` (multimodal)
- `input_file` / `input_audio` -> skip with stats

### Output (Chat Completions -> Responses SSE)

- `response.created` / `in_progress` / `completed`
- `output_item.added` / `done`
- `output_text.delta` / `done` + `content_part.added` / `done`
- `reasoning_text.delta` / `done` + `content_part.added` / `done`
- `function_call_arguments.delta` / `done`
- `usage` (token stats) in `response.completed`

### Parameters

- `instructions` -> system message
- `temperature` / `top_p` / `max_output_tokens` passthrough
- `tools` / `tool_choice` translation
- `thinking` / `reasoning` -> DeepSeek thinking mode
- `reasoning_content` auto-restore across rounds

## Tests

```bash
npm run test:translate
```

33 unit tests covering all translation logic.

## License

ISC
