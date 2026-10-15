import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function fixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    workspace.close();
  });
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(store, workspace, {
    baseUrl: config.baseUrl,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  const space = workspace.createSpace('Project', 'Conversation tests.');
  const dots = ['Builder', 'Editor', 'Director'].map((name) =>
    workspace.createDot(space.id, name, `${name} instructions.`, false, false),
  );
  const master = workspace.createMasterSession(space.id, 'Project');
  const agents = dots.map((dot, index) =>
    workspace.addSessionAgent(
      master.id,
      dot.id,
      ['builder', 'editor', 'director'][index],
      `${dot.name} mandate.`,
    ),
  );
  return {
    workspace,
    app: createApp({
      store,
      runner: new Runner(store, config),
      config,
      platform,
    }),
    master,
    agents,
  };
}

const request = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function createDirect(
  app: ReturnType<typeof createApp>,
  masterSessionId: string,
  agentId: string,
) {
  return app.request(
    `/api/master-sessions/${masterSessionId}/conversations`,
    request({
      title: 'Private conversation',
      kind: 'direct',
      visibility: 'private',
      participantIds: [agentId],
    }),
  );
}

it('creates private, group, plenary, and agent-only conversations with explicit creators', async () => {
  const { workspace, app, master, agents } = fixture();
  const direct = await createDirect(app, master.id, agents[0].id);
  expect(direct.status).toBe(201);
  const directConversation = await direct.json();
  expect(
    workspace
      .conversationParticipants(directConversation.id)
      .map((item) => [item.participantType, item.participantId, item.role]),
  ).toEqual(
    expect.arrayContaining([
      ['user', 'owner', 'owner'],
      ['session_agent', agents[0].id, 'participant'],
    ]),
  );

  const group = await app.request(
    `/api/master-sessions/${master.id}/conversations`,
    request({
      title: 'Specialists',
      kind: 'group',
      visibility: 'restricted',
      participantIds: [agents[0].id, agents[1].id],
    }),
  );
  expect(group.status).toBe(201);
  const plenary = await app.request(
    `/api/master-sessions/${master.id}/conversations`,
    request({
      title: 'Team',
      kind: 'plenary',
      visibility: 'team',
      participantIds: [],
    }),
  );
  expect(plenary.status).toBe(201);
  expect(
    workspace
      .conversationParticipants((await plenary.json()).id)
      .filter(
        (item) =>
          item.participantType === 'session_agent' && item.status === 'active',
      ),
  ).toHaveLength(agents.length);
  expect(
    (
      await app.request(
        `/api/master-sessions/${master.id}/conversations`,
        request({
          title: 'Impersonated agent meeting',
          kind: 'agent_only',
          visibility: 'restricted',
          participantIds: agents.map((agent) => agent.id),
        }),
      )
    ).status,
  ).toBe(403);
  expect(() =>
    workspace.createOrganizationalConversation({
      masterSessionId: master.id,
      title: 'Forged agent conversation',
      kind: 'agent_only',
      visibility: 'restricted',
      createdByType: 'session_agent',
      createdById: 'forged',
      participants: agents.map((agent) => ({
        participantType: 'session_agent' as const,
        participantId: agent.id,
      })),
    }),
  ).toThrow(/creator is not authorized/);
  expect(
    workspace.organizationalConversation((await group.json()).id),
  ).toBeDefined();
});

it('lists ACL-filtered summaries and opens the same private project conversation idempotently', async () => {
  const { app, workspace, master, agents } = fixture();
  const otherSpace = workspace.createSpace(
    'Other project',
    'Separate project.',
  );
  const otherMaster = workspace.createMasterSession(
    otherSpace.id,
    'Other project',
  );
  const open = () =>
    app.request(
      `/api/master-sessions/${master.id}/conversations/direct`,
      request({ sessionAgentId: agents[0].id }),
    );
  const first = await open();
  const second = await open();
  expect(first.status).toBe(200);
  const firstConversation = await first.json();
  const secondConversation = await second.json();
  expect(firstConversation.id).toBe(secondConversation.id);
  const id = firstConversation.id;
  expect(
    (
      await app.request(
        `/api/organizational-conversations/${id}/messages`,
        request({
          content: 'private project update',
          idempotencyKey: 'summary-message',
        }),
      )
    ).status,
  ).toBe(201);
  const summaries = await app.request(
    `/api/master-sessions/${master.id}/conversation-summaries`,
  );
  expect(summaries.status).toBe(200);
  const rows = await summaries.json();
  expect(rows).toHaveLength(1);
  expect(rows[0].conversation.id).toBe(id);
  expect(rows[0].lastMessage.content).toBe('private project update');

  const wrongProject = await app.request(
    `/api/master-sessions/${otherMaster.id}/conversations/direct`,
    request({ sessionAgentId: agents[0].id }),
  );
  expect(wrongProject.status).toBe(400);
  const otherRows = await app.request(
    `/api/master-sessions/${otherMaster.id}/conversation-summaries`,
  );
  expect(await otherRows.json()).toEqual([]);
});

it('hides earlier messages from late joiners and preserves separate access intervals on rejoin', async () => {
  const { app, workspace, master, agents } = fixture();
  const created = await createDirect(app, master.id, agents[0].id);
  const conversation = await created.json();
  const postMessage = (content: string, idempotencyKey: string) =>
    app.request(
      `/api/organizational-conversations/${conversation.id}/messages`,
      request({ content, idempotencyKey }),
    );
  expect((await postMessage('first', 'first')).status).toBe(201);
  expect(
    (
      await app.request(
        `/api/organizational-conversations/${conversation.id}/participants`,
        request({
          participantType: 'session_agent',
          participantId: agents[1].id,
        }),
      )
    ).status,
  ).toBe(400);

  const group = await app.request(
    `/api/master-sessions/${master.id}/conversations`,
    request({
      title: 'Restricted group',
      kind: 'group',
      visibility: 'restricted',
      participantIds: [agents[0].id, agents[1].id],
    }),
  );
  const groupConversation = await group.json();
  const append = (content: string, idempotencyKey: string) =>
    app.request(
      `/api/organizational-conversations/${groupConversation.id}/messages`,
      request({ content, idempotencyKey }),
    );
  expect((await append('before entry', 'a')).status).toBe(201);
  expect(
    (
      await app.request(
        `/api/organizational-conversations/${groupConversation.id}/participants`,
        request({
          participantType: 'session_agent',
          participantId: agents[2].id,
        }),
      )
    ).status,
  ).toBe(201);
  expect((await append('after entry', 'b')).status).toBe(201);
  const lateJoinerMessages = workspace
    .listConversationMessages(
      groupConversation.id,
      'session_agent',
      agents[2].id,
    )
    .map((message) => message.content);
  expect(lateJoinerMessages).toEqual(['after entry']);
  expect(
    workspace.listConversationMessages(
      groupConversation.id,
      'session_agent',
      agents[2].id,
      1,
    ),
  ).toEqual([]);
  const participantList = await app.request(
    `/api/organizational-conversations/${groupConversation.id}/participants`,
  );
  expect(participantList.status).toBe(200);
  expect(
    workspace
      .conversationParticipants(groupConversation.id)
      .find(
        (participant) =>
          participant.participantType === 'session_agent' &&
          participant.participantId === agents[2].id,
      )?.joinedAfterSequence,
  ).toBe(1);
  workspace.leaveConversation(
    groupConversation.id,
    'session_agent',
    agents[2].id,
  );
  expect((await append('during absence', 'c')).status).toBe(201);
  expect(() =>
    workspace.listConversationMessages(
      groupConversation.id,
      'session_agent',
      agents[2].id,
    ),
  ).toThrow(/access denied/i);
  workspace.rejoinConversation(
    groupConversation.id,
    'session_agent',
    agents[2].id,
  );
  expect(
    workspace
      .listConversationMessages(
        groupConversation.id,
        'session_agent',
        agents[2].id,
      )
      .map((message) => message.content),
  ).toEqual(['after entry']);
  expect(
    (
      await app.request(
        `/api/organizational-conversations/${groupConversation.id}/messages`,
        request({ content: 'after rejoin', idempotencyKey: 'd' }),
      )
    ).status,
  ).toBe(201);
  expect(
    workspace
      .listConversationMessages(
        groupConversation.id,
        'session_agent',
        agents[2].id,
      )
      .map((message) => message.content),
  ).toEqual(['after entry', 'after rejoin']);
  const historicPage = workspace.listConversationMessages(
    groupConversation.id,
    'session_agent',
    agents[2].id,
    3,
    10,
  );
  expect(historicPage.map((message) => message.content)).toEqual([
    'after entry',
  ]);
  expect(
    workspace.listConversationMessages(
      groupConversation.id,
      'session_agent',
      agents[2].id,
      5,
      1,
    ),
  ).toEqual([expect.objectContaining({ content: 'after rejoin' })]);
  expect(
    workspace.listConversationMessages(
      groupConversation.id,
      'session_agent',
      agents[2].id,
      1,
    ),
  ).toEqual([]);
  expect(
    workspace
      .conversationParticipants(groupConversation.id)
      .filter(
        (participant) =>
          participant.participantType === 'session_agent' &&
          participant.participantId === agents[2].id,
      )
      .map((participant) => [
        participant.joinedAfterSequence,
        participant.leftAfterSequence,
      ]),
  ).toEqual([
    [1, 2],
    [3, null],
  ]);
});

it('lets a voluntarily departed agent page only messages from its prior intervals', async () => {
  const { workspace, master, agents } = fixture();
  const threadId = 'interval-reader-thread';
  workspace.bindThread(threadId, agents[0].dotId, 'Interval reader');
  workspace.associateSessionThread(agents[0].id, threadId, true);
  const conversation = workspace.createOrganizationalConversation({
    masterSessionId: master.id,
    title: 'Agent group',
    kind: 'group',
    visibility: 'restricted',
    createdByType: 'user',
    createdById: workspace.ownerId,
    participants: [
      { participantType: 'user', participantId: workspace.ownerId },
      { participantType: 'session_agent', participantId: agents[0].id },
      { participantType: 'session_agent', participantId: agents[1].id },
    ],
  });
  const write = (content: string) =>
    workspace.appendUserConversationMessage({
      conversationId: conversation.id,
      userId: workspace.ownerId,
      content,
    });
  write('before departure');
  workspace.leaveConversation(conversation.id, 'session_agent', agents[0].id);
  write('during absence');
  expect(
    workspace
      .listConversationMessagesForAgent(conversation.id, agents[0].id, {
        threadId,
        turnId: 'verified-reader-turn',
      })
      .map((message) => message.content),
  ).toEqual(['before departure']);
  workspace.rejoinConversation(conversation.id, 'session_agent', agents[0].id);
  write('after return');
  const page = workspace.listConversationMessagesForAgent(
    conversation.id,
    agents[0].id,
    { threadId, turnId: 'verified-reader-turn' },
    undefined,
    1,
  );
  expect(page.map((message) => message.content)).toEqual(['after return']);
  expect(
    workspace
      .listConversationMessagesForAgent(conversation.id, agents[0].id, {
        threadId,
        turnId: 'verified-reader-turn',
      })
      .map((message) => message.content),
  ).toEqual(['before departure', 'after return']);
});

it('prevents conversation owners and session peers from bypassing private ACLs', async () => {
  const { app, master, agents } = fixture();
  const created = await createDirect(app, master.id, agents[0].id);
  const conversation = await created.json();
  const second = await app.request(
    `/api/master-sessions/${master.id}/conversations`,
    request({
      title: 'Second private conversation',
      kind: 'direct',
      visibility: 'private',
      participantIds: [agents[1].id],
    }),
  );
  const secondConversation = await second.json();
  expect(second.status).toBe(201);
  expect(
    (
      await app.request(
        `/api/organizational-conversations/${secondConversation.id}/messages`,
        request({ content: 'cannot post to other private conversation' }),
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await app.request(
        `/api/organizational-conversations/${conversation.id}/participants`,
        request({
          participantType: 'session_agent',
          participantId: agents[2].id,
        }),
      )
    ).status,
  ).toBe(400);
});

it('denies a revoked participant access to metadata, listing, and message history', async () => {
  const { app, workspace, master, agents } = fixture();
  const created = await app.request(
    `/api/master-sessions/${master.id}/conversations`,
    request({
      title: 'Restricted group',
      kind: 'group',
      visibility: 'restricted',
      participantIds: [agents[0].id, agents[1].id],
    }),
  );
  const conversation = await created.json();
  await app.request(
    `/api/organizational-conversations/${conversation.id}/messages`,
    request({ content: 'historical content' }),
  );
  workspace.setSessionAgentStatus(agents[1].id, 'removed');
  expect(
    workspace.listUserConversations(master.id, workspace.ownerId),
  ).toContainEqual(expect.objectContaining({ id: conversation.id }));
  expect(() =>
    workspace.organizationalConversationForParticipant(
      conversation.id,
      'session_agent',
      agents[1].id,
    ),
  ).toThrow(/access denied/i);
  expect(() =>
    workspace.listConversationMessages(
      conversation.id,
      'session_agent',
      agents[1].id,
    ),
  ).toThrow(/access denied/i);
  expect(() =>
    workspace.listConversationParticipants(
      conversation.id,
      'session_agent',
      agents[1].id,
    ),
  ).toThrow(/access denied/i);
  expect(() =>
    workspace.listConversationThreadsForParticipant(
      conversation.id,
      'session_agent',
      agents[1].id,
    ),
  ).toThrow(/access denied/i);
});

it('records an internal agent creator without implicitly adding the human owner', () => {
  const { workspace, master, agents } = fixture();
  const threadId = 'agent-creator-thread';
  workspace.bindThread(threadId, agents[0].dotId, 'Builder thread');
  workspace.associateSessionThread(agents[0].id, threadId, true);
  const conversation = workspace.createInternalAgentConversation({
    masterSessionId: master.id,
    sessionAgentId: agents[0].id,
    title: 'Agent meeting',
    kind: 'agent_only',
    participants: [
      { participantType: 'session_agent', participantId: agents[1].id },
    ],
    verifiedExecution: { threadId, turnId: 'verified-turn' },
  });
  expect(conversation.createdByType).toBe('session_agent');
  expect(conversation.createdById).toBe(agents[0].id);
  const participants = workspace.conversationParticipants(conversation.id);
  expect(participants).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        participantType: 'session_agent',
        participantId: agents[0].id,
        role: 'owner',
      }),
      expect.objectContaining({
        participantType: 'session_agent',
        participantId: agents[1].id,
      }),
    ]),
  );
  expect(
    participants.some((participant) => participant.participantType === 'user'),
  ).toBe(false);
});

it('allows only verified active agents to read and paginate agent-only messages', () => {
  const { workspace, master, agents } = fixture();
  const threadId = 'agent-reader-thread';
  workspace.bindThread(threadId, agents[0].dotId, 'Agent reader');
  workspace.associateSessionThread(agents[0].id, threadId, true);
  const readerThread = 'agent-reader-thread-2';
  workspace.bindThread(readerThread, agents[1].dotId, 'Agent reader thread');
  workspace.associateSessionThread(agents[1].id, readerThread, true);
  const conversation = workspace.createInternalAgentConversation({
    masterSessionId: master.id,
    sessionAgentId: agents[0].id,
    title: 'Private agent meeting',
    kind: 'agent_only',
    participants: [
      { participantType: 'session_agent', participantId: agents[1].id },
    ],
    verifiedExecution: { threadId, turnId: 'creation-turn' },
  });
  workspace.appendAgentConversationMessage({
    conversationId: conversation.id,
    sessionAgentId: agents[0].id,
    execution: { threadId, turnId: 'sender-turn-1' },
    content: 'first agent message',
  });
  const second = workspace.appendAgentConversationMessage({
    conversationId: conversation.id,
    sessionAgentId: agents[0].id,
    execution: { threadId, turnId: 'sender-turn-2' },
    content: 'second agent message',
  });
  const execution = { threadId, turnId: 'reader-turn' };
  expect(
    workspace
      .listConversationMessagesForAgent(
        conversation.id,
        agents[1].id,
        { threadId: readerThread, turnId: 'reader-turn' },
        second.sequenceNumber,
        1,
      )
      .map((message) => message.content),
  ).toEqual(['first agent message']);
  expect(() =>
    workspace.listConversationMessagesForAgent(conversation.id, agents[1].id, {
      threadId,
      turnId: 'unlinked-for-reader',
    }),
  ).toThrow();
  const unlinkedThread = 'agent-reader-thread-3';
  workspace.bindThread(unlinkedThread, agents[1].dotId, 'Unlinked reader');
  workspace.associateSessionThread(agents[1].id, unlinkedThread);
  expect(() =>
    workspace.listConversationMessagesForAgent(conversation.id, agents[1].id, {
      threadId: unlinkedThread,
      turnId: 'unlinked-for-reader',
    }),
  ).toThrow(/not linked/i);
  expect(
    workspace
      .listConversationMessagesForAgent(conversation.id, agents[0].id, {
        threadId,
        turnId: 'sender-turn-3',
      })
      .map((message) => message.content),
  ).toEqual(['first agent message', 'second agent message']);
  expect(() =>
    workspace.listConversationMessages(
      conversation.id,
      'session_agent',
      agents[1].id,
    ),
  ).toThrow(/access denied/i);
  expect(() =>
    workspace.listConversationMessagesForAgent(
      conversation.id,
      agents[2].id,
      execution,
    ),
  ).toThrow(/access denied/i);
  expect(() =>
    workspace.listConversationMessagesForAgent(conversation.id, agents[1].id, {
      threadId: 'unassociated-thread',
      turnId: 'reader-turn',
    }),
  ).toThrow();
  workspace.setSessionAgentStatus(agents[1].id, 'paused');
  expect(() =>
    workspace.listConversationMessagesForAgent(conversation.id, agents[1].id, {
      threadId: readerThread,
      turnId: 'reader-turn',
    }),
  ).toThrow(/access denied/i);
});

it('denies suspended agents metadata, participant, message, and thread access', async () => {
  const { app, workspace, master, agents } = fixture();
  const created = await app.request(
    `/api/master-sessions/${master.id}/conversations`,
    request({
      title: 'Suspension group',
      kind: 'group',
      visibility: 'restricted',
      participantIds: [agents[0].id, agents[1].id],
    }),
  );
  const conversation = await created.json();
  workspace.setSessionAgentStatus(agents[1].id, 'paused');
  expect(() =>
    workspace.organizationalConversationForParticipant(
      conversation.id,
      'session_agent',
      agents[1].id,
    ),
  ).toThrow(/access denied/i);
  expect(() =>
    workspace.listConversationParticipants(
      conversation.id,
      'session_agent',
      agents[1].id,
    ),
  ).toThrow(/access denied/i);
  expect(() =>
    workspace.listConversationMessages(
      conversation.id,
      'session_agent',
      agents[1].id,
    ),
  ).toThrow(/access denied/i);
  expect(() =>
    workspace.listConversationThreadsForParticipant(
      conversation.id,
      'session_agent',
      agents[1].id,
    ),
  ).toThrow(/access denied/i);
  workspace.setSessionAgentStatus(agents[1].id, 'active');
  const conversationThreads = workspace.sessionThreads(agents[1].id);
  expect(conversationThreads).toEqual([]);
  const agentThread = 'suspended-agent-thread';
  workspace.bindThread(agentThread, agents[1].dotId, 'Suspended');
  workspace.associateSessionThread(agents[1].id, agentThread, true);
  expect(() =>
    workspace.addConversationThread(
      conversation.id,
      workspace.ownerId,
      agents[1].id,
      agentThread,
    ),
  ).toThrow(/not authorized/i);
  workspace.setSessionAgentStatus(agents[1].id, 'paused');
  expect(
    (
      await app.request(
        `/api/organizational-conversations/${conversation.id}/messages`,
        request({ content: 'human still authorized' }),
      )
    ).status,
  ).toBe(201);
});

it('isolates reuse of one Dot across different Master Sessions', async () => {
  const { app, workspace, master, agents } = fixture();
  const dotId = agents[0].dotId;
  const otherSpace = workspace.createSpace(
    'Second project',
    'Separate project.',
  );
  workspace.updateDot(agents[0].dotId, {
    ...workspace.dot(agents[0].dotId)!,
    spaceIds: [master.spaceId, otherSpace.id],
  });
  const otherMaster = workspace.createMasterSession(
    otherSpace.id,
    'Second project',
  );
  const otherAgent = workspace.addSessionAgent(
    otherMaster.id,
    dotId,
    'director',
    'Second project role.',
  );
  expect(otherAgent.id).not.toBe(agents[0].id);
  const firstConversation = await createDirect(app, master.id, agents[0].id);
  const secondConversation = await createDirect(
    app,
    otherMaster.id,
    otherAgent.id,
  );
  expect(firstConversation.status).toBe(201);
  expect(secondConversation.status).toBe(201);
  const first = await firstConversation.json();
  const second = await secondConversation.json();
  expect(() =>
    workspace.listConversationMessages(
      first.id,
      'session_agent',
      otherAgent.id,
    ),
  ).toThrow(/access denied/i);
  expect(() =>
    workspace.listConversationMessages(
      second.id,
      'session_agent',
      agents[0].id,
    ),
  ).toThrow(/access denied/i);
});

it('deduplicates messages, sequences writes, and survives reopening the database', async () => {
  const { workspace, master, agents } = fixture();
  const conversation = workspace.createOrganizationalConversation({
    masterSessionId: master.id,
    title: 'Direct',
    kind: 'direct',
    visibility: 'private',
    createdByType: 'user',
    createdById: workspace.ownerId,
    participants: [
      { participantType: 'user', participantId: workspace.ownerId },
      { participantType: 'session_agent', participantId: agents[0].id },
    ],
  });
  const append = (content: string, idempotencyKey: string) =>
    workspace.appendUserConversationMessage({
      conversationId: conversation.id,
      userId: workspace.ownerId,
      content,
      idempotencyKey,
    });
  const duplicate = append('same', 'same-key');
  expect(append('same', 'same-key').id).toBe(duplicate.id);
  const messages = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      Promise.resolve().then(() => append(`message-${index}`, `key-${index}`)),
    ),
  );
  expect(new Set(messages.map((message) => message.sequenceNumber)).size).toBe(
    12,
  );
  expect(
    workspace
      .listConversationMessagesForUser(conversation.id, workspace.ownerId)
      .map((message) => message.sequenceNumber),
  ).toEqual([1, ...Array.from({ length: 12 }, (_, index) => index + 2)]);
});

it('persists conversation participants, history cursors, and messages after restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opendots-conversations-'));
  const path = join(directory, 'workspace.sqlite');
  let firstWorkspace: WorkspaceStore | undefined = new WorkspaceStore(
    path,
    'owner',
  );
  try {
    const space = firstWorkspace.createSpace('Persisted', 'Restart test.');
    const dot = firstWorkspace.createDot(
      space.id,
      'Builder',
      'Builder.',
      false,
      false,
    );
    const master = firstWorkspace.createMasterSession(space.id, 'Persisted');
    const agent = firstWorkspace.addSessionAgent(
      master.id,
      dot.id,
      'builder',
      'Build.',
    );
    const conversation = firstWorkspace.createOrganizationalConversation({
      masterSessionId: master.id,
      title: 'Persistent conversation',
      kind: 'direct',
      visibility: 'private',
      createdByType: 'user',
      createdById: firstWorkspace.ownerId,
      participants: [
        { participantType: 'user', participantId: firstWorkspace.ownerId },
        { participantType: 'session_agent', participantId: agent.id },
      ],
    });
    firstWorkspace.appendUserConversationMessage({
      conversationId: conversation.id,
      userId: firstWorkspace.ownerId,
      content: 'Persisted message',
      idempotencyKey: 'persisted',
    });
    firstWorkspace.close();
    firstWorkspace = undefined;
    const reopened = new WorkspaceStore(path, 'owner');
    try {
      expect(
        reopened
          .listConversationMessagesForUser(conversation.id, reopened.ownerId)
          .map((message) => message.content),
      ).toEqual(['Persisted message']);
      expect(
        reopened
          .conversationParticipants(conversation.id)
          .map((participant) => participant.joinedAfterSequence),
      ).toEqual([0, 0]);
    } finally {
      reopened.close();
    }
  } finally {
    firstWorkspace?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
