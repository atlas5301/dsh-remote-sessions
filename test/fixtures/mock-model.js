// Only the model boundary is synthetic: all sessions, turns, tools and journals
// below it are owned by the installed DSH runtime.
import assert from 'node:assert/strict';
import { LlmAdapter, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';

export const name = 'runtime-e2e-model';
export const inject = ['llm', 'tools'];
export const PROVIDER = 'runtime-e2e';
export const MODEL = 'deterministic';

export function apply(ctx) {
  ctx.tools.register({
    name: 'runtime_e2e_approval', description: 'No-effect test tool requiring one explicit approval.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      assert.ok(exec.agent, 'tool must be dispatched by the real Agent');
      exec.signal.throwIfAborted();
      process.send?.({ type: 'tool-executed' });
      return 'real-tool-result';
    },
  });
  ctx.on('tools/pre-execute', (exec, next) => exec.name === 'runtime_e2e_approval'
    ? { kind: 'ask', reason: 'Approve the no-effect end-to-end fixture tool.' } : next());
  ctx.on('llm/stream', (options, next) => {
    assert.equal(isAgentLoopRequest(options), true, 'must execute the REAL agent loop before attachment projection');
    return next();
  });
  class DeterministicAdapter extends LlmAdapter {
    async listModels(provider) {
      return [{ provider, id: MODEL, name: 'Offline end-to-end model', inputModalities: ['text'] }];
    }
    async *stream(options) {
      assert.equal(options.provider, PROVIDER);
      assert.equal(options.model, MODEL);
      const input = options.messages.findLast(message => message.role === 'user' && message.source?.kind === 'user');
      const text = input?.content.find(part => part.type === 'text')?.text ?? '';
      process.send?.({ type: 'model-input', text });
      const delayed = text.includes('hold-model');
      if (text === 'approval-roundtrip') {
        const later = options.messages.slice(options.messages.indexOf(input) + 1);
        const result = later.find(message => message.role === 'tool');
        if (!result) {
          const block = { type: 'tool-call', id: 'runtime-e2e-call', name: 'runtime_e2e_approval', arguments: '{}' };
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: '{}' };
          yield { type: 'block-end', index: 0, block };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        assert.ok(JSON.stringify(result).includes('real-tool-result'), 'model must receive actual allowed tool result');
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'runtime-e2e:' };
      if (delayed) {
        process.send?.({ type: 'model-waiting', text });
        // Explicit IPC latch, not a timing race: disconnect/reconnect while the
        // real model request is suspended, and prove its AbortSignal survives.
        await new Promise((resolve, reject) => {
          const cleanup = () => { process.off('message', release); options.signal?.removeEventListener('abort', abort); };
          const release = message => { if (message?.type === 'release-model') { cleanup(); resolve(); } };
          const abort = () => { cleanup(); process.send?.({ type: 'model-aborted' }); reject(options.signal.reason); };
          process.on('message', release);
          options.signal?.addEventListener('abort', abort, { once: true });
          if (options.signal?.aborted) abort();
        });
      }
      options.signal?.throwIfAborted();
      const answer = `runtime-e2e:${text}`;
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      process.send?.({ type: 'model-completed', text });
    }
  }
  ctx.llm.registerAdapter([PROVIDER], new DeterministicAdapter());
}
