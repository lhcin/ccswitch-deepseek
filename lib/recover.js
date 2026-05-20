const MAX_SESSIONS = 500;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const sessionTimestamps = new Map();
const MAX_QUEUE_LEN = 50;
const sessionQueues = new Map();

function evictExpiredSessions() {
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
}

export function rememberReasoning(key, messages) {
  if (!key || key.length === 0) return;
  if (!sessionQueues.has(key)) sessionQueues.set(key, []);
  sessionTimestamps.set(key, Date.now());
  const queue = sessionQueues.get(key);
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.reasoning_content) {
      queue.push(msg.reasoning_content);
      if (queue.length > MAX_QUEUE_LEN) queue.shift();
    }
  }
  evictOldSessions();
}

export function recoverReasoning(key, messages) {
  const queue = key && key.length > 0 ? (sessionQueues.get(key) || []) : [];
  if (queue.length > 0) sessionTimestamps.set(key, Date.now()); // refresh TTL on access
  if (queue.length === 0) return 0;
  let recovered = 0;
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls && !msg.reasoning_content) {
      msg.reasoning_content = queue[Math.min(recovered, queue.length - 1)];
      recovered++;
    }
  }
  return recovered;
}

export function sessionKey(body) {
  // Use previous_response_id as session key for multi-session isolation
  return body?.previous_response_id || body?.session_id; // removed "global" fallback to prevent cross-session leakage
}
