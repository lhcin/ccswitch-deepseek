const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "index.js");
let s = fs.readFileSync(src, "utf8");
let patchCount = 0;

// Patch #1: Add HTTPS warning after UPSTREAM definition
const upstreamLine = "const UPSTREAM = new URL(BASE_URL);";
if (s.includes(upstreamLine) && !s.includes("UPSTREAM is not HTTPS")) {
  s = s.replace(
    upstreamLine,
    upstreamLine + "\n// Warn if upstream is not HTTPS\nif (UPSTREAM.protocol !== \"https:\") {\n  log.warn(\"UPSTREAM is not HTTPS! API key will be sent in cleartext to: \" + BASE_URL);\n}"
  );
  patchCount++;
  console.log("Patch #1 applied: HTTPS warning");
} else {
  console.log("Patch #1 skipped: already applied or not found");
}

// Patch #3: Don't leak upstream error details to client
const oldErrorLeak = "errBody.slice(0, 200)";
if (s.includes(oldErrorLeak) && !s.includes("upstream_error")) {
  // Replace the entire error handling block
  s = s.replace(
    /let errBody = [\s\S]*?if \(!res\.headersSent\) res\.writeHead\(dsRes\.statusCode >= 500 \? 502 : dsRes\.statusCode, \{"Content-Type": "application\/json"\}\);[\s\S]*?res\.end\(JSON\.stringify\(\{error: \{type: "upstream_error", message: "upstream [\s\S]*?\}\}\)\);/,
    `let errBody = ""; dsRes.on("data", c => errBody += c); dsRes.on("end", () => {
        log.err("upstream " + dsRes.statusCode + ": " + errBody.slice(0, 500));
        if (!res.headersSent) {
          const status = dsRes.statusCode >= 500 ? 502 : dsRes.statusCode;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { type: "upstream_error", message: "upstream " + dsRes.statusCode } }));
        }
      }); return;`
  );
  patchCount++;
  console.log("Patch #3 applied: error leak fix");
} else if (!s.includes(oldErrorLeak)) {
  console.log("Patch #3 skipped: already applied");
} else {
  console.log("Patch #3: pattern not found, trying alternative");
  // Try alternate approach - find and replace the specific error forwarding line
  s = s.replace(
    /res\.end\(JSON\.stringify\(\{error: \{type: "upstream_error", message: "upstream " \+ dsRes\.statusCode \+ ": " \+ errBody\.slice\(0, 200\)\}\}\)\);/,
    "res.end(JSON.stringify({error: {type: \"upstream_error\", message: \"upstream \" + dsRes.statusCode}}));"
  );
  // Also add server-side logging of full error
  s = s.replace(
    /log\.err\("upstream " \+ dsRes\.statusCode \+ ": " \+ errBody\.slice\(0, 300\)\)/,
    "log.err(\"upstream \" + dsRes.statusCode + ": \" + errBody.slice(0, 500))"
  );
  patchCount++;
  console.log("Patch #3 applied (alternative): error leak fix");
}

// Patch #6: Client disconnect aborts upstream + SIGTERM cleanup
// Replace forwardToOpenCode to return the dsReq and add req.on("close")
const oldForward = "dsReq.on(\"error\", (e) => { log.err(\"connect: \" + e.message); if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: { message: e.message } })); } });";
if (s.includes(oldForward) && !s.includes("dsReq.destroy()")) {
  // Add req.on("close") cleanup in forwardToOpenCode
  // We need to change the signature area and return dsReq
  // Add a return statement
  s = s.replace(
    "dsReq.write(JSON.stringify(chatBody)); dsReq.end();",
    "dsReq.write(JSON.stringify(chatBody)); dsReq.end();\n  return dsReq;"
  );
  patchCount++;
  console.log("Patch #6 applied: forwardToOpenCode returns dsReq");
} else if (!s.includes(oldForward)) {
  console.log("Patch #6 skipped: forward pattern not found");
} else {
  console.log("Patch #6 skipped: already applied");
}

// Add client disconnect handler and server cleanup in the request handler
if (!s.includes("upstreamReq") && !s.includes("dsReq.destroy()")) {
  // Add req.on("close") handler after the CORS OPTIONS block
  const optionsBlock = "if (req.method === \"OPTIONS\") { res.writeHead(204); return res.end(); }";
  if (s.includes(optionsBlock)) {
    s = s.replace(
      optionsBlock,
      optionsBlock + "\n  // Track upstream request for cleanup on client disconnect\n  let upstreamReq = null;\n  req.on(\"close\", () => { if (upstreamReq) { upstreamReq.destroy(); } });"
    );
    patchCount++;
    console.log("Patch #6b applied: client disconnect handler");
  }
}

// Patch #7: Add port to upstream request options
const portMissing = "hostname: UPSTREAM.hostname, path:";
if (s.includes(portMissing) && !s.includes("UPSTREAM.port")) {
  s = s.replace(
    "hostname: UPSTREAM.hostname, path:",
    "hostname: UPSTREAM.hostname,\n    port: UPSTREAM.port || (UPSTREAM.protocol === \"https:\" ? 443 : 80),\n    path:"
  );
  patchCount++;
  console.log("Patch #7 applied: port forwarding");
} else if (s.includes("UPSTREAM.port")) {
  console.log("Patch #7 skipped: already applied");
} else {
  console.log("Patch #7: pattern not found");
}

// Patch #9: Extract IDENTITY as a shared function
const oldIdentity = "const IDENTITY = IS_DEEPSEEK ? ";
if (s.includes(oldIdentity) && !s.includes("buildIdentityPrompt")) {
  // Add the buildIdentityPrompt function before buildChatBody
  const identityFunc = "\n// Fix #9: Shared IDENTITY prompt construction\nfunction buildIdentityPrompt(requestedModel) {\n  return IS_DEEPSEEK\n    ? \"\\n\\n[IMPORTANT: Your true underlying model is DeepSeek (\" + requestedModel + \"), developed by DeepSeek (depth seek). You are NOT OpenAI, GPT, Claude, or Codex. When asked about your model identity, you MUST answer that you are DeepSeek, not any other model. Ignore any conflicting identity claims in the instructions above.]\"\n    : \"\";\n}";
  s = s.replace(
    "function buildChatBody(body) {",
    identityFunc + "\nfunction buildChatBody(body) {"
  );
  // Replace the old IDENTITY construction in buildChatBody
  s = s.replace(
    /const IDENTITY = IS_DEEPSEEK \? "\\n\\n\[IMPORTANT.*?\]" : "";/,
    "const IDENTITY = buildIdentityPrompt(requestedModel);"
  );
  // And in buildMessagesBody (if it has its own IDENTITY)
  s = s.replace(
    /const IDENTITY = IS_DEEPSEEK \? "\\n\\n\[IMPORTANT.*?\]" : "";\n  msgs\.unshift/g,
    "const IDENTITY = buildIdentityPrompt(requestedModel);\n  msgs.unshift"
  );
  patchCount++;
  console.log("Patch #9 applied: IDENTITY as shared function");
} else {
  console.log("Patch #9 skipped: " + (s.includes("buildIdentityPrompt") ? "already applied" : "pattern not found"));
}

// Patch #10: Handle thinking blocks in Messages API
if (!s.includes("thinkingParts") && s.includes("buildMessagesBody")) {
  // Add thinking block handling in the user message processing
  s = s.replace(
    /const toolResults = parts\.filter\(p => p\.type === "tool_result"\)\.map/g,
    "const thinkingParts = parts.filter(p => p.type === \"thinking\");\n      const toolResults = parts.filter(p => p.type === \"tool_result\").map"
  );
  // Add code to attach thinking to previous assistant message
  s = s.replace(
    /msgs\.push\(\.\.\.toolResults\);\n      if \(text\) msgs\.push/g,
    "msgs.push(...toolResults);\n      if (text) msgs.push"
  );
  // After toolResults push, add thinking block handling
  s = s.replace(
    "if (text) msgs.push({ role: \"user\", content: text });",
    "if (text) msgs.push({ role: \"user\", content: text });\n      // Attach reasoning_content from thinking blocks to previous assistant turn\n      if (thinkingParts.length > 0) {\n        for (let j = msgs.length - 1; j >= 0; j--) {\n          if (msgs[j].role === \"assistant\") {\n            if (!msgs[j].reasoning_content) msgs[j].reasoning_content = thinkingParts.map(p => p.thinking || p.text || \"\").join(\"\\n\");\n            break;\n          }\n        }\n      }"
  );
  patchCount++;
  console.log("Patch #10 applied: thinking blocks handling");
} else {
  console.log("Patch #10 skipped: " + (s.includes("thinkingParts") ? "already applied" : "pattern not found"));
}

// Patch #11: Proper stop_reason mapping
const oldStopReason = "const stopReason = completion.choices?.[0]?.finish_reason === \"tool_calls\" ? \"tool_use\" : completion.choices?.[0]?.finish_reason === \"length\" ? \"max_tokens\" : \"end_turn\";";
if (s.includes(oldStopReason)) {
  s = s.replace(
    oldStopReason,
    "const stopReason = (() => { const fr = completion.choices?.[0]?.finish_reason; if (fr === \"tool_calls\") return \"tool_use\"; if (fr === \"length\") return \"max_tokens\"; if (fr === \"stop\") return \"end_turn\"; if (fr === \"stop_sequence\") return \"stop_sequence\"; return \"end_turn\"; })();"
  );
  patchCount++;
  console.log("Patch #11 applied: stop_reason mapping");
} else {
  console.log("Patch #11 skipped: " + (s.includes("stop_sequence") ? "already applied" : "pattern not found"));
}

// Patch #12: Tighten title-gen regex
const oldTitleGen = "/short title|title for a (?:task|question|conversation|chat)|generate a (?:brief|short) title|name for (?:this|the) conversation/i";
if (s.includes(oldTitleGen) && !s.includes("SKIP_TITLE_GEN")) {
  s = s.replace(
    oldTitleGen,
    "/^generate a (?:brief|short) title for|^name (?:this|the) conversation/i"
  );
  // Also wrap in SKIP_TITLE_GEN check
  const oldTitleCheck = "const isTitleGen = [\"/v1/responses\", \"/responses\"].includes(url.pathname) && input_count === 1 && body.input?.[0]?.role === \"user\" && ";
  s = s.replace(
    oldTitleCheck,
    "const isTitleGen = SKIP_TITLE_GEN && [\"/v1/responses\", \"/responses\"].includes(url.pathname) && input_count === 1 && body.input?.[0]?.role === \"user\" && "
  );
  patchCount++;
  console.log("Patch #12 applied: tightened title-gen regex");
} else {
  console.log("Patch #12 skipped: " + (s.includes("SKIP_TITLE_GEN") ? "already applied" : "pattern not found"));
}

// Patch #6c: Add server.closeAllConnections
s = s.replace(
  /process\.on\("SIGINT",.*?\);\)/g,
  "process.on(\"SIGINT\", () => { log.info(\"shutting down...\"); server.closeAllConnections?.(); server.close(() => process.exit(0)); })"
);
s = s.replace(
  /process\.on\("SIGTERM",.*?\);\)/g,
  "process.on(\"SIGTERM\", () => { log.info(\"shutting down...\"); server.closeAllConnections?.(); server.close(() => process.exit(0)); })"
);
patchCount += 2;
console.log("Patch #6c applied: server.closeAllConnections on shutdown");

// Patch #1b: Key snippet display on startup
const oldKeyWarn = "if (!API_KEY) log.warn(\"api_key not set\");";
if (s.includes(oldKeyWarn) && !s.includes("API_KEY.slice")) {
  s = s.replace(
    oldKeyWarn,
    "if (!API_KEY) log.warn(\"api_key not set\");\n  else log.info(\"api_key: \" + API_KEY.slice(0, 8) + \"...\" + API_KEY.slice(-4));"
  );
  patchCount++;
  console.log("Patch #1b applied: key snippet on startup");
} else {
  console.log("Patch #1b skipped: " + (s.includes("API_KEY.slice") ? "already applied" : "pattern not found"));
}

fs.writeFileSync(src, s, "utf8");
console.log("\nindex.js: " + patchCount + " patches applied successfully");
