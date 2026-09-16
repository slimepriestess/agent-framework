import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
  TraceEvent,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

/**
 * A graceful framework shutdown with an active stream is neither the user's
 * act nor a failure. Membrane reports every `stream.cancel()` as reason
 * `user` — it names the call, not the actor — so `AgentFramework.stop()`
 * used to fall into the deliberate-cancellation branch and write
 * "[turn-interrupted] Your previous turn was stopped mid-stream by the user"
 * into the agent's durable context (review of #134: Sol's repro, confirmed
 * independently). A resident reading that after restart would learn that
 * someone stopped them; nobody did.
 *
 * The fix records shutdown provenance in `frameworkCancelledStreams` before
 * the cancel, exactly as `endTurn` and budget restarts do, so driveStream's
 * tracked branch returns before the marker — and emits `inference:aborted`
 * with the honest reason instead.
 */

/** Module whose tool call hangs until released — keeps the stream open so
 *  the shutdown arrives mid-turn. */
class HangingToolModule implements Module {
  readonly name = 'test';
  release!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [{ name: 'hang', description: 'Hangs until released', inputSchema: { type: 'object', properties: {} } }];
  }

  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    await this.gate;
    return { success: true, data: {} };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return {
        addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }],
        requestInference: true,
      };
    }
    return {};
  }
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('graceful shutdown is not attributed to the user', () => {
  it('framework.stop() with an active stream writes no "by the user" marker and traces reason "shutdown"', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'shutdown-provenance-'));
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse(
      [{ type: 'tool_use', id: 't1', name: 'test--hang', input: {} } as never],
      'tool_use',
    ));

    const module = new HangingToolModule();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Assist.' }],
      modules: [module],
    });

    const traces: TraceEvent[] = [];
    framework.onTrace((t) => { traces.push(t); });

    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
      framework.start();
      const agent = framework.getAgent('assistant')!;
      await waitFor(() => agent.state.status === 'waiting_for_tools');

      // Intercept context writes: the store is closed by the time stop()
      // returns, so capture the marker at write time.
      const cm = agent.getContextManager();
      const written: string[] = [];
      const orig = cm.addMessage.bind(cm);
      (cm as unknown as { addMessage: unknown }).addMessage = (role: never, content: Array<{ type: string; text?: string }>, meta: never) => {
        for (const b of content) if (b.type === 'text' && b.text) written.push(b.text);
        return orig(role, content as never, meta);
      };

      // No user action anywhere: the host process is shutting down while
      // the stream is still active.
      await framework.stop();

      const userAttributed = written.filter((t) => t.includes('stopped mid-stream by the user'));
      assert.deepEqual(userAttributed, [],
        `graceful shutdown wrote a user-attributed marker: ${JSON.stringify(userAttributed)}`);
      const anyMarker = written.filter((t) => t.includes('[turn-interrupted]') || t.includes('[inference-failed]'));
      assert.deepEqual(anyMarker, [], `graceful shutdown wrote a marker at all: ${JSON.stringify(anyMarker)}`);

      const aborted = traces.filter((t): t is Extract<TraceEvent, { type: 'inference:aborted' }> => t.type === 'inference:aborted');
      assert.equal(aborted.length, 1, `expected exactly one inference:aborted trace, got ${JSON.stringify(aborted)}`);
      assert.equal(aborted[0].reason, 'shutdown', 'the trace carries the recorded provenance, not the wire reason');
      assert.equal(traces.filter((t) => t.type === 'inference:exhausted').length, 0,
        'a shutdown is not a failure: no inference:exhausted');
    } finally {
      // (the hung tool stays pending: a promise holds no handle, and releasing it after the store closed would only continue a turn into a closed framework)
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
