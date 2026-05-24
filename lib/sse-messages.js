import crypto from 'node:crypto';
import log from './log.js';

export class MessagesSseTranslator {
  constructor(res) {
    this.res = res;
    this.msgId = 'msg_' + crypto.randomUUID().slice(0, 14);
    this.blockIndex = 0;
    this.reasoningIdx = -1;
    this.reasoningClosed = false;
    this.textIdx = -1;
    this.textClosed = false;
    this.reasoningSoFar = '';
    this.contentSoFar = '';
    this.toolCallBlocks = new Map();
    this.openBlocks = 0;
    this._started = false;
    this._lastUsage = null;
  }

  emit(event, data) {
    this.res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');

  }

  _start() {
    if (this._started) return;
    this._started = true;
    this.emit('message_start', { type: 'message_start', message: { id: this.msgId, type: 'message', role: 'assistant', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }

  _closeOpenReasoning() {
    if (this.reasoningIdx >= 0 && !this.reasoningClosed) {
      this.emit('content_block_stop', { type: 'content_block_stop', index: this.reasoningIdx });
      this.reasoningClosed = true;
      this.openBlocks--;
    }
  }

  _closeOpenText() {
    if (this.textIdx >= 0 && !this.textClosed) {
      this.emit('content_block_stop', { type: 'content_block_stop', index: this.textIdx });
      this.textClosed = true;
      this.openBlocks--;
    }
  }

  feed(chunk) {
    const delta = chunk.choices?.[0]?.delta;
    if (chunk.usage) this._lastUsage = chunk.usage;
    if (!delta && !chunk.usage) return;
    this._start();
    if (delta?.reasoning_content) {
      this.reasoningSoFar += delta.reasoning_content;
      if (this.reasoningIdx < 0) {
        this.reasoningIdx = this.blockIndex++;
        this.openBlocks++;
        this.emit('content_block_start', { type: 'content_block_start', index: this.reasoningIdx, content_block: { type: 'thinking', thinking: '' } });
      }
      this.emit('content_block_delta', { type: 'content_block_delta', index: this.reasoningIdx, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } });
    }
    if (delta?.content) {
      this._closeOpenReasoning();
      if (this.textIdx < 0) {
        this.textIdx = this.blockIndex++;
        this.openBlocks++;
        this.emit('content_block_start', { type: 'content_block_start', index: this.textIdx, content_block: { type: 'text', text: '' } });
      }
      this.contentSoFar += delta.content;
      this.emit('content_block_delta', { type: 'content_block_delta', index: this.textIdx, delta: { type: 'text_delta', text: delta.content } });
    }
    if (delta?.tool_calls) {
      this._closeOpenText();
      for (const tc of delta.tool_calls) {
        if (!this.toolCallBlocks.has(tc.index)) {
          const blockIdx = this.blockIndex++;
          const callId = tc.id || 'call_' + blockIdx;
          this.toolCallBlocks.set(tc.index, { blockIdx, id: callId, name: tc.function?.name || '', args: '' });
          this.openBlocks++;
          this.emit('content_block_start', { type: 'content_block_start', index: blockIdx, content_block: { type: 'tool_use', id: callId, name: tc.function?.name || '', input: {} } });
        }
        const call = this.toolCallBlocks.get(tc.index);
        if (tc.function?.name) call.name = tc.function.name;
        if (tc.function?.arguments) call.args += tc.function.arguments;
        this.emit('content_block_delta', { type: 'content_block_delta', index: call.blockIdx, delta: { type: 'input_json_delta', partial_json: tc.function?.arguments ?? '' } });
      }
    }
  }

  done(usage) {
    this._start();
    // Ensure at least one content block exists (Claude Code requires non-empty content)
    if (this.reasoningIdx < 0 && this.textIdx < 0 && this.toolCallBlocks.size === 0) {
      this.textIdx = this.blockIndex++;
      this.emit('content_block_start', { type: 'content_block_start', index: this.textIdx, content_block: { type: 'text', text: '' } });
      this.emit('content_block_delta', { type: 'content_block_delta', index: this.textIdx, delta: { type: 'text_delta', text: '' } });
    }
    this._closeOpenReasoning();
    this._closeOpenText();
    if (this.textIdx >= 0 && !this.textClosed) {
      this.emit('content_block_stop', { type: 'content_block_stop', index: this.textIdx });
      this.textClosed = true;
    }
    for (const [, call] of this.toolCallBlocks) {
      this.emit('content_block_stop', { type: 'content_block_stop', index: call.blockIdx });
    }
    const stopReason = this.toolCallBlocks.size > 0 ? 'tool_use' : 'end_turn';
    const u = usage || this._lastUsage;
    this.emit('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: u ? { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 } : null });
    this.emit('message_stop', { type: 'message_stop' });
    this.res.end();
  }

  error(msg) {
    this.emit('error', { type: 'error', error: { type: 'api_error', message: msg } });
    this.res.end();
  }
}

