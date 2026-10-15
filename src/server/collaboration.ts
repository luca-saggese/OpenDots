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
  turn(execution: CollaborationExecution, signal: AbortSignal): Promise<string>;
}
export class CollaborationService {
  private tail: Promise<void> = Promise.resolve();
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
    if (this.stopped || this.options.paused?.())
      throw new Error('Agent execution is paused.');
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
  publishHuman(
    conversationId: string,
    input: {
      content: string;
      contentType?: 'text' | 'json';
      visibility?: 'conversation' | 'participants';
      idempotencyKey?: string;
      mentions?: CollaborationMention[];
      activation?: 'none' | 'mentioned' | 'direct';
    },
  ) {
    const { conversation } = this.workspace.collaborationAccess(
      conversationId,
      this.workspace.ownerId,
    );
    const eligible = this.eligible(conversationId);
    const activation = input.activation ?? 'none';
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
      targets.length >
      this.workspace.collaboration.settings(conversationId).maxActivations
    )
      throw new Error(
        'Activation limit exceeded. Select fewer collaborators or change the conversation budget.',
      );
    if (targets.length) this.available();
    for (const agent of targets)
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
    });
    if (fresh)
      this.tail = this.tail
        .then(() => this.execute(execution))
        .catch(() => {
          /* Execution outcome is persisted in execute. */
        });
    return execution;
  }
  private check(execution: CollaborationExecution) {
    if (
      execution.kind === 'evaluation' &&
      this.workspace.collaboration.settings(execution.conversationId).mode !==
        'hand_raise'
    )
      throw new Error('Hand raises are no longer enabled.');
    if (this.stopped || this.options.paused?.())
      throw new Error('Agent execution is paused.');
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
    const timeout = setTimeout(
      () => controller.abort(new Error('Agent execution timed out.')),
      this.options.timeoutMs ?? 90000,
    );
    const watcher = setInterval(() => {
      try {
        this.check(execution);
      } catch (error) {
        controller.abort(error);
      }
    }, 50);
    let stopWaiting: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      const stop = () =>
        reject(controller.signal.reason ?? new Error('Execution cancelled.'));
      stopWaiting = () => controller.signal.removeEventListener('abort', stop);
      controller.signal.addEventListener('abort', stop, { once: true });
    });
    try {
      this.workspace.collaboration.update(execution.id, 'running');
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
      const output = await Promise.race([
        this.runtime.turn(execution, controller.signal),
        aborted,
      ]);
      controller.signal.throwIfAborted();
      this.check(execution);
      if (!output.trim() || output.length > 20000)
        throw new Error('Runtime returned an empty or oversized contribution.');
      this.workspace.collaboration.update(execution.id, 'running', output);
      if (execution.kind === 'evaluation') {
        if (
          this.workspace.collaboration.settings(execution.conversationId)
            .mode !== 'hand_raise'
        )
          throw new Error('Hand raises are no longer enabled.');
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
        if (result.raise)
          this.workspace.collaboration.propose(
            execution,
            result.reason as string,
          );
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
          'failed',
          null,
          error instanceof Error ? error.message : 'Agent execution failed.',
        );
    } finally {
      clearTimeout(timeout);
      clearInterval(watcher);
      stopWaiting?.();
      this.controllers.delete(execution.id);
    }
  }
  private publishOutput(execution: CollaborationExecution, output: string) {
    assertCollaborationExecution(this.workspace, execution);
    return this.workspace.appendAgentConversationMessage({
      conversationId: execution.conversationId,
      sessionAgentId: execution.sessionAgentId,
      execution,
      content: output,
      idempotencyKey: `execution:${execution.id}`,
    });
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
      !['manual', 'hand_raise'].includes(settings.mode) ||
      !Number.isInteger(settings.maxActivations) ||
      settings.maxActivations < 1 ||
      settings.maxActivations > 8 ||
      !Number.isInteger(settings.evaluationBudget) ||
      settings.evaluationBudget < 1 ||
      settings.evaluationBudget > 4
    )
      throw new Error('Invalid participation settings or budget.');
    const { user } = this.workspace.collaborationAccess(
      conversationId,
      this.workspace.ownerId,
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
    await this.tail;
  }
  stop() {
    this.stopped = true;
    for (const execution of this.controllers.keys())
      this.controllers.get(execution)?.abort(new Error('Server is stopping.'));
  }
}
