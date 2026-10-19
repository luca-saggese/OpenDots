import type { BaseEvent } from '@ag-ui/core';
import type {
  CollaborationExecution,
  CollaborationMention,
  OrganizationalMessage,
} from '../shared/types.js';
import type { WorkspaceStore } from './workspace.js';
import type { CollaborationSettings } from './collaboration-store.js';
import {
  assembleCollaborationContext,
  assertCollaborationExecution,
  collaborationAuthorization,
} from './collaboration-context.js';

export interface CollaborationRuntime {
  ready(): void;
  createThread(threadId: string, dotId: string): Promise<void>;
  turn(
    execution: CollaborationExecution,
    signal: AbortSignal,
    onEvent: (event: BaseEvent) => void,
  ): Promise<string>;
}

const MAX_MEETING_ASSIGNMENT_ATTEMPTS = 4;

/** Recognize explicit speaker assignments, never names mentioned in ordinary prose. */
export function meetingAssignmentRecipients(
  content: string,
  participants: Array<{ id: string; name: string }>,
): string[] {
  const byName = new Map<string, string | null>();
  for (const participant of participants) {
    const key = participant.name.trim().toLocaleLowerCase();
    byName.set(key, byName.has(key) ? null : participant.id);
  }
  const recipients = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:[-*•]\s+|\d+[.)]\s+)(.+?)\s*(?:→|->|:)\s+\S/u,
    );
    if (!match) continue;
    const name = match[1]
      .replace(/^\*\*|\*\*$/g, '')
      .replace(/^@/, '')
      .trim()
      .toLocaleLowerCase();
    const id = byName.get(name);
    if (id) recipients.add(id);
  }
  return [...recipients];
}
export class CollaborationService {
  private readonly pending = new Map<string, CollaborationExecution>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly activeAgents = new Set<string>();
  private readonly maxConcurrentExecutions = 8;
  private controllers = new Map<string, AbortController>();
  private stopped = false;
  constructor(
    readonly workspace: WorkspaceStore,
    private runtime: CollaborationRuntime,
    private options: { timeoutMs?: number; paused?: () => boolean } = {},
  ) {
    workspace.collaboration.recover();
  }
  private available() {
    if (this.stopped) throw new Error('Server is stopping.');
    if (this.options.paused?.()) throw new Error('Agent execution is paused.');
    this.runtime.ready();
  }
  private eligible(conversationId: string) {
    const { conversation } = this.workspace.collaborationAccess(
      conversationId,
      this.workspace.ownerId,
    );
    return this.workspace
      .listConversationParticipants(
        conversationId,
        'user',
        this.workspace.ownerId,
      )
      .filter(
        (participant) =>
          participant.participantType === 'session_agent' &&
          participant.role !== 'observer',
      )
      .map((participant) =>
        this.workspace.sessionAgent(participant.participantId)!,
      )
      .filter(
        (agent) =>
          agent?.status === 'active' &&
          agent.masterSessionId === conversation.masterSessionId,
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  startProjectKickoff(masterSessionId: string) {
    const kickoff = this.workspace.initializeProjectKickoff(
      masterSessionId,
      this.workspace.ownerId,
    );
    const previousMessage = this.workspace
      .listConversationMessagesForUser(
        kickoff.conversation.id,
        this.workspace.ownerId,
      )
      .find(
        (message) =>
          message.idempotencyKey === `kickoff-start:${masterSessionId}`,
      );
    if (kickoff.started && previousMessage) {
      const mentions =
        this.workspace.collaboration.command(previousMessage.id)?.mentions ??
        [];
      return {
        ...kickoff,
        message: previousMessage,
        targets: mentions.flatMap((mention) => {
          if (mention.type !== 'agent') return [];
          const agent = this.workspace.sessionAgent(mention.sessionAgentId);
          const dot = agent && this.workspace.dot(agent.dotId);
          return agent && dot ? [`${dot.name} · ${agent.role}`] : [];
        }),
      };
    }
    const eligible = this.eligible(kickoff.conversation.id);
    const director = eligible.find(
      (agent) => agent.role.trim().toLocaleLowerCase() === 'director',
    );
    const targets = director
      ? [director]
      : eligible.slice(
          0,
          this.workspace.collaboration.settings(kickoff.conversation.id)
            .maxActivations,
        );
    if (!targets.length)
      throw new Error(
        'Kickoff is ready, but no active collaborators can respond.',
      );
    const mentions: CollaborationMention[] = targets.map((agent) => ({
      type: 'agent',
      conversationId: kickoff.conversation.id,
      sessionAgentId: agent.id,
      dotId: agent.dotId,
      displayName: this.workspace.dot(agent.dotId)!.name,
    }));
    const message = this.publishHuman(kickoff.conversation.id, {
      content: director
        ? 'Lead the project kickoff using the agenda above. Confirm the objective, facilitate a concise round of introductions, surface the most important open questions and risks, then propose concrete next steps with owners. Keep the discussion grounded in each collaborator’s project role and mandate.'
        : 'Begin the project kickoff using the agenda above. Each of you should briefly introduce your role, identify one useful first proposal, and surface any key missing information or risk. Coordinate with one another and finish with concrete next steps.',
      idempotencyKey: `kickoff-start:${masterSessionId}`,
      mentions,
      activation: 'mentioned',
    });
    return {
      ...kickoff,
      started: true,
      message,
      targets: targets.map((agent) => {
        const dot = this.workspace.dot(agent.dotId);
        return `${dot?.name ?? 'Collaborator'} · ${agent.role}`;
      }),
    };
  }
  publishHuman(
    conversationId: string,
    input: {
      content: string;
      contentType?: 'text' | 'json';
      visibility?: 'conversation' | 'participants';
      idempotencyKey?: string;
      mentions?: CollaborationMention[];
      activation?: 'none' | 'mentioned' | 'direct' | 'meeting';
    },
  ) {
    const { conversation } = this.workspace.collaborationAccess(
      conversationId,
      this.workspace.ownerId,
    );
    const eligible = this.eligible(conversationId);
    // Private one-to-one conversations request a response by default. An
    // explicit `none` remains the user's publish-only choice.
    const settings = this.workspace.collaboration.settings(conversationId);
    const activation =
      input.activation ??
      (conversation.kind === 'direct'
        ? 'direct'
        : conversation.kind === 'plenary' && settings.mode === 'meeting'
          ? 'meeting'
          : 'none');
    const mentions: CollaborationMention[] = (input.mentions ?? []).map(
      (mention) => {
        if (mention.conversationId !== conversationId)
          throw new Error('Mention conversation mismatch.');
        if (mention.type === 'all') return { type: 'all', conversationId };
        const agent = eligible.find(
          (candidate) => candidate.id === mention.sessionAgentId,
        );
        if (!agent || mention.dotId !== agent.dotId)
          throw new Error(
            'Mention is not an authorized conversation participant.',
          );
        this.workspace.collaborationAccess(
          conversationId,
          this.workspace.ownerId,
          agent.id,
        );
        return {
          type: 'agent',
          conversationId,
          sessionAgentId: agent.id,
          dotId: agent.dotId,
          displayName: this.workspace.dot(agent.dotId)!.name,
        };
      },
    );
    let targets =
      activation === 'mentioned'
        ? eligible.filter((agent) =>
            mentions.some(
              (mention) =>
                mention.type === 'all' || mention.sessionAgentId === agent.id,
            ),
          )
        : [];
    if (activation === 'direct') {
      if (conversation.kind !== 'direct' || eligible.length !== 1)
        throw new Error(
          'Direct activation requires one authorized private collaborator.',
        );
      targets = eligible;
    }
    if (activation === 'mentioned' && !targets.length)
      throw new Error('Select at least one structured mention.');
    if (
      activation === 'meeting' &&
      (conversation.kind !== 'plenary' || settings.mode !== 'meeting')
    )
      throw new Error(
        'Meeting listening requires an active plenary in meeting mode.',
      );
    const listeners = activation === 'meeting' ? eligible : [];
    if (activation === 'meeting' && !listeners.length)
      throw new Error('This meeting has no active authorized collaborators.');
    const activationLimit = settings.maxActivations;
    if (Math.max(targets.length, listeners.length) > activationLimit)
      throw new Error(
        `Activation limit exceeded: this message reaches ${Math.max(targets.length, listeners.length)} collaborators, but the conversation budget allows ${activationLimit}. Increase the budget or select fewer collaborators.`,
      );
    if (targets.length || listeners.length) this.available();
    for (const agent of [...targets, ...listeners])
      this.workspace.collaborationAccess(
        conversationId,
        this.workspace.ownerId,
        agent.id,
      );
    const message = this.workspace.appendUserConversationMessage({
      conversationId,
      userId: this.workspace.ownerId,
      content: input.content,
      contentType: input.contentType,
      visibility: input.visibility,
      idempotencyKey: input.idempotencyKey,
    });
    const previous = this.workspace.collaboration.command(message.id);
    this.workspace.collaboration.admit(() => {
      this.workspace.collaboration.saveCommand(message.id, {
        activation,
        mentions,
      });
      if (!previous)
        for (const agent of targets)
          this.enqueue(message, agent.id, message.id, 'response');
      if (!previous)
        for (const agent of listeners)
          this.enqueue(
            message,
            agent.id,
            `meeting-evaluation:${message.id}`,
            'evaluation',
          );
    });
    if (previous) return { ...message, mentions: previous.mentions };
    return { ...message, mentions };
  }
  private enqueue(
    message: OrganizationalMessage,
    sessionAgentId: string,
    requestId: string,
    kind: CollaborationExecution['kind'],
    handRaiseId?: string,
    meeting?: { rootId: string; depth: number },
  ) {
    const agent = this.workspace.sessionAgent(sessionAgentId)!;
    const { execution, fresh } = this.workspace.collaboration.createExecution({
      requestId,
      conversationId: message.conversationId,
      sessionAgentId,
      dotId: agent.dotId,
      triggerMessageId: message.id,
      kind,
      authorization: collaborationAuthorization(
        this.workspace,
        message.conversationId,
        sessionAgentId,
      ),
      handRaiseId,
      meetingRootId: meeting?.rootId,
      meetingDepth: meeting?.depth,
    });
    if (fresh) {
      this.pending.set(execution.id, execution);
      // Enqueue can run inside a SQLite admission transaction. Start the
      // runtime turn only after its caller has committed that transaction.
      queueMicrotask(() => this.pump());
    }
    return execution;
  }
  private pump() {
    if (this.stopped) return;
    for (const [id, execution] of this.pending) {
      if (this.active.size >= this.maxConcurrentExecutions) return;
      if (this.activeAgents.has(execution.sessionAgentId)) continue;
      this.pending.delete(id);
      this.activeAgents.add(execution.sessionAgentId);
      const running = this.execute(execution)
        .catch(() => {
          /* Execution outcome is persisted in execute. */
        })
        .finally(() => {
          this.active.delete(id);
          this.activeAgents.delete(execution.sessionAgentId);
          this.pump();
        });
      this.active.set(id, running);
    }
  }
  private check(execution: CollaborationExecution) {
    if (
      execution.kind === 'evaluation' &&
      !['hand_raise', 'meeting'].includes(
        this.workspace.collaboration.settings(execution.conversationId).mode,
      )
    )
      throw new Error('Hand raises are no longer enabled.');
    if (this.stopped) throw new Error('Server is stopping.');
    if (this.options.paused?.()) throw new Error('Agent execution is paused.');
    if (
      this.workspace.collaboration.execution(execution.id)?.status !== 'running'
    )
      throw new Error('Execution is no longer running.');
    assertCollaborationExecution(this.workspace, execution);
  }
  private async execute(execution: CollaborationExecution) {
    if (
      this.workspace.collaboration.execution(execution.id)?.status !== 'queued'
    )
      return;
    const controller = new AbortController();
    this.controllers.set(execution.id, controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let watcher: ReturnType<typeof setInterval> | undefined;
    let stopWaiting: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      const stop = () =>
        reject(controller.signal.reason ?? new Error('Execution cancelled.'));
      stopWaiting = () => controller.signal.removeEventListener('abort', stop);
      controller.signal.addEventListener('abort', stop, { once: true });
    });
    try {
      this.workspace.collaboration.update(execution.id, 'running');
      this.workspace.collaboration.stream(
        execution.id,
        'Starting response…',
        '',
      );
      timeout = setTimeout(
        () => controller.abort(new Error('Agent execution timed out.')),
        this.options.timeoutMs ?? 90000,
      );
      watcher = setInterval(() => {
        try {
          this.check(execution);
        } catch (error) {
          controller.abort(error);
        }
      }, 50);
      this.available();
      this.check(execution);
      this.workspace.prepareCollaborationThread(execution.id);
      await Promise.race([
        this.runtime.createThread(execution.threadId, execution.dotId),
        aborted,
      ]);
      this.check(execution);
      // Validate context before any compute; DotAgent assembles it again at the runtime boundary.
      assembleCollaborationContext(this.workspace, execution);
      const updateProgress = (progress: string) => {
        const latest = this.workspace.collaboration.execution(execution.id);
        this.workspace.collaboration.stream(
          execution.id,
          progress,
          latest?.partialOutput ?? '',
        );
      };
      const output = await Promise.race([
        this.runtime.turn(execution, controller.signal, (event) => {
          this.check(execution);
          if (event.type === 'TEXT_MESSAGE_CONTENT') {
            const latest = this.workspace.collaboration.execution(execution.id);
            const partial = `${latest?.partialOutput ?? ''}${event.delta}`;
            this.workspace.collaboration.stream(
              execution.id,
              'Writing response…',
              partial,
            );
          } else if (event.type === 'TOOL_CALL_START') {
            updateProgress(`Preparing tool ${event.toolCallName}…`);
          } else if (event.type === 'TOOL_CALL_END') {
            updateProgress('Tool running…');
          } else if (event.type === 'TOOL_CALL_RESULT') {
            updateProgress('Tool returned; continuing…');
          } else if (
            event.type === 'REASONING_MESSAGE_START' ||
            event.type === 'REASONING_START'
          ) {
            updateProgress('Considering the request…');
          }
        }),
        aborted,
      ]);
      controller.signal.throwIfAborted();
      this.check(execution);
      if (!output.trim() || output.length > 20000)
        throw new Error('Runtime returned an empty or oversized contribution.');
      this.workspace.collaboration.update(execution.id, 'running', output);
      if (execution.kind === 'evaluation') {
        const mode = this.workspace.collaboration.settings(
          execution.conversationId,
        ).mode;
        if (!['hand_raise', 'meeting'].includes(mode))
          throw new Error('Listening is no longer enabled.');
        const result = JSON.parse(output) as {
          raise?: unknown;
          reason?: unknown;
        };
        if (
          typeof result.raise !== 'boolean' ||
          (result.raise &&
            (typeof result.reason !== 'string' ||
              !result.reason.trim() ||
              result.reason.length > 400))
        )
          throw new Error('Invalid hand raise evaluation returned by runtime.');
        if (result.raise) {
          if (mode === 'meeting') {
            const trigger = this.trigger(
              execution.conversationId,
              execution.triggerMessageId,
            );
            if (trigger.senderType === 'user')
              this.enqueue(
                trigger,
                execution.sessionAgentId,
                `meeting-response:${trigger.id}`,
                'response',
                undefined,
                { rootId: trigger.id, depth: 0 },
              );
          } else
            this.workspace.collaboration.propose(
              execution,
              result.reason as string,
            );
        }
      } else
        this.publishOutput(
          this.workspace.collaboration.execution(execution.id)!,
          output,
        );
      this.workspace.collaboration.update(execution.id, 'succeeded', output);
    } catch (error) {
      const status = this.workspace.collaboration.execution(
        execution.id,
      )?.status;
      if (status !== 'cancelled')
        this.workspace.collaboration.update(
          execution.id,
          error instanceof Error && error.message === 'Server is stopping.'
            ? 'interrupted'
            : 'failed',
          null,
          error instanceof Error ? error.message : 'Agent execution failed.',
        );
    } finally {
      if (timeout) clearTimeout(timeout);
      if (watcher) clearInterval(watcher);
      stopWaiting?.();
      this.controllers.delete(execution.id);
    }
  }
  private publishOutput(execution: CollaborationExecution, output: string) {
    assertCollaborationExecution(this.workspace, execution);
    const message = this.workspace.appendAgentConversationMessage({
      conversationId: execution.conversationId,
      sessionAgentId: execution.sessionAgentId,
      execution,
      content: output,
      idempotencyKey: `execution:${execution.id}`,
    });
    try {
      this.dispatchMeetingAssignments(message);
    } catch (error) {
      console.error('Could not dispatch meeting assignments:', error);
    }
    return message;
  }

  private dispatchMeetingAssignments(message: OrganizationalMessage) {
    const conversation = this.workspace.organizationalConversation(
      message.conversationId,
    );
    if (
      conversation?.kind !== 'plenary' ||
      conversation.status !== 'active' ||
      message.senderType !== 'session_agent'
    )
      return;
    const settings = this.workspace.collaboration.settings(conversation.id);
    if (settings.mode !== 'meeting') return;
    const source =
      message.sourceThreadId &&
      this.workspace.collaboration.forThread(message.sourceThreadId);
    if (!source || (source.meetingDepth ?? 0) >= 2) return;
    const rootId = source.meetingRootId ?? source.triggerMessageId;
    const existing = this.workspace.collaboration
      .executions(conversation.id)
      .filter(
        (item) =>
          item.kind === 'response' &&
          (item.meetingRootId === rootId || item.triggerMessageId === rootId),
      );
    const alreadyAssigned = new Set(
      existing.map((item) => item.sessionAgentId),
    );
    const eligible = this.eligible(conversation.id);
    const recipients = meetingAssignmentRecipients(
      message.content,
      eligible.map((agent) => ({
        id: agent.id,
        name: this.workspace.dot(agent.dotId)?.name ?? '',
      })),
    ).filter(
      (agentId) =>
        agentId !== message.senderId && !alreadyAssigned.has(agentId),
    );
    if (!recipients.length) return;
    this.available();
    const remaining = Math.max(0, 12 - existing.length);
    for (const agentId of recipients.slice(
      0,
      Math.min(settings.maxActivations, remaining),
    ))
      this.enqueue(
        message,
        agentId,
        `meeting-assignment:${message.id}`,
        'response',
        undefined,
        { rootId, depth: (source.meetingDepth ?? 0) + 1 },
      );
  }

  /** Reconcile the last turn of each meeting after a restart without replaying existing executions. */
  resumeMeetings() {
    const recent = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const master of this.workspace
      .masterSessions()
      .filter((item) => item.status === 'active')) {
      for (const summary of this.workspace.conversationSummariesForOwner(
        master.id,
        this.workspace.ownerId,
      )) {
        const message = summary.lastMessage;
        if (
          summary.conversation.kind !== 'plenary' ||
          !message ||
          message.createdAt < recent
        )
          continue;
        try {
          this.dispatchMeetingAssignments(message);
        } catch (error) {
          console.error('Could not resume meeting assignments:', error);
        }
      }
    }
  }
  retryMeetingAssignment(conversationId: string, executionId: string) {
    const { conversation, user } = this.workspace.collaborationAccess(
      conversationId,
      this.workspace.ownerId,
    );
    if (
      conversation.kind !== 'plenary' ||
      this.workspace.collaboration.settings(conversationId).mode !== 'meeting'
    )
      throw new Error('This conversation is not an active meeting.');
    if (!['owner', 'moderator'].includes(user.role))
      throw new Error(
        'Only the meeting owner or moderator may retry an assignment.',
      );
    const execution = this.workspace.collaboration.execution(executionId);
    if (
      !execution ||
      execution.conversationId !== conversationId ||
      execution.kind !== 'response' ||
      !execution.requestId.startsWith('meeting-assignment:')
    )
      throw new Error('Meeting assignment execution not found.');
    const source = this.trigger(conversationId, execution.triggerMessageId);
    if (source.senderType !== 'session_agent')
      throw new Error('Meeting assignment source is invalid.');
    const base = `meeting-assignment:${source.id}`;
    const attempts = this.workspace.collaboration
      .executions(conversationId)
      .filter(
        (item) =>
          item.sessionAgentId === execution.sessionAgentId &&
          item.kind === 'response' &&
          item.triggerMessageId === source.id &&
          item.requestId.startsWith(base),
      );
    const latest = attempts.at(-1);
    if (
      !latest ||
      latest.id !== execution.id ||
      !['failed', 'interrupted'].includes(latest.status)
    )
      throw new Error(
        'Only the latest failed or interrupted assignment can be retried.',
      );
    if (attempts.length >= MAX_MEETING_ASSIGNMENT_ATTEMPTS)
      throw new Error('This assignment reached its four-attempt limit.');
    if (
      !this.eligible(conversationId).some(
        (agent) => agent.id === execution.sessionAgentId,
      )
    )
      throw new Error(
        'The assigned collaborator is no longer active or authorized.',
      );
    this.available();
    this.enqueue(
      source,
      execution.sessionAgentId,
      `${base}:retry:${attempts.length}`,
      'response',
      undefined,
      {
        rootId: execution.meetingRootId ?? source.id,
        depth: execution.meetingDepth ?? 1,
      },
    );
    return this.state(conversationId);
  }
  private trigger(conversationId: string, messageId: string) {
    let before: number | undefined;
    while (true) {
      const page = this.workspace.listConversationMessagesForUser(
        conversationId,
        this.workspace.ownerId,
        before,
        100,
      );
      const found = page.find((message) => message.id === messageId);
      if (found) return found;
      if (!page.length)
        throw new Error('Authorized activation message not found.');
      before = page[0].sequenceNumber;
    }
  }
  settings(conversationId: string, settings: CollaborationSettings) {
    if (
      !['manual', 'hand_raise', 'meeting'].includes(settings.mode) ||
      !Number.isInteger(settings.maxActivations) ||
      settings.maxActivations < 1 ||
      settings.maxActivations > 8 ||
      !Number.isInteger(settings.evaluationBudget) ||
      settings.evaluationBudget < 1 ||
      settings.evaluationBudget > 4
    )
      throw new Error('Invalid participation settings or budget.');
    const { user, conversation } = this.workspace.collaborationAccess(
      conversationId,
      this.workspace.ownerId,
    );
    if (settings.mode === 'meeting' && conversation.kind !== 'plenary')
      throw new Error(
        'Meeting listening is available only in plenary conversations.',
      );
    if (!['owner', 'moderator'].includes(user.role))
      throw new Error(
        'Only conversation owners or moderators may change participation settings.',
      );
    return this.workspace.collaboration.saveSettings(conversationId, settings);
  }
  evaluate(conversationId: string, messageId: string) {
    this.workspace.collaborationAccess(conversationId, this.workspace.ownerId);
    this.available();
    const settings = this.workspace.collaboration.settings(conversationId);
    if (settings.mode !== 'hand_raise')
      throw new Error('Enable hand raises for this conversation first.');
    const trigger = this.trigger(conversationId, messageId);
    if (trigger.senderType !== 'user')
      throw new Error(
        'Hand raise evaluations require an authorized human message.',
      );
    return this.workspace.collaboration.admit(() =>
      this.eligible(conversationId)
        .slice(0, settings.evaluationBudget)
        .map((agent) =>
          this.enqueue(
            trigger,
            agent.id,
            `evaluation:${messageId}`,
            'evaluation',
          ),
        ),
    );
  }
  resolve(
    conversationId: string,
    raiseId: string,
    action: 'approved' | 'dismissed',
  ) {
    const { user } = this.workspace.collaborationAccess(
      conversationId,
      this.workspace.ownerId,
    );
    if (!['owner', 'moderator'].includes(user.role))
      throw new Error(
        'Only conversation owners or moderators may give the floor.',
      );
    const raise = this.workspace.collaboration
      .raises(conversationId)
      .find((item) => item.id === raiseId);
    if (!raise) throw new Error('Hand raise not found.');
    if (raise.status !== 'pending') {
      if (raise.status === action) return raise;
      throw new Error('Hand raise was already resolved or expired.');
    }
    return this.workspace.collaboration.admit(() => {
      if (action === 'approved') {
        this.available();
        const evaluation = this.workspace.collaboration.execution(
          raise.executionId,
        )!;
        assertCollaborationExecution(this.workspace, evaluation);
        const trigger = this.trigger(conversationId, raise.triggerMessageId);
        this.enqueue(
          trigger,
          raise.sessionAgentId,
          `hand:${raise.id}`,
          'response',
          raise.id,
        );
      }
      this.workspace.collaboration.resolve(
        raise.id,
        action,
        this.workspace.ownerId,
      );
      return this.workspace.collaboration
        .raises(conversationId)
        .find((item) => item.id === raise.id)!;
    });
  }
  state(conversationId: string) {
    this.workspace.organizationalConversationForParticipant(
      conversationId,
      'user',
      this.workspace.ownerId,
    );
    const participants = this.workspace.listConversationParticipants(
      conversationId,
      'user',
      this.workspace.ownerId,
    );
    if (
      !participants.some(
        (item) =>
          item.participantType === 'user' &&
          item.participantId === this.workspace.ownerId,
      )
    )
      throw new Error('Active conversation membership required.');
    const active = new Set(
      participants
        .filter((item) => item.participantType === 'session_agent')
        .map((item) => item.participantId),
    );
    const userInterval = participants.find(
      (item) =>
        item.participantType === 'user' &&
        item.participantId === this.workspace.ownerId,
    )!.id;
    const visible = (execution: CollaborationExecution) =>
      JSON.parse(execution.authorization)[0] === userInterval;
    const raises = this.workspace.collaboration.raises(conversationId);
    for (const raise of raises) {
      if (raise.status !== 'pending') continue;
      try {
        if (!active.has(raise.sessionAgentId))
          throw new Error('Participant removed.');
        assertCollaborationExecution(
          this.workspace,
          this.workspace.collaboration.execution(raise.executionId)!,
        );
      } catch {
        this.workspace.collaboration.resolve(raise.id, 'expired', 'system');
      }
    }
    return {
      settings: this.workspace.collaboration.settings(conversationId),
      executions: this.workspace.collaboration
        .executions(conversationId)
        .filter(visible)
        .map((execution) => ({
          ...execution,
          output: undefined,
          authorization: undefined,
          canRecover:
            execution.kind === 'response' &&
            !!execution.output &&
            ['failed', 'interrupted'].includes(execution.status),
        })),
      handRaises: this.workspace.collaboration
        .raises(conversationId)
        .filter((raise) =>
          visible(this.workspace.collaboration.execution(raise.executionId)!),
        ),
    };
  }
  cancel(conversationId: string, executionId: string) {
    this.workspace.collaborationAccess(conversationId, this.workspace.ownerId);
    const execution = this.workspace.collaboration.execution(executionId);
    if (!execution || execution.conversationId !== conversationId)
      throw new Error('Execution not found in this conversation.');
    if (['queued', 'running'].includes(execution.status)) {
      this.workspace.collaboration.update(
        execution.id,
        'cancelled',
        null,
        'Cancelled by project owner.',
      );
      this.controllers
        .get(execution.id)
        ?.abort(new Error('Cancelled by project owner.'));
    }
  }
  retryPublication(conversationId: string, executionId: string) {
    this.workspace.collaborationAccess(conversationId, this.workspace.ownerId);
    const execution = this.workspace.collaboration.execution(executionId);
    if (
      !execution ||
      execution.conversationId !== conversationId ||
      execution.kind !== 'response' ||
      !execution.output ||
      !['failed', 'interrupted', 'succeeded'].includes(execution.status)
    )
      throw new Error('No completed response is available to republish.');
    if (
      this.workspace.collaboration
        .executions(conversationId)
        .some(
          (candidate) =>
            candidate.sessionAgentId === execution.sessionAgentId &&
            ['queued', 'running'].includes(candidate.status),
        )
    )
      throw new Error('Wait for the current contribution before republishing.');
    this.workspace.relinkCollaborationThread(execution.id);
    const message = this.publishOutput(execution, execution.output);
    this.workspace.collaboration.update(execution.id, 'succeeded');
    return message;
  }
  async idle() {
    while (this.pending.size || this.active.size) {
      this.pump();
      const running = [...this.active.values()];
      if (running.length) await Promise.all(running);
      else if (this.pending.size)
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  stop() {
    this.stopped = true;
    for (const execution of this.pending.values())
      if (
        this.workspace.collaboration.execution(execution.id)?.status ===
        'queued'
      )
        this.workspace.collaboration.update(
          execution.id,
          'interrupted',
          null,
          'Server stopped before this queued execution began; no run timeout was applied.',
        );
    this.pending.clear();
    for (const execution of this.controllers.keys())
      this.controllers.get(execution)?.abort(new Error('Server is stopping.'));
  }
}
