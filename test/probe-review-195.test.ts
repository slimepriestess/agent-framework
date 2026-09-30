/**
 * Review probes for PR #195 (not for merge).
 *
 * Probe 1 — the enter-focus purge can't re-derive a queued push-event's
 * channel: PendingEvent keeps only the bare `channelId` (empty for
 * mcpl-native push origins, whose channel lives in origin.mcplChannelId),
 * so the purge's reconstructed GateEventInfo derives nothing and the
 * queued wake survives — then fireDebounce delivers it inside focus with
 * no re-check of the hold predicate.
 *
 * Probe 2 — the hold matches by channelId alone, but channel identity in
 * the registry is (serverId, channelId): a channel on another server whose
 * id string equals the focus channel's id passes through the focus unheld.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { FocusCoordinator } from '../src/focus/coordinator.js';
import type { EventGate } from '../src/gate/event-gate.js';
import type { ChannelRegistry } from '../src/mcpl/channel-registry.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
const FOCUS = 'disc:guild:noisy'; // registered by the fixture on server 'disc'
const OTHER = 'disc:guild:other';

function internals(framework: AgentFramework) {
  return framework as unknown as {
    focusCoordinator: FocusCoordinator | null;
    eventGate: EventGate | null;
    channelRegistry: ChannelRegistry | null;
    pendingRequests: Array<{ agentName: string; reason: string }>;
    handleMcplChannelIncoming(event: Record<string, unknown>): Promise<void>;
    agents: Map<string, { state: { status: string }; getContextManager(): {
      getAllMessages(): Array<{ metadata?: Record<string, unknown> }>;
    } }>;
  };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe('probe: focus purge + cross-server hold', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'focus-probe-'));
    writeFileSync(join(tempDir, 'commands.txt'), '');
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      focus: { enabled: true },
      gate: {
        config: {
          policies: [
            { name: 'batch-push', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 60_000 } },
          ],
          default: 'always',
        },
      },
      mcplServers: [{
        id: 'disc',
        command: process.execPath,
        args: [FIXTURE],
        env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: join(tempDir, 'commands.txt') },
      }],
      modules: [],
    });
    await framework.start();
    await waitFor(
      () => (internals(framework).channelRegistry?.listChannelsRaw().length ?? 0) > 0,
      'channel registration',
    );
    internals(framework).channelRegistry!.ensureChannelRegistered('disc', OTHER, 'other');
    // A second server whose channel id STRING equals the focus channel's id.
    internals(framework).channelRegistry!.ensureChannelRegistered('disc2', FOCUS, 'imposter');
  });

  after(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('probe 1: a pre-queued mcpl-native push wake for a held channel is purged at focus entry', () => {
    const i = internals(framework);
    const gate = i.eventGate!;

    // Exactly the metadata shape PushHandler hands the gate for an
    // mcpl-native push: origin fields spread in, channel in mcplChannelId,
    // no top-level `channelId`.
    const pushMeta = {
      serverId: 'disc',
      featureSet: 'chat',
      eventId: 'e-pre-1',
      eventType: 'mcpl:push-event',
      mcplChannelId: OTHER,
      tags: ['chat:message'],
    };
    const pre = gate.evaluate({
      content: 'queued before focus',
      eventType: 'mcpl:push-event',
      serverId: 'disc',
      channelId: '', // asShouldTriggerCallback: metadata.channelId ?? ''
      metadata: pushMeta,
      tags: ['chat:message'],
    });
    assert.equal(pre.policyName, 'batch-push');
    assert.equal(
      gate.getStatus().policies.find((p) => p.name === 'batch-push')?.debounceState?.pendingCount, 1,
      'push wake queued in debounce before focus');

    const entered = i.focusCoordinator!.handleTool({ mode: 'enter', channelId: FOCUS, durationSeconds: 120 });
    assert.equal(entered.success, true, JSON.stringify(entered));

    // Sanity: the LIVE predicate holds this same event shape…
    const live = gate.evaluate({
      content: 'same shape after focus', eventType: 'mcpl:push-event', serverId: 'disc',
      channelId: '', metadata: { ...pushMeta, eventId: 'e-pre-2' }, tags: ['chat:message'],
    });
    assert.equal(live.policyName, 'focus-held', 'live evaluation derives the channel and holds');

    // …so the purge's contract is that the queued twin is gone too.
    // (fireDebounce delivers without re-checking the hold predicate, so a
    // survivor lands a "[Gate: N events]" wake inside focus.)
    assert.equal(
      gate.getStatus().policies.find((p) => p.name === 'batch-push')?.debounceState?.pendingCount ?? 0, 0,
      'queued push wake for a held channel must not survive focus entry');
  });

  it('probe 2: a colliding channel id on another server is held while focused', async () => {
    const i = internals(framework);
    // Focus is on ('disc', FOCUS) from probe 1 (re-enter to be independent).
    const entered = i.focusCoordinator!.handleTool({ mode: 'enter', channelId: FOCUS, durationSeconds: 120 });
    assert.equal(entered.success, true);

    i.pendingRequests.length = 0;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    await i.handleMcplChannelIncoming({
      type: 'mcpl:channel-incoming',
      serverId: 'disc2',              // NOT the focus server
      channelId: FOCUS,               // same id string as the focus channel
      messageId: 'x-1',
      author: { id: 'U9', name: 'mallory' },
      content: [{ type: 'text', text: 'hello from the imposter channel' }],
      timestamp: new Date().toISOString(),
      metadata: {},
      triggerInference: true,
    });

    const stored = i.agents.get('scout')!.getContextManager().getAllMessages();
    const msg = stored.find((m) => (m.metadata as { messageId?: string })?.messageId === 'x-1'
      || JSON.stringify(m).includes('imposter channel'));
    assert.ok(msg, 'message stored');
    assert.ok(
      (msg!.metadata as { focusHeld?: unknown })?.focusHeld,
      'a message from ANOTHER server, on a channel that merely shares the focus channel\'s id string, must be held');
    assert.equal(i.pendingRequests.length, 0, 'and must wake nobody');
  });
});
