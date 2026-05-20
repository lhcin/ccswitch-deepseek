# ccswitch-deepseek

[English](README_EN.md)

---

本项目为 Codex CLI 和 Claude CLI 提供协议转换代理，使它们能够对接 DeepSeek 和 OpenCode.ai。

- **Codex CLI**：通过本代理同时支持 **DeepSeek** 和 **OpenCode.ai**（翻译 Responses API → Chat Completions）
- **Claude CLI**：原生 DeepSeek API 已支持，本项目重点解决 **OpenCode.ai 的兼容问题**（翻译 Messages API → Chat Completions）

## 快速开始

### 1. 安装 Node.js

本项目需要 Node.js 环境。请访问 [Node.js 官网](https://nodejs.org/) 下载并安装最新 LTS 版本。

安装完成后，在命令行中验证：

（在这个项目文件夹中点击右键出现菜单打开命令行）

![在终端中打开](./image.png)

```bash
node --version
npm --version
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置 API Key

复制 `env_example` 后命名为 `.env` 并编辑：

```
api_key=sk-your-deepseek-api-key
```

### 4. 启动服务

```bash
npm start
```

服务启动后，运行 Codex CLI 或 Claude CLI 即可通过本代理连接 DeepSeek / OpenCode.ai。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `api_key` | (必填) | API Key |
| `model` | `deepseek-v4-flash` | 模型名 |
| `port` | `11435` | 服务端口 |
| `base_url` | `https://opencode.ai/zen/go/v1` | 上游 API 地址 |
| `is_deepseek` | `true` | 是否注入身份提示 |
| `skip_title_gen` | `true` | 是否跳过标题生成拦截 |
| `max_body_size` | `10485760` | 最大请求体大小 (10MB) |

## 文件结构

| 文件 | 说明 |
|------|------|
| `index.js` | HTTP 服务主入口 |
| `lib/log.js` | 彩色日志工具 |
| `lib/translate.js` | 输入翻译 (Responses -> Chat) |
| `lib/sse.js` | SSE 事件翻译 (Chat -> Responses) |
| `lib/sse-messages.js` | SSE 消息构建 (Messages API) |
| `lib/recover.js` | reasoning_content 自动记忆与补回 |
| `patch-index.cjs` | index.js 补丁脚本 |
| `patch-recover.cjs` | recover.js 补丁脚本 |
| `test_translate.js` | 翻译逻辑单元测试 (29 用例) |
| `start.bat` | Windows 启动脚本 |

## 翻译覆盖

### Codex CLI（Responses API → Chat Completions）

#### 输入翻译

- message items (`input_text` / `output_text` / `reasoning_text`)
- `function_call` -> assistant `tool_calls`
- `function_call_output` -> `tool` message
- `reasoning` items（跳过，保留 `reasoning_content`）
- `developer` role -> `system`
- `input_image` -> `image_url`（多模态）
- `input_file` / `input_audio` -> 跳过统计

#### 输出翻译 (Chat Completions -> Responses SSE)

- `response.created` / `in_progress` / `completed`
- `output_item.added` / `done`
- `output_text.delta` / `done` + `content_part.added` / `done`
- `reasoning_text.delta` / `done` + `content_part.added` / `done`
- `function_call_arguments.delta` / `done`
- `usage` token 统计（`response.completed` 中）

#### 请求参数

- `instructions` -> system message
- `temperature` / `top_p` / `max_output_tokens` 透传
- `tools` / `tool_choice` 翻译
- `thinking` / `reasoning` -> DeepSeek thinking 模式
- `reasoning_content` 跨轮次自动补回

### Claude CLI（Messages API → Chat Completions）

#### 输入翻译

- `system` (string / content array) -> system message
- `user` message (text content array) -> user message
- `assistant` reasoning_content -> Chat Completions `reasoning_content`
- `assistant` tool_calls -> Chat Completions `tool_calls`
- `tool` message -> `tool` role message

#### 输出翻译 (Chat Completions -> Messages API JSON)

- `id` / `object` / `model` / `created` 构建
- `content` (text blocks) 组装
- `tool_use` blocks (id, name, input)
- `stop_reason` 映射 (tool_calls -> tool_use, length -> max_tokens, stop -> end_turn)
- `usage` (input_tokens, output_tokens)

## 运行测试

```bash
npm run test:translate
```

29 个翻译逻辑单元测试（覆盖 Responses API 翻译），不依赖网络。

## License

ISC
