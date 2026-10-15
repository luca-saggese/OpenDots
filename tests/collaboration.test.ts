import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  CollaborationExecution,
  CollaborationMention,
} from '../src/shared/types.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Store } from '../src/server/store.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { CollaborationService } from '../src/server/collaboration.js';
import {
  assembleCollaborationContext,
  collaborationAuthorization,
} from '../src/server/collaboration-context.js';
import { validateRuntimeScope } from '../src/server/runtime-scope.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { completion } from './fixtures/model-stream.js';
import { EventType } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const request = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  options: {
    turn?: (
      execution: CollaborationExecution,
      signal: AbortSignal,
    ) => Promise<string>;
    timeoutMs?: number;
    path?: string;
  } = {},
) {
  const workspace = new WorkspaceStore(options.path ?? ':memory:', 'owner');
  const store = new Store(':memory:');
  const contexts: string[] = [];
  const runtime = {
    ready: vi.fn(),
    createThread: vi.fn(async () => {}),
    turn: vi.fn(
      async (execution: CollaborationExecution, signal: AbortSignal) => {
        contexts.push(assembleCollaborationContext(workspace, execution));
        return options.turn
          ? options.turn(execution, signal)
          : execution.kind === 'evaluation'
            ? JSON.stringify({
                raise: true,
                reason: 'I have a relevant technical question.',
              })
            : `Actual runtime contribution from ${workspace.dot(execution.dotId)!.name}.`;
      },
    ),
  };
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(
    store,
    workspace,
    {
      baseUrl: config.baseUrl,
      voiceName: 'marin',
      slackUsers: [],
      runtimeUrl: '',
      agentRunTimeoutMs: options.timeoutMs ?? 1000,
    },
    runtime,
  );
  const app = createApp({
    store,
    platform,
    runner: new Runner(store, config),
    config,
  });
  const space = workspace.createSpace('Project Orion', 'Launch study');
  const dots = ['Laura', 'Paolo', 'Laura'].map((name) =>
    workspace.createDot(
      space.id,
      name,
      `Permanent instructions for ${name}.`,
      false,
      false,
    ),
  );
  const master = workspace.createMasterSession(space.id, 'Project Orion');
  const agents = dots.map((dot, index) =>
    workspace.addSessionAgent(
      master.id,
      dot.id,
      ['Research Lead', 'Aerospace Engineer', 'Business Analyst'][index],
      `Mandate ${index}: assess only your specialty.`,
    ),
  );
  dots.forEach((dot, index) =>
    workspace.updateDotProfile(dot.id, {
      summary: `Professional summary ${index}`,
      skills: ['analysis'],
      workStyle: 'Be precise.',
    }),
  );
  const conversation = (indices = [0, 1], kind: 'group' | 'direct' = 'group') =>
    workspace.createOrganizationalConversation({
      masterSessionId: master.id,
      title: kind === 'direct' ? 'Private' : 'Team',
      kind,
      visibility: kind === 'direct' ? 'private' : 'restricted',
      createdByType: 'user',
      createdById: 'owner',
      participants: [
        { participantType: 'user', participantId: 'owner' },
        ...indices.map((index) => ({
          participantType: 'session_agent' as const,
          participantId: agents[index].id,
        })),
      ],
    });
  cleanup.push(async () => {
    platform.collaboration.stop();
    await platform.collaboration.idle();
    workspace.close();
    store.close();
  });
  const mention = (
    conversationId: string,
    index = 0,
  ): CollaborationMention => ({
    type: 'agent',
    conversationId,
    sessionAgentId: agents[index].id,
    dotId: dots[index].id,
    displayName: dots[index].name,
  });
  return {
    workspace,
    store,
    platform,
    service: platform.collaboration,
    app,
    runtime,
    contexts,
    space,
    master,
    dots,
    agents,
    conversation,
    mention,
  };
}

it('renames a permanent Dot through the API without changing its identity or other projects', async () => {
  const f = fixture();
  const second = f.workspace.createSpace('Other', 'Second project');
  const dot = f.workspace.dot(f.dots[0].id)!;
  f.workspace.updateDot(dot.id, {
    ...dot,
    spaceIds: [...dot.spaceIds, second.id],
  });
  const master = f.workspace.createMasterSession(second.id, 'Second project');
  const assignment = f.workspace.addSessionAgent(
    master.id,
    dot.id,
    'Reviewer',
    'Different mandate',
  );
  const response = await f.app.request(
    `/api/office/dots/${dot.id}/name`,
    request({ name: 'Sofia' }, 'PUT'),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).id).toBe(dot.id);
  expect(f.workspace.dot(assignment.dotId)?.name).toBe('Sofia');
  expect(f.workspace.sessionAgent(f.agents[0].id)?.dotId).toBe(dot.id);
});

it('resolves same-name mentions by stable IDs and assembles identity, colleagues and mandate from real data', async () => {
  const f = fixture();
  const conversation = f.conversation([0, 1, 2]);
  const response = await f.app.request(
    `/api/organizational-conversations/${conversation.id}/messages`,
    request({
      content: '@Laura assess the proposal',
      idempotencyKey: 'one',
      activation: 'mentioned',
      mentions: [f.mention(conversation.id, 2)],
    }),
  );
  expect(response.status).toBe(201);
  await f.service.idle();
  expect(f.runtime.turn).toHaveBeenCalledTimes(1);
  expect(f.runtime.turn.mock.calls[0][0].sessionAgentId).toBe(f.agents[2].id);
  expect(f.contexts[0]).toContain('Business Analyst');
  expect(f.contexts[0]).toContain('Mandate 2');
  expect(f.contexts[0]).toContain(f.agents[0].id);
  expect(f.contexts[0]).toContain('Aerospace Engineer');
  expect(f.contexts[0]).toContain('Professional summary 2');
  const page = await f.app.request(
    `/api/organizational-conversations/${conversation.id}/messages`,
  );
  const messages = await page.json();
  expect(messages[0].mentions[0].sessionAgentId).toBe(f.agents[2].id);
  expect(messages[1]).toMatchObject({
    senderType: 'session_agent',
    senderId: f.agents[2].id,
    content: 'Actual runtime contribution from Laura.',
  });
  const execution = f.workspace.collaboration.executions(conversation.id)[0];
  expect(messages[1].sourceThreadId).toBe(execution.threadId);
  expect(messages[1].sourceTurnId).toBe(execution.turnId);
});

it('activates the real private collaborator and never copies other private conversations into a group', async () => {
  const f = fixture();
  const privateConversation = f.conversation([0], 'direct');
  f.service.publishHuman(privateConversation.id, {
    content: 'Private secret launch budget',
    idempotencyKey: 'private',
    activation: 'direct',
  });
  await f.service.idle();
  const group = f.conversation();
  f.service.publishHuman(group.id, {
    content: 'Discuss feasibility',
    activation: 'mentioned',
    mentions: [f.mention(group.id)],
    idempotencyKey: 'group',
  });
  await f.service.idle();
  expect(f.contexts[0]).toContain('Private secret launch budget');
  expect(f.contexts[1]).not.toContain('Private secret launch budget');
  const executions = [
    f.workspace.collaboration.executions(privateConversation.id)[0],
    f.workspace.collaboration.executions(group.id)[0],
  ];
  expect(executions[0].threadId).not.toBe(executions[1].threadId);
  expect(
    executions.every(
      (execution) =>
        f.workspace.requireThread(execution.threadId).learningContainerId ===
        null,
    ),
  ).toBe(true);
  expect(f.workspace.conversations().map((thread) => thread.id)).not.toContain(
    executions[0].threadId,
  );
});

it('runs multiple selected collaborators in deterministic order without concurrent turns', async () => {
  let running = 0;
  let maximum = 0;
  const f = fixture({
    turn: async () => {
      running++;
      maximum = Math.max(maximum, running);
      await Promise.resolve();
      running--;
      return 'Verified response';
    },
  });
  const conversation = f.conversation();
  f.service.publishHuman(conversation.id, {
    content: 'Compare views',
    activation: 'mentioned',
    mentions: [f.mention(conversation.id, 1), f.mention(conversation.id, 0)],
  });
  await f.service.idle();
  expect(
    f.runtime.turn.mock.calls.map(([execution]) => execution.sessionAgentId),
  ).toEqual([f.agents[0].id, f.agents[1].id].sort());
  expect(maximum).toBe(1);
  const release = f.workspace.acquireThreadRun('same-thread');
  expect(() => f.workspace.acquireThreadRun('same-thread')).toThrow(
    /already running/,
  );
  release();
  expect(() => f.workspace.acquireThreadRun('same-thread')).not.toThrow();
});

it('limits @tutti to writable conversation participants and enforces its configured budget', async () => {
  const f = fixture();
  const conversation = f.conversation();
  f.service.settings(conversation.id, {
    mode: 'manual',
    maxActivations: 1,
    evaluationBudget: 1,
  });
  const input = {
    content: '@tutti thoughts?',
    activation: 'mentioned' as const,
    mentions: [{ type: 'all' as const, conversationId: conversation.id }],
  };
  expect(() => f.service.publishHuman(conversation.id, input)).toThrow(
    /limit exceeded/,
  );
  expect(
    f.workspace.listConversationMessagesForUser(conversation.id, 'owner'),
  ).toHaveLength(0);
  f.workspace.setConversationParticipantRole(
    conversation.id,
    'owner',
    f.agents[1].id,
    'observer',
  );
  f.service.publishHuman(conversation.id, input);
  await f.service.idle();
  expect(
    f.runtime.turn.mock.calls.map(([execution]) => execution.sessionAgentId),
  ).toEqual([f.agents[0].id]);
});

it('never activates on unstructured names or manual free conversation, and supports explicit publish-only mentions', async () => {
  const f = fixture();
  const conversation = f.conversation();
  f.service.publishHuman(conversation.id, {
    content: '@Laura @tutti are plain text here',
  });
  f.service.publishHuman(conversation.id, {
    content: 'Shared message',
    activation: 'none',
    mentions: [f.mention(conversation.id)],
  });
  await f.service.idle();
  expect(f.runtime.turn).not.toHaveBeenCalled();
  expect(f.workspace.collaboration.executions(conversation.id)).toEqual([]);
});

it('rejects forged senders and cross-conversation or cross-Dot mentions before compute', async () => {
  const f = fixture();
  const conversation = f.conversation();
  const other = f.conversation([2], 'direct');
  for (const body of [
    {
      content: 'forged',
      senderType: 'session_agent',
      senderId: f.agents[0].id,
    },
    {
      content: 'wrong conversation',
      activation: 'mentioned',
      mentions: [f.mention(other.id, 2)],
    },
    {
      content: 'absent participant',
      activation: 'mentioned',
      mentions: [f.mention(conversation.id, 2)],
    },
    {
      content: 'wrong Dot',
      activation: 'mentioned',
      mentions: [{ ...f.mention(conversation.id), dotId: f.dots[1].id }],
    },
  ])
    expect(
      (
        await f.app.request(
          `/api/organizational-conversations/${conversation.id}/messages`,
          request(body),
        )
      ).status,
    ).toBe(400);
  expect(f.runtime.turn).not.toHaveBeenCalled();
});

it('deduplicates activation requests and published responses across retries', async () => {
  const f = fixture();
  const conversation = f.conversation();
  const input = {
    content: 'Assess this',
    activation: 'mentioned' as const,
    mentions: [f.mention(conversation.id)],
    idempotencyKey: 'retry',
  };
  const first = f.service.publishHuman(conversation.id, input);
  const second = f.service.publishHuman(conversation.id, input);
  expect(first.id).toBe(second.id);
  await f.service.idle();
  f.service.publishHuman(conversation.id, input);
  await f.service.idle();
  expect(f.runtime.turn).toHaveBeenCalledTimes(1);
  const execution = f.workspace.collaboration.executions(conversation.id)[0];
  f.service.retryPublication(conversation.id, execution.id);
  expect(
    f.workspace.listConversationMessagesForUser(conversation.id, 'owner'),
  ).toHaveLength(2);
  expect(() =>
    f.service.publishHuman(conversation.id, { ...input, activation: 'none' }),
  ).toThrow(/different activation/);
});

it('records native canonical turn identity rather than publishing a frontend identity', async () => {
  const f: ReturnType<typeof fixture> = fixture({
    turn: async (execution) => {
      f.workspace.collaboration.runtimeTurn(
        execution.id,
        'canonical-native-turn',
      );
      return 'Native result';
    },
  });
  const conversation = f.conversation([0], 'direct');
  f.service.publishHuman(conversation.id, {
    content: 'Respond',
    activation: 'direct',
  });
  await f.service.idle();
  expect(
    f.workspace.listConversationMessagesForUser(conversation.id, 'owner').at(-1)
      ?.sourceTurnId,
  ).toBe('canonical-native-turn');
});

it('persists timeout and runtime errors without fabricated agent messages', async () => {
  const f = fixture({
    timeoutMs: 15,
    turn: async () => new Promise<string>(() => {}),
  });
  const conversation = f.conversation([0], 'direct');
  f.service.publishHuman(conversation.id, {
    content: 'Timeout',
    activation: 'direct',
  });
  await f.service.idle();
  expect(
    f.workspace.collaboration.executions(conversation.id)[0],
  ).toMatchObject({ status: 'failed', error: 'Agent execution timed out.' });
  expect(
    f.workspace.listConversationMessagesForUser(conversation.id, 'owner'),
  ).toHaveLength(1);
  const g = fixture({
    turn: async () => {
      throw new Error('Provider unavailable');
    },
  });
  const other = g.conversation([0], 'direct');
  g.service.publishHuman(other.id, { content: 'Fail', activation: 'direct' });
  await g.service.idle();
  expect(g.service.state(other.id).executions[0].error).toBe(
    'Provider unavailable',
  );
});

it('cancels queued and in-flight executions without publishing a late response', async () => {
  const started = deferred<void>();
  const finish = deferred<string>();
  const f = fixture({
    turn: async () => {
      started.resolve();
      return finish.promise;
    },
  });
  const conversation = f.conversation();
  f.service.publishHuman(conversation.id, {
    content: 'All',
    activation: 'mentioned',
    mentions: [{ type: 'all', conversationId: conversation.id }],
  });
  await started.promise;
  for (const execution of f.workspace.collaboration.executions(conversation.id))
    f.service.cancel(conversation.id, execution.id);
  finish.resolve('Must never be published');
  await f.service.idle();
  expect(
    f.workspace.collaboration
      .executions(conversation.id)
      .map((execution) => execution.status),
  ).toEqual(['cancelled', 'cancelled']);
  expect(
    f.workspace.listConversationMessagesForUser(conversation.id, 'owner'),
  ).toHaveLength(1);
});

it('creates deduplicated hand raises only when enabled and never publishes evaluation text', async () => {
  const f = fixture();
  const conversation = f.conversation();
  const message = f.service.publishHuman(conversation.id, {
    content: 'Evaluate our technical assumptions',
  });
  expect(() => f.service.evaluate(conversation.id, message.id)).toThrow(
    /Enable hand raises/,
  );
  f.service.settings(conversation.id, {
    mode: 'hand_raise',
    maxActivations: 3,
    evaluationBudget: 1,
  });
  f.service.evaluate(conversation.id, message.id);
  f.service.evaluate(conversation.id, message.id);
  await f.service.idle();
  expect(f.runtime.turn).toHaveBeenCalledTimes(1);
  expect(f.service.state(conversation.id).handRaises).toHaveLength(1);
  expect(
    f.workspace.listConversationMessagesForUser(conversation.id, 'owner'),
  ).toHaveLength(1);
  expect(f.contexts[0]).toContain('This is a proposal, not a public response');
});

it('approves the floor exactly once and permits dismissal without repeated proposals', async () => {
  const f = fixture();
  const conversation = f.conversation();
  f.service.settings(conversation.id, {
    mode: 'hand_raise',
    maxActivations: 3,
    evaluationBudget: 2,
  });
  const message = f.service.publishHuman(conversation.id, {
    content: 'Review assumptions',
  });
  f.service.evaluate(conversation.id, message.id);
  await f.service.idle();
  const [approved, dismissed] = f.service.state(conversation.id).handRaises;
  const response = await f.app.request(
    `/api/organizational-conversations/${conversation.id}/hand-raises/${approved.id}/resolve`,
    request({ action: 'approved' }),
  );
  expect(response.status).toBe(202);
  f.service.resolve(conversation.id, approved.id, 'approved');
  f.service.resolve(conversation.id, dismissed.id, 'dismissed');
  await f.service.idle();
  f.service.evaluate(conversation.id, message.id);
  await f.service.idle();
  expect(f.runtime.turn).toHaveBeenCalledTimes(3);
  expect(
    f.workspace
      .listConversationMessagesForUser(conversation.id, 'owner')
      .filter((item) => item.senderType === 'session_agent'),
  ).toHaveLength(1);
  expect(
    f.service
      .state(conversation.id)
      .handRaises.map((raise) => raise.status)
      .sort(),
  ).toEqual(['approved', 'dismissed']);
  expect(f.contexts.at(-1)).toContain('relevant technical question');
});

it('rejects malformed hand raise output and expires requests when disabled', async () => {
  const f = fixture({ turn: async () => 'not JSON' });
  const conversation = f.conversation();
  f.service.settings(conversation.id, {
    mode: 'hand_raise',
    maxActivations: 1,
    evaluationBudget: 1,
  });
  const message = f.service.publishHuman(conversation.id, {
    content: 'Any concerns?',
  });
  f.service.evaluate(conversation.id, message.id);
  await f.service.idle();
  expect(f.service.state(conversation.id).executions[0].status).toBe('failed');
  expect(f.service.state(conversation.id).handRaises).toEqual([]);
  const g = fixture();
  const group = g.conversation();
  g.service.settings(group.id, {
    mode: 'hand_raise',
    maxActivations: 1,
    evaluationBudget: 1,
  });
  const trigger = g.service.publishHuman(group.id, { content: 'Question?' });
  g.service.evaluate(group.id, trigger.id);
  await g.service.idle();
  g.service.settings(group.id, {
    mode: 'manual',
    maxActivations: 1,
    evaluationBudget: 1,
  });
  const raise = g.service.state(group.id).handRaises[0];
  expect(raise.status).toBe('expired');
  expect(() => g.service.resolve(group.id, raise.id, 'approved')).toThrow(
    /expired/,
  );
});

it('records a negative hand raise decision without inventing a proposal', async () => {
  const f = fixture({ turn: async () => JSON.stringify({ raise: false }) });
  const conversation = f.conversation();
  f.service.settings(conversation.id, {
    mode: 'hand_raise',
    maxActivations: 1,
    evaluationBudget: 1,
  });
  const message = f.service.publishHuman(conversation.id, {
    content: 'Is there a relevant concern?',
  });
  f.service.evaluate(conversation.id, message.id);
  await f.service.idle();
  expect(f.service.state(conversation.id).handRaises).toEqual([]);
  expect(f.service.state(conversation.id).executions[0].status).toBe(
    'succeeded',
  );
});

it('stops queued evaluations when the participation mode is disabled', async () => {
  const f = fixture();
  const conversation = f.conversation();
  f.service.settings(conversation.id, {
    mode: 'hand_raise',
    maxActivations: 1,
    evaluationBudget: 1,
  });
  const message = f.service.publishHuman(conversation.id, {
    content: 'Any concerns?',
  });
  f.service.evaluate(conversation.id, message.id);
  f.service.settings(conversation.id, {
    mode: 'manual',
    maxActivations: 1,
    evaluationBudget: 1,
  });
  await f.service.idle();
  expect(f.runtime.turn).not.toHaveBeenCalled();
  expect(f.service.state(conversation.id).executions[0].status).toBe('failed');
});

it('admits all selected executions atomically and safely retries after a storage failure', async () => {
  const f = fixture();
  const conversation = f.conversation();
  const input = {
    content: 'Compare assessments',
    activation: 'mentioned' as const,
    mentions: [{ type: 'all' as const, conversationId: conversation.id }],
    idempotencyKey: 'atomic-admission',
  };
  const original = f.workspace.collaboration.createExecution.bind(
    f.workspace.collaboration,
  );
  vi.spyOn(f.workspace.collaboration, 'createExecution')
    .mockImplementationOnce(original)
    .mockImplementationOnce(() => {
      throw new Error('Admission storage failed');
    })
    .mockImplementation(original);
  expect(() => f.service.publishHuman(conversation.id, input)).toThrow(
    'Admission storage failed',
  );
  await f.service.idle();
  expect(f.workspace.collaboration.executions(conversation.id)).toEqual([]);
  expect(f.runtime.turn).not.toHaveBeenCalled();
  f.service.publishHuman(conversation.id, input);
  await f.service.idle();
  expect(f.runtime.turn).toHaveBeenCalledTimes(2);
  expect(
    f.workspace.listConversationMessagesForUser(conversation.id, 'owner'),
  ).toHaveLength(3);
});

it.each(['paused', 'removed'] as const)(
  'prevents activation after Session Agent status becomes %s',
  async (status) => {
    const f = fixture();
    const conversation = f.conversation();
    f.workspace.setSessionAgentStatus(f.agents[0].id, status);
    const response = await f.app.request(
      `/api/organizational-conversations/${conversation.id}/messages`,
      request({
        content: 'Forbidden',
        activation: 'mentioned',
        mentions: [f.mention(conversation.id)],
      }),
    );
    expect(response.status).toBe(400);
    expect(f.runtime.turn).not.toHaveBeenCalled();
  },
);

it('rechecks revocation and participation intervals after compute and refuses publication after removal/rejoin', async () => {
  const started = deferred<void>();
  const finish = deferred<string>();
  const f = fixture({
    turn: async () => {
      started.resolve();
      return finish.promise;
    },
  });
  const conversation = f.conversation();
  f.service.publishHuman(conversation.id, {
    content: 'Assess',
    activation: 'mentioned',
    mentions: [f.mention(conversation.id)],
  });
  await started.promise;
  f.workspace.leaveConversation(
    conversation.id,
    'session_agent',
    f.agents[0].id,
  );
  f.workspace.rejoinConversation(
    conversation.id,
    'session_agent',
    f.agents[0].id,
  );
  finish.resolve('No longer authorized');
  await f.service.idle();
  expect(f.workspace.collaboration.executions(conversation.id)[0].status).toBe(
    'failed',
  );
  expect(
    f.workspace.listConversationMessagesForUser(conversation.id, 'owner'),
  ).toHaveLength(1);
});

it('assembles separate contexts for the same permanent Dot in two projects', async () => {
  const f = fixture();
  const otherSpace = f.workspace.createSpace(
    'Other',
    'Confidential second project',
  );
  const dot = f.workspace.dot(f.dots[0].id)!;
  f.workspace.updateDot(dot.id, {
    ...dot,
    spaceIds: [...dot.spaceIds, otherSpace.id],
  });
  const otherMaster = f.workspace.createMasterSession(
    otherSpace.id,
    'Project Atlas',
  );
  const otherAgent = f.workspace.addSessionAgent(
    otherMaster.id,
    dot.id,
    'Auditor',
    'Inspect financial risks only',
  );
  const first = f.conversation([0], 'direct');
  const second = f.workspace.openDirectConversationForOwner(
    otherMaster.id,
    'owner',
    otherAgent.id,
  );
  f.service.publishHuman(first.id, {
    content: 'Orion secret',
    activation: 'direct',
  });
  f.service.publishHuman(second.id, {
    content: 'Atlas budget',
    activation: 'direct',
  });
  await f.service.idle();
  expect(f.contexts[0]).not.toContain('Atlas budget');
  expect(f.contexts[1]).not.toContain('Orion secret');
  expect(f.contexts[1]).toContain('Inspect financial risks only');
  expect(f.contexts[1]).toContain('Laura');
});

it('blocks public runtime, voice, page and scheduled-task access to managed Intelligence threads', async () => {
  const f = fixture();
  const conversation = f.conversation([0], 'direct');
  f.service.publishHuman(conversation.id, {
    content: 'Reply',
    activation: 'direct',
  });
  await f.service.idle();
  const execution = f.workspace.collaboration.executions(conversation.id)[0];
  for (const [path, method, body] of [
    [`threads/${execution.threadId}/messages`, 'GET', null],
    [`agent/${execution.dotId}/run`, 'POST', { threadId: execution.threadId }],
    [`threads/${execution.threadId}`, 'PATCH', {}],
  ] as const)
    expect(() =>
      validateRuntimeScope(
        new Request(`http://localhost/api/copilotkit/${path}`, { method }),
        f.workspace,
        body,
      ),
    ).toThrow();
  expect(() => f.workspace.requireHumanThread(execution.threadId)).toThrow(
    /internal/,
  );
  const state = await f.app.request(
    `/api/organizational-conversations/${conversation.id}/collaboration`,
  );
  const data = await state.json();
  expect(data.executions[0].output).toBeUndefined();
  expect(data.executions[0].authorization).toBeUndefined();
});

it('recovers a completed but unpublished answer with ACL checks and no rerun', async () => {
  const f = fixture();
  const conversation = f.conversation([0], 'direct');
  const original = f.workspace.appendAgentConversationMessage.bind(f.workspace);
  const failure = vi
    .spyOn(f.workspace, 'appendAgentConversationMessage')
    .mockImplementationOnce(() => {
      throw new Error('Publication storage unavailable');
    });
  f.service.publishHuman(conversation.id, {
    content: 'Reply',
    activation: 'direct',
  });
  await f.service.idle();
  const execution = f.workspace.collaboration.executions(conversation.id)[0];
  expect(execution.status).toBe('failed');
  expect(execution.output).toContain('Actual runtime contribution');
  failure.mockImplementation(original);
  f.service.retryPublication(conversation.id, execution.id);
  f.service.retryPublication(conversation.id, execution.id);
  expect(f.runtime.turn).toHaveBeenCalledTimes(1);
  expect(
    f.workspace.listConversationMessagesForUser(conversation.id, 'owner'),
  ).toHaveLength(2);
});

it('preserves history, raises and execution outcomes across restart and marks interrupted work without replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opendots-collaboration-'));
  const path = join(directory, 'workspace.sqlite');
  cleanup.push(async () => {
    rmSync(directory, { recursive: true, force: true });
  });
  const f = fixture({ path });
  const conversation = f.conversation([0], 'direct');
  f.service.settings(conversation.id, {
    mode: 'hand_raise',
    maxActivations: 1,
    evaluationBudget: 1,
  });
  const message = f.service.publishHuman(conversation.id, {
    content: 'Persist this',
    activation: 'direct',
    idempotencyKey: 'persistent',
  });
  await f.service.idle();
  f.service.evaluate(conversation.id, message.id);
  await f.service.idle();
  f.workspace.collaboration.createExecution({
    requestId: 'crashed',
    conversationId: conversation.id,
    sessionAgentId: f.agents[0].id,
    dotId: f.dots[0].id,
    triggerMessageId: message.id,
    kind: 'response',
    authorization: collaborationAuthorization(
      f.workspace,
      conversation.id,
      f.agents[0].id,
    ),
  });
  const restarted = new WorkspaceStore(path, 'owner');
  const runtime = {
    ready: vi.fn(),
    createThread: vi.fn(async () => {}),
    turn: vi.fn(async () => 'Unexpected replay'),
  };
  const service = new CollaborationService(restarted, runtime);
  cleanup.push(async () => {
    service.stop();
    await service.idle();
    restarted.close();
  });
  expect(
    restarted.listConversationMessagesForUser(conversation.id, 'owner'),
  ).toHaveLength(2);
  expect(service.state(conversation.id).handRaises[0].status).toBe('pending');
  expect(
    service
      .state(conversation.id)
      .executions.some((execution) => execution.status === 'interrupted'),
  ).toBe(true);
  await service.idle();
  expect(runtime.turn).not.toHaveBeenCalled();
});

it('runs the native DotAgent with permanent instructions and SOUL, publishes actual streamed text and disables Learning', async () => {
  const f: ReturnType<typeof fixture> = fixture({
    turn: async (execution) => {
      const native = new DotAgent(
        f.store,
        f.workspace,
        {
          intelligenceKey: 'fixture',
          apiKey: 'fixture',
          model: 'fixture-model',
          baseUrl: 'https://unused.invalid/v1',
          runtimeUrl: '',
          voiceName: 'marin',
          slackUsers: [],
        },
        execution.dotId,
      );
      const events = await lastValueFrom(
        native
          .run({
            threadId: execution.threadId,
            runId: 'canonical-native-run',
            messages: [
              {
                id: 'trigger',
                role: 'user',
                content: 'Respond using your authorized context.',
              },
            ],
            state: {},
            tools: [],
            context: [],
            forwardedProps: { prompt: 'Untrusted impersonation override' },
          })
          .pipe(toArray()),
      );
      expect(
        events.some((event) => event.type === EventType.RUN_FINISHED),
      ).toBe(true);
      return events
        .filter((event) => event.type === EventType.TEXT_MESSAGE_CHUNK)
        .map((event) => String(event.delta ?? ''))
        .join('');
    },
  });
  const template = f.workspace.memberTemplates()[0];
  const created = f.workspace.createDotFromMemberTemplate({
    memberTemplateId: template.id,
    name: 'Sofia',
  });
  const dot = f.workspace.dot(created.dot.id)!;
  f.workspace.updateDot(dot.id, {
    ...dot,
    spaceIds: [...dot.spaceIds, f.space.id],
    learningContainerId: 'permanent-learning',
    skillDeliveryEnabled: true,
  });
  const agent = f.workspace.addSessionAgent(
    f.master.id,
    dot.id,
    'Design reviewer',
    'Review accessibility',
  );
  const conversation = f.workspace.openDirectConversationForOwner(
    f.master.id,
    'owner',
    agent.id,
  );
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    completion({
      role: 'assistant',
      content: 'Actual native streamed contribution.',
    }),
  );
  f.service.publishHuman(conversation.id, {
    content: 'Assess the proposal',
    activation: 'direct',
  });
  await f.service.idle();
  expect(fetch).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  const system = body.messages
    .filter((message: { role: string }) => message.role === 'system')
    .map((message: { content: string }) => message.content)
    .join('\n');
  expect(system).toContain(dot.instructions);
  expect(system).toContain(f.workspace.dotProfile(dot.id).soulInstructions);
  expect(system).toContain('Review accessibility');
  expect(system).toContain('Sofia');
  expect(system).not.toContain('Untrusted impersonation override');
  expect(JSON.stringify(body)).not.toContain('copilotkit_load_skill');
  expect(
    f.workspace
      .listConversationMessagesForUser(conversation.id, 'owner')
      .at(-1),
  ).toMatchObject({
    content: 'Actual native streamed contribution.',
    sourceTurnId: 'canonical-native-run',
    senderId: agent.id,
  });
});

it('blocks new control paths after user revocation and expires a suspended agent’s pending hand raise', async () => {
  const f = fixture();
  const conversation = f.conversation();
  f.service.settings(conversation.id, {
    mode: 'hand_raise',
    maxActivations: 1,
    evaluationBudget: 1,
  });
  const message = f.service.publishHuman(conversation.id, {
    content: 'Any concerns?',
  });
  f.service.evaluate(conversation.id, message.id);
  await f.service.idle();
  const raise = f.service.state(conversation.id).handRaises[0];
  f.workspace.setSessionAgentStatus(raise.sessionAgentId, 'paused');
  expect(f.service.state(conversation.id).handRaises[0].status).toBe('expired');
  expect(() =>
    f.service.resolve(conversation.id, raise.id, 'approved'),
  ).toThrow();
  f.workspace.setMasterSessionStatus(f.master.id, 'paused');
  const response = await f.app.request(
    `/api/organizational-conversations/${conversation.id}/collaboration`,
  );
  expect(response.status).toBe(403);
  expect(() => f.service.evaluate(conversation.id, message.id)).toThrow();
});

it('does not evaluate a pre-join message through a new agent participation interval', async () => {
  const f = fixture();
  const conversation = f.conversation();
  f.service.settings(conversation.id, {
    mode: 'hand_raise',
    maxActivations: 1,
    evaluationBudget: 4,
  });
  const message = f.service.publishHuman(conversation.id, {
    content: 'Before the new participant',
  });
  f.workspace.addConversationParticipant(
    conversation.id,
    'user',
    'owner',
    'session_agent',
    f.agents[2].id,
  );
  f.service.evaluate(conversation.id, message.id);
  await f.service.idle();
  expect(
    f.runtime.turn.mock.calls.some(
      ([execution]) => execution.sessionAgentId === f.agents[2].id,
    ),
  ).toBe(false);
  expect(
    f.workspace.collaboration
      .executions(conversation.id)
      .find((execution) => execution.sessionAgentId === f.agents[2].id)?.status,
  ).toBe('failed');
});
