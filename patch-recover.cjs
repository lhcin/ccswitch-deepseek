const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "lib", "recover.js");
let s = fs.readFileSync(src, "utf8");

// 1. Add SESSION_TTL_MS and sessionTimestamps after MAX_SESSIONS
s = s.replace(
  /const MAX_SESSIONS = 500;\n/,
  "const MAX_SESSIONS = 500;\nconst SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes\nconst sessionTimestamps = new Map();\n"
);

// 2. Replace evictOldSessions with TTL-aware version
s = s.replace(
  /function evictOldSessions\(\) \{[\s\S]*?\n\}/,
  `function evictExpiredSessions() {
  const now = Date.now();
  for (const [key, ts] of sessionTimestamps) {
    if (now - ts > SESSION_TTL_MS) {
      sessionQueues.delete(key);
      sessionTimestamps.delete(key);
    }
  }
}

function evictOldSessions() {
  evictExpiredSessions();
  if (sessionQueues.size > MAX_SESSIONS) {
    const entries = [...sessionTimestamps.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = entries.slice(0, entries.length - MAX_SESSIONS);
    for (const [key] of toRemove) {
      sessionQueues.delete(key);
      sessionTimestamps.delete(key);
    }
  }
}`
);

// 3. Add timestamp tracking in rememberReasoning
s = s.replace(
  "if (!sessionQueues.has(key)) sessionQueues.set(key, []);",
  "if (!sessionQueues.has(key)) sessionQueues.set(key, []);\n  sessionTimestamps.set(key, Date.now());"
);

// 4. Refresh TTL on access in recoverReasoning 
s = s.replace(
  "const queue = key && key.length > 0 ? (sessionQueues.get(key) || []) : [];",
  "const queue = key && key.length > 0 ? (sessionQueues.get(key) || []) : [];\n  if (queue.length > 0) sessionTimestamps.set(key, Date.now()); // refresh TTL on access"
);

// 5. Remove global fallback
s = s.replace(
  'return body?.previous_response_id || body?.session_id || "global";',
  'return body?.previous_response_id || body?.session_id; // removed "global" fallback to prevent cross-session leakage'
);

fs.writeFileSync(src, s, "utf8");
console.log("recover.js patched successfully");
