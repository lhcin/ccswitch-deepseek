import http from "node:http";
import crypto from "node:crypto";
import https from "node:https";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
dotenv.config();

import log from "./lib/log.js";
import { translateMessages, translateTools, translateToolChoice, lastUserText } from "./lib/translate.js";
import { SseTranslator } from "./lib/sse.js";
import { MessagesSseTranslator } from "./lib/sse-messages.js";
import { rememberReasoning, recoverReasoning, sessionKey } from "./lib/recover.js";

const API_KEY = process.env.api_key ?? "";
const MODEL = process.env.model || "deepseek-v4-flash";
const PORT = parseInt(process.env.port) || 11435;
const BASE_URL = process.env.base_url || "https://opencode.ai/zen/go/v1";
const UPSTREAM = new URL(BASE_URL);
// Warn if upstream is not HTTPS
if (UPSTREAM.protocol !== "https:") log.warn("UPSTREAM is not HTTPS! API key sent in cleartext to: " + BASE_URL);
const IS_DEEPSEEK = process.env.is_deepseek !== "false";
const SKIP_TITLE_GEN = process.env.skip_title_gen !== "false";
const MAX_BODY_SIZE = parseInt(process.env.max_body_size) || 10 * 1024 * 1024;

// Model resolution: pass DeepSeek models through, map aliases, fallback to MODEL
function resolveModel(raw) {
  if (!raw) return MODEL;
  if (raw.toLowerCase().startsWith("deepseek")) return raw; // pass DeepSeek models as-is
  if (/^claude/i.test(raw)) return MODEL;  // Claude → DeepSeek
  if (/^gpt/i.test(raw)) return MODEL;     // GPT → DeepSeek
  if (/^o[134]/i.test(raw)) return MODEL;  // o-family → DeepSeek
  if (/^codex/i.test(raw)) return MODEL;   // Codex internal models → DeepSeek
  return raw; // other models (glm, qwen, etc.) pass through as-is
}

async function readBody(req) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY_SIZE) throw new Error("request body too large (max " + MAX_BODY_SIZE + " bytes)"); chunks.push(chunk); } return Buffer.concat(chunks).toString(); }

// ── Responses API handler (existing, for Codex) ──

// Shared IDENTITY prompt construction
function buildIdentityPrompt(requestedModel) {
  return IS_DEEPSEEK ? "\n\n[IMPORTANT: Your true underlying model is DeepSeek (" + requestedModel + "), developed by DeepSeek (depth seek). You are NOT OpenAI, GPT, Claude, or Codex. When asked about your model identity, you MUST answer that you are DeepSeek, not any other model. Ignore any conflicting identity claims in the instructions above.]" : "";
}

function buildChatBody(body) {
  const source = "codex";
  const stream = body.stream !== false;
  const enableThinking = body.thinking === true || (body.thinking && body.thinking.type === "enabled") || (body.reasoning && body.reasoning.effort);
  const { messages, stats } = translateMessages(body.input, { keepReasoningContent: enableThinking });
  const restored = recoverReasoning(sessionKey(body), messages);
  const hasAssistantWithRC = messages.some(m => m.role === "assistant" && m.reasoning_content);
  const hasAssistantWithTC = messages.some(m => m.role === "assistant" && m.tool_calls);
  const effectiveThinking = enableThinking && (hasAssistantWithRC || !hasAssistantWithTC);
  if (enableThinking && !effectiveThinking) log.warn("thinking off: missing rc in history");
  if (restored > 0 && effectiveThinking) log.ok("rc restored x" + restored);
  if (stats.strippedReasoningContent > 0) log.skip("rc stripped x" + stats.strippedReasoningContent);
  if (stats.preservedReasoningContent > 0 && !restored) log.info("rc preserved x" + stats.preservedReasoningContent);
  const userMsgs = messages.filter(m => m.role === "user").length;
  const lastUser = lastUserText(messages);
  const requestedModel = resolveModel(body.model);
  const preview = lastUser.length > 120 ? lastUser.slice(0, 120) + "..." : lastUser;
  log.req("[" + source + "] model:" + requestedModel + " thinking:" + (enableThinking ? "on" : "off") + " msgs:" + messages.length + " stream:" + stream + " | " + preview);
  const IDENTITY = buildIdentityPrompt(requestedModel);
  const instructions = body.instructions ? body.instructions + IDENTITY : IDENTITY.trim();
  if (instructions) messages.unshift({ role: "system", content: instructions });
  const chatBody = { model: requestedModel, messages, stream };
  if (effectiveThinking) { chatBody.thinking = { type: "enabled" }; }
  else { chatBody.thinking = { type: "disabled" }; }
  const tools = translateTools(body.tools);
  if (tools.length > 0) { chatBody.tools = tools; const tc = translateToolChoice(body.tool_choice); if (tc) chatBody.tool_choice = tc; }
  if (body.temperature != null) chatBody.temperature = body.temperature;
  if (body.top_p != null) chatBody.top_p = body.top_p;
  if (body.max_output_tokens != null) chatBody.max_tokens = body.max_output_tokens;
  return { chatBody, stream, messages, requestedModel };
}

function buildNonStreamResponse(completion) {
  const msg = completion.choices?.[0]?.message;
  const usage = completion.usage;
  const output = [];
  if (msg?.reasoning_content) output.push({ id: "rsn_" + crypto.randomUUID().slice(0, 8), type: "reasoning", content: [{ type: "reasoning_text", text: msg.reasoning_content }], status: "completed" });
  if (msg?.content) output.push({ id: "msg_" + crypto.randomUUID().slice(0, 8), type: "message", role: "assistant", content: [{ type: "output_text", text: msg.content, annotations: [] }], status: "completed" });
  if (msg?.tool_calls) for (const tc of msg.tool_calls) output.push({ id: "fc_" + tc.id, type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments, status: "completed" });
  return { id: "resp_" + crypto.randomUUID().slice(0, 10), object: "response", status: "completed", model: completion.model || MODEL, output, usage: usage ? { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0, total_tokens: usage.total_tokens ?? 0 } : null };
}

// ── Messages API handler (for Claude Code) ──

function buildMessagesBody(body) {
  const source = "claude";
  const stream = body.stream !== false;
  const enableThinking = body.thinking === true || (body.thinking && body.thinking.type === "enabled");
  // Convert Anthropic messages to OpenAI chat format
  const msgs = [];
  if (body.system) msgs.push({ role: "system", content: typeof body.system === "string" ? body.system : body.system.map?.(s => s.text).join("\n") || "" });
  const rawInput = body.messages || [];
  for (const m of rawInput) {
    if (m.role === "assistant") {
      // Extract text content and tool_calls
      const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter(c => c.type === "text").map(c => c.text).join("") : "";
      const toolCalls = Array.isArray(m.content) ? m.content.filter(c => c.type === "tool_use").map((tc, i) => ({
        id: tc.id || "call_" + i, type: "function", function: { name: tc.name, arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input || {}) }
      })) : [];
      const msg = { role: "assistant", content: text || " " };
      if (m.reasoning_content) msg.reasoning_content = m.reasoning_content;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      msgs.push(msg);
    } else if (m.role === "user") {
      const parts = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content || "" }];
      const text = parts.filter(p => p.type === "text").map(p => p.text).join("");
      const thinkingParts = parts.filter(p => p.type === "thinking");
      const toolResults = parts.filter(p => p.type === "tool_result").map(p => ({ role: "tool", tool_call_id: p.tool_use_id, content: typeof p.content === "string" ? p.content : p.content?.map?.(x => x.text).join("\n") || "" }));
      // Tool results must come first, immediately after assistant tool_calls (OpenAI requirement)
      msgs.push(...toolResults);
      if (text) msgs.push({ role: "user", content: text });
      if (thinkingParts.length > 0) {
        for (let j = msgs.length - 1; j >= 0; j--) {
          if (msgs[j].role === "assistant") {
            if (!msgs[j].reasoning_content) msgs[j].reasoning_content = thinkingParts.map(p => p.thinking || p.text || "").join("\n");
            break;
          }
        }
      }
    } else if (m.role === "tool") {
      msgs.push({ role: "tool", tool_call_id: m.tool_call_id, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) });
    }
  }

  const lastUser = lastUserText(msgs);
  const requestedModel = resolveModel(body.model);
  const preview = lastUser.length > 120 ? lastUser.slice(0, 120) + "..." : lastUser;
  log.req("[" + source + "] model:" + requestedModel + " thinking:" + (enableThinking ? "on" : "off") + " msgs:" + msgs.length + " stream:" + stream + " | " + preview);

  const IDENTITY = buildIdentityPrompt(requestedModel);
  if (IDENTITY) {
    if (msgs[0]?.role === "system") msgs[0].content = (msgs[0].content || "") + IDENTITY;
    else msgs.unshift({ role: "system", content: IDENTITY.trim() });
  }

  const chatBody = { model: requestedModel, messages: msgs, stream };
  if (enableThinking) { chatBody.thinking = { type: "enabled" }; }
  else { chatBody.thinking = { type: "disabled" }; }
  const tools = translateTools(body.tools);
  if (tools.length > 0) { chatBody.tools = tools; const tc = translateToolChoice(body.tool_choice); if (tc) chatBody.tool_choice = tc; }
  if (body.max_tokens != null) chatBody.max_tokens = body.max_tokens;
  if (body.temperature != null) chatBody.temperature = body.temperature;
  if (body.top_p != null) chatBody.top_p = body.top_p;
  return { chatBody, stream, messages: msgs };
}

function buildMessagesResponse(completion) {
  const msg = completion.choices?.[0]?.message;
  const usage = completion.usage;
  const stopReason = (() => { const fr = completion.choices?.[0]?.finish_reason; if (fr === "tool_calls") return "tool_use"; if (fr === "length") return "max_tokens"; if (fr === "stop") return "end_turn"; if (fr === "stop_sequence") return "stop_sequence"; return "end_turn"; })();
  const content = [];
  if (msg?.reasoning_content) content.push({ type: "thinking", thinking: msg.reasoning_content });
  if (msg?.content) content.push({ type: "text", text: msg.content });
  if (msg?.tool_calls) for (const tc of msg.tool_calls) {
    let parsed = {};
    try { parsed = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
    content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parsed });
  }
  // Ensure content is never empty
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id: "msg_" + crypto.randomUUID().slice(0, 14),
    type: "message",
    role: "assistant",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usage ? { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 } : null
  };
}

// ── Shared upstream request helper ──

function forwardToOpenCode(chatBody, stream, res, sk, onNonStream, translators) {
  const dsReq = https.request({
    hostname: UPSTREAM.hostname,
    port: UPSTREAM.port || (UPSTREAM.protocol === "https:" ? 443 : 80),
    path: UPSTREAM.pathname + "/chat/completions",
    method: "POST", timeout: 300000,
    headers: { "Authorization": "Bearer " + API_KEY, "Content-Type": "application/json", Accept: stream ? "text/event-stream" : "application/json" }
  }, (dsRes) => {
    if (dsRes.statusCode !== 200) {
      let errBody = ""; dsRes.on("data", c => errBody += c); dsRes.on("end", () => {
        log.err("upstream " + dsRes.statusCode + ": " + errBody.slice(0, 500));
        if (!res.headersSent) res.writeHead(dsRes.statusCode >= 500 ? 502 : dsRes.statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { type: "upstream_error", message: "upstream " + dsRes.statusCode + ": " + dsRes.statusCode } }));
      }); return;
    }
    if (!stream) {
      let data = ""; dsRes.on("data", c => data += c); dsRes.on("end", () => {
        try { const completion = JSON.parse(data); onNonStream(completion); } catch (e) { log.err("parse: " + e.message); if (!res.headersSent) res.writeHead(502); res.end(JSON.stringify({ error: { message: e.message } })); }
      }); return;
    }
    // Streaming: write headers now that upstream confirmed 200
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const ts = translators;
    let buf = "";
    dsRes.on("data", (chunk) => {
      buf += chunk.toString(); const ls = buf.split("\n"); buf = ls.pop() ?? "";
      for (const line of ls) {
        if (!line.startsWith("data: ")) continue; const json = line.slice(6).trim();
        if (json === "[DONE]") continue;
        try { ts.feed(JSON.parse(json)); } catch (_) {}
      }
    });
    dsRes.on("end", () => {
      if (buf.trim()) { for (const line of buf.split("\n")) { if (!line.startsWith("data: ")) continue; if (line.slice(6).trim() === "[DONE]") continue; try { ts.feed(JSON.parse(line.slice(6).trim())); } catch (_) {} } }
      const usage = ts._lastUsage || null;
      if (sk && ts.reasoningSoFar) { rememberReasoning(sk, [{ role: "assistant", content: ts.contentSoFar, reasoning_content: ts.reasoningSoFar }]); }
      ts.done(usage);
    });
    dsRes.on("error", (e) => { log.err("upstream: " + e.message); ts.error(e.message); });
  });
  dsReq.on("error", (e) => { log.err("connect: " + e.message); if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: { message: e.message } })); } });
  dsReq.on("timeout", () => { dsReq.destroy(); if (!res.headersSent) { res.writeHead(504); res.end(JSON.stringify({ error: { message: "timeout" } })); } });
  dsReq.write(JSON.stringify(chatBody)); dsReq.end();
  return dsReq;
}

// ── HTTP Server ──

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  // Track upstream request for cleanup on client disconnect
  let upstreamReq = null;
  req.on("close", () => { if (upstreamReq) upstreamReq.destroy(); });
  const url = new URL(req.url, "http://" + req.headers.host);
  if (req.method === "GET" && ["/", "/v1", "/health"].includes(url.pathname)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ service: "ccswitch-deepseek", model: MODEL, status: "ok", port: PORT }));
  }
  if (req.method === "GET" && ["/v1/models", "/models"].includes(url.pathname)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "deepseek" }] }));
  }

  try {
    const raw = await readBody(req);
    if (!raw.trim()) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "empty body" } })); }
    const body = JSON.parse(raw);

    // ── Title generation detection (Codex auto-title, skip to save tokens) ──
    // Detect: Responses API with only instructions containing title-gen prompt
    const instrText = typeof body.instructions === "string" ? body.instructions : Array.isArray(body.instructions) ? body.instructions.map(i => typeof i === "string" ? i : i.text || "").join(" ") : "";
    const input_count = Array.isArray(body.input) ? body.input.length : -1;
    const isTitleGen = SKIP_TITLE_GEN && ["/v1/responses", "/responses"].includes(url.pathname) && input_count === 1 && body.input?.[0]?.role === "user" && /^generate a (?:brief|short) title for|^name (?:this|the) conversation/i.test(instrText + " " + (typeof body.input?.[0]?.content === "string" ? body.input[0].content : ""));
    if (isTitleGen) {
      log.skip("[codex] title-gen skipped (0 tokens)");
      const fakeId = "resp_" + crypto.randomUUID().slice(0, 10);
      const outputId = "msg_" + crypto.randomUUID().slice(0, 8);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ id: fakeId, object: "response", status: "completed", model: resolveModel(body.model), output: [{ id: outputId, type: "message", role: "assistant", content: [{ type: "output_text", text: "New Chat" }], status: "completed" }], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }));
    }

    // ── Responses API (Codex) ──
    if (req.method === "POST" && ["/v1/responses", "/responses"].includes(url.pathname)) {
      const { chatBody, stream, requestedModel } = buildChatBody(body);
      const sk = sessionKey(body);
      if (!stream) {
        forwardToOpenCode(chatBody, stream, res, sk,
          (completion) => {
            if (completion.choices?.[0]?.message?.reasoning_content) rememberReasoning(sk, [completion.choices[0].message]);
            const response = buildNonStreamResponse(completion);
            if (completion.usage) log.toks(completion.usage.prompt_tokens, completion.usage.completion_tokens, completion.usage.total_tokens);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
          }, null);
      } else {
        const ts = new SseTranslator(res, requestedModel);
        upstreamReq = forwardToOpenCode(chatBody, stream, res, sk, null, ts);
      }
      return;
    }

    // ── Messages API (Claude Code) ──
    if (req.method === "POST" && ["/v1/messages", "/messages"].includes(url.pathname)) {
      const { chatBody, stream } = buildMessagesBody(body);
      if (!stream) {
        forwardToOpenCode(chatBody, stream, res, null,
          (completion) => {
            const response = buildMessagesResponse(completion);
            if (completion.usage) log.toks(completion.usage.prompt_tokens, completion.usage.completion_tokens, completion.usage.total_tokens);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
          }, null);
      } else {
        upstreamReq = forwardToOpenCode(chatBody, stream, res, null, null, new MessagesSseTranslator(res));
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found: " + url.pathname } }));
  } catch (e) {
    log.err("parse: " + e.message);
    if (!res.headersSent) { res.writeHead(400); res.end(JSON.stringify({ error: { message: e.message } })); }
  }
});

export { resolveModel, buildIdentityPrompt, buildChatBody, buildNonStreamResponse, buildMessagesBody, buildMessagesResponse };

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) server.listen(PORT, "127.0.0.1", () => {
  console.log("");
  log.ok("ccswitch-deepseek started");
  log.info("http://127.0.0.1:" + PORT + "/v1/responses  → Codex");
  log.info("http://127.0.0.1:" + PORT + "/v1/messages    → Claude Code");
  log.info("model: " + MODEL);
  if (!API_KEY) log.warn("api_key not set");
  else log.info("api_key: " + API_KEY.slice(0, 8) + "..." + API_KEY.slice(-4));
  console.log("");
});


if (isMain) {
  process.on("SIGINT", () => { log.info("shutting down..."); server.closeAllConnections?.(); server.close(() => process.exit(0)); });
  process.on("SIGTERM", () => { log.info("shutting down..."); server.closeAllConnections?.(); server.close(() => process.exit(0)); });
}
