import {
  consultationResponseSchema,
  goalInputSchema,
  taskResultSchema,
  workPlanPayloadSchema,
  workReviewSchema,
  type ProjectWorkflow,
  type ProjectWorkTask,
  type WorkPlanPayload,
} from '../shared/project-work.js';
import type {
  CollaborationMention,
  OrganizationalMessage,
} from '../shared/types.js';
import type { CollaborationService } from './collaboration.js';
import type { WorkspaceStore } from './workspace.js';

const jsonOnly = (value: string) => {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? trimmed;
};

function parseOutput<T>(
  schema: {
    safeParse(value: unknown):
      | { success: true; data: T }
      | {
          success: false;
          error: { issues: Array<{ path: PropertyKey[]; message: string }> };
        };
  },
  output: string,
  label: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(jsonOnly(output));
  } catch {
    throw new Error(
      `${label} must be valid JSON. Request a revised proposal or retry the task.`,
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path
      .filter((part) => typeof part === 'string' || typeof part === 'number')
      .join('.');
    throw new Error(
      `${label} is incomplete or invalid${path ? ` at ${path}` : ''}: ${issue.message}`,
    );
  }
  return parsed.data;
}

export class ProjectWorkService {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopped = false;

  constructor(
    private workspace: WorkspaceStore,
    private collaboration: CollaborationService,
  ) {}

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), 1000);
    void this.tick();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    while (this.ticking)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async runOnce() {
    await this.tick();
  }

  snapshot(masterSessionId: string) {
    const master = this.workspace.masterSession(masterSessionId);
    if (!master || master.status === 'archived')
      throw new Error('Active project not found.');
    return this.workspace.projectWork.snapshot(masterSessionId);
  }

  saveGoal(masterSessionId: string, input: unknown, goalId?: string) {
    const master = this.requireActiveMaster(masterSessionId);
    const parsed = goalInputSchema.safeParse(input);
    if (!parsed.success)
      throw new Error('Provide a valid project goal and completion criteria.');
    const workflow = this.workspace.projectWork.ensureWorkflow(master.id);
    if (!['draft', 'blocked'].includes(workflow.status))
      throw new Error(
        'Project goals cannot change while approved work is running. Request a revised plan first.',
      );
    const assignee = parsed.data.assigneeSessionAgentId ?? null;
    if (
      assignee &&
      !this.workspace.projectWork.canAssignAgentForProject(master.id, assignee)
    )
      throw new Error(
        'Choose an active collaborator authorized for this project.',
      );
    const goal = this.workspace.projectWork.saveGoal(
      master.id,
      { ...parsed.data, assigneeSessionAgentId: assignee },
      this.workspace.ownerId,
      goalId,
    );
    this.workspace.projectWork.event(
      master.id,
      goalId ? 'goal_updated' : 'goal_created',
      'user',
      this.workspace.ownerId,
      { goalId: goal.id, title: goal.title },
    );
    return goal;
  }

  async requestPlan(
    masterSessionId: string,
    coordinatorSessionAgentId: string,
  ) {
    const master = this.requireActiveMaster(masterSessionId);
    const store = this.workspace.projectWork;
    const workflow = store.ensureWorkflow(master.id);
    if (workflow.status === 'planning') return workflow;
    if (
      !['draft', 'blocked', 'failed', 'awaiting_approval'].includes(
        workflow.status,
      )
    )
      throw new Error(
        'A plan can be requested only before work starts or after it is blocked.',
      );
    if (!store.goals(master.id).length)
      throw new Error(
        'Add at least one project goal before preparing a work plan.',
      );
    if (!store.canAssignAgentForProject(master.id, coordinatorSessionAgentId))
      throw new Error(
        'Choose an active collaborator authorized for this project as coordinator.',
      );
    const kickoff = this.workspace.initializeProjectKickoff(
      master.id,
      this.workspace.ownerId,
    );
    if (!kickoff.started)
      throw new Error(
        'Start the project kickoff before requesting its work plan.',
      );
    const conversation = this.workspace.organizationalConversation(
      kickoff.conversation.id,
    );
    if (!conversation || conversation.status !== 'active')
      throw new Error('The kickoff conversation is no longer active.');
    store.setWorkflow(master.id, 'planning', {
      coordinatorSessionAgentId,
      activePlanId: null,
      planningMessageId: null,
      error: null,
    });
    store.event(master.id, 'plan_requested', 'user', this.workspace.ownerId, {
      coordinatorSessionAgentId,
      sourceConversationId: kickoff.conversation.id,
    });
    await this.launchPlanRequest(master.id, kickoff.conversation.id);
    return store.workflow(master.id)!;
  }

  updatePlan(planId: string, input: unknown) {
    const plan = this.workspace.projectWork.plan(planId);
    if (!plan) throw new Error('Work plan proposal not found.');
    const payload = this.validatePlan(plan.masterSessionId, input);
    const updated = this.workspace.projectWork.updateProposal(planId, payload);
    this.workspace.projectWork.event(
      plan.masterSessionId,
      'plan_edited',
      'user',
      this.workspace.ownerId,
      { planId },
    );
    return updated;
  }

  approvePlan(planId: string) {
    const plan = this.workspace.projectWork.plan(planId);
    if (!plan) throw new Error('Work plan proposal not found.');
    const result = this.workspace.projectWork.approvePlan(planId);
    this.workspace.projectWork.event(
      plan.masterSessionId,
      'workflow_started',
      'user',
      this.workspace.ownerId,
      { planId },
    );
    void this.tick();
    return result;
  }

  rejectPlan(planId: string) {
    return this.workspace.projectWork.rejectPlan(planId);
  }

  setWorkflowStatus(
    masterSessionId: string,
    action: 'pause' | 'resume' | 'cancel',
  ) {
    const master = this.requireActiveMaster(masterSessionId);
    const store = this.workspace.projectWork;
    const workflow = store.workflow(master.id);
    if (!workflow) throw new Error('Project workflow not found.');
    if (action === 'pause') {
      if (workflow.status !== 'running')
        throw new Error('Only a running workflow can be paused.');
      store.setWorkflow(master.id, 'paused');
      store.event(
        master.id,
        'workflow_paused',
        'user',
        this.workspace.ownerId,
        {},
      );
    } else if (action === 'resume') {
      if (workflow.status !== 'paused')
        throw new Error('Only a paused workflow can be resumed.');
      store.setWorkflow(master.id, 'running');
      store.event(
        master.id,
        'workflow_resumed',
        'user',
        this.workspace.ownerId,
        {},
      );
    } else {
      if (['completed', 'cancelled'].includes(workflow.status))
        throw new Error('This workflow is already final.');
      store.setWorkflow(master.id, 'cancelled');
      for (const task of store.tasks(master.id)) {
        if (['pending', 'ready', 'changes_requested'].includes(task.status))
          store.setTaskState(task.id, 'cancelled');
        else if (
          task.executionId &&
          ['running', 'consulting', 'in_review'].includes(task.status)
        ) {
          const execution = this.workspace.collaboration.execution(
            task.executionId,
          );
          if (execution && ['queued', 'running'].includes(execution.status))
            this.collaboration.cancel(execution.conversationId, execution.id);
          store.setTaskState(task.id, 'cancelled', {
            error: 'Cancelled by project owner.',
          });
        }
      }
      store.event(
        master.id,
        'workflow_cancelled',
        'user',
        this.workspace.ownerId,
        {},
      );
    }
    void this.tick();
    return store.workflow(master.id)!;
  }

  retryTask(taskId: string) {
    const store = this.workspace.projectWork;
    const task = store.task(taskId);
    if (!task) throw new Error('Project task not found.');
    if (
      !['blocked', 'failed', 'interrupted', 'changes_requested'].includes(
        task.status,
      )
    )
      throw new Error('Only blocked or failed tasks can be retried.');
    if (task.attempts >= task.maxAttempts)
      throw new Error(
        `This task reached its ${task.maxAttempts} attempt limit.`,
      );
    if (
      !store.canAssignAgentForProject(
        task.masterSessionId,
        task.assigneeSessionAgentId,
      )
    )
      throw new Error(
        'The assigned collaborator is no longer active and authorized. Reassign the task first.',
      );
    store.setTaskState(task.id, 'ready', { clearExecution: true });
    store.setWorkflow(task.masterSessionId, 'running', { error: null });
    store.markGoalsBlocked(task.masterSessionId, false);
    store.event(
      task.masterSessionId,
      'task_retry_requested',
      'user',
      this.workspace.ownerId,
      {
        taskId,
        note: 'The owner explicitly authorized another attempt; inspect any uncertain external effects first.',
      },
      taskId,
    );
    void this.tick();
    return store.task(taskId)!;
  }

  reassignTask(taskId: string, sessionAgentId: string) {
    const task = this.workspace.projectWork.updateAssignee(
      taskId,
      sessionAgentId,
    );
    void this.tick();
    return task;
  }

  prioritizeTask(taskId: string, priority: number) {
    if (!Number.isInteger(priority) || priority < 1 || priority > 5)
      throw new Error('Task priority must be between 1 and 5.');
    return this.workspace.projectWork.updatePriority(taskId, priority);
  }

  reviewDeliverable(
    deliverableId: string,
    decision: 'approved' | 'changes_requested',
    feedback: string,
  ) {
    const store = this.workspace.projectWork;
    const deliverable = store.deliverable(deliverableId);
    if (!deliverable || deliverable.status !== 'in_review')
      throw new Error('Deliverable is no longer awaiting review.');
    const parsed = workReviewSchema.safeParse({ decision, feedback });
    if (!parsed.success)
      throw new Error('A review requesting changes needs clear feedback.');
    const task = store.task(deliverable.taskId)!;
    if (task.reviewerSessionAgentId)
      throw new Error(
        'This deliverable is assigned to a Session Agent reviewer.',
      );
    store.transaction(() => {
      store.updateDeliverableStatus(
        deliverable.id,
        decision === 'approved' ? 'approved' : 'changes_requested',
      );
      if (decision === 'approved') {
        store.setTaskState(task.id, 'completed', {
          error: null,
          clearExecution: true,
        });
        store.event(
          task.masterSessionId,
          'task_completed',
          'user',
          this.workspace.ownerId,
          { taskId: task.id, deliverableId },
          task.id,
          deliverableId,
          deliverable.sourceExecutionId,
        );
      } else if (task.attempts < task.maxAttempts) {
        store.setTaskState(task.id, 'changes_requested', {
          error: feedback,
          clearExecution: true,
        });
        store.setTaskState(task.id, 'ready', {
          error: feedback,
          clearExecution: true,
        });
        store.event(
          task.masterSessionId,
          'review_changes_requested',
          'user',
          this.workspace.ownerId,
          { taskId: task.id, deliverableId, feedback },
          task.id,
          deliverableId,
        );
      } else {
        store.setTaskState(task.id, 'blocked', {
          error: `Review limit reached: ${feedback}`,
          clearExecution: true,
        });
        store.setWorkflow(task.masterSessionId, 'blocked', {
          error: 'A deliverable did not pass review within its attempt limit.',
        });
        store.markGoalsBlocked(task.masterSessionId, true);
      }
    });
    void this.tick();
    return store.snapshot(task.masterSessionId);
  }

  finalDecision(
    masterSessionId: string,
    decision: 'accept' | 'changes_requested',
    feedback = '',
  ) {
    const master = this.requireActiveMaster(masterSessionId);
    if (decision === 'accept')
      return this.workspace.projectWork.acceptFinalDelivery(master.id);
    if (!feedback.trim() || feedback.length > 4000)
      throw new Error(
        'Describe the changes needed before requesting a revision.',
      );
    return this.workspace.projectWork.requestFinalChanges(
      master.id,
      feedback.trim(),
    );
  }

  private requireActiveMaster(masterSessionId: string) {
    const master = this.workspace.masterSession(masterSessionId);
    if (!master || master.status !== 'active')
      throw new Error('Active project not found.');
    return master;
  }

  private validatePlan(
    masterSessionId: string,
    input: unknown,
  ): WorkPlanPayload {
    const parsed = workPlanPayloadSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Plan is incomplete or invalid: ${issue.message}`);
    }
    const goals = new Set(
      this.workspace.projectWork.goals(masterSessionId).map((goal) => goal.id),
    );
    for (const task of parsed.data.tasks) {
      if (!goals.has(task.goalId))
        throw new Error(
          'Every planned task must refer to an existing project goal.',
        );
      if (
        !this.workspace.projectWork.canAssignAgentForProject(
          masterSessionId,
          task.assigneeSessionAgentId,
        )
      )
        throw new Error(
          'Plan assigns a task to an inactive or unauthorized collaborator.',
        );
      if (
        task.reviewerSessionAgentId &&
        !this.workspace.projectWork.canAssignAgentForProject(
          masterSessionId,
          task.reviewerSessionAgentId,
        )
      )
        throw new Error(
          'Plan assigns review to an inactive or unauthorized collaborator.',
        );
    }
    return parsed.data;
  }

  private async launchPlanRequest(
    masterSessionId: string,
    conversationId: string,
  ) {
    const store = this.workspace.projectWork;
    const workflow = store.workflow(masterSessionId)!;
    const coordinatorId = workflow.coordinatorSessionAgentId;
    if (
      !coordinatorId ||
      !store.canAssignAgentForProject(masterSessionId, coordinatorId)
    )
      throw new Error(
        'The selected coordinator is no longer active and authorized.',
      );
    const master = this.workspace.masterSession(masterSessionId)!;
    const goals = store.goals(masterSessionId);
    const team = this.workspace
      .sessionAgents(masterSessionId)
      .filter(
        (agent) =>
          agent.status === 'active' &&
          this.workspace.canAccessSpace(agent.dotId, master.spaceId),
      )
      .map((agent) => ({
        sessionAgentId: agent.id,
        dotId: agent.dotId,
        name: this.workspace.dot(agent.dotId)?.name,
        role: agent.role,
        mandate: agent.mandate,
        skills: this.workspace.dotProfile(agent.dotId).skills,
        summary: this.workspace.dotProfile(agent.dotId).summary,
      }));
    const planVersion =
      store
        .plans(masterSessionId)
        .reduce((max, plan) => Math.max(max, plan.version), 0) + 1;
    const idempotencyKey = `project-work-plan:${masterSessionId}:${planVersion}`;
    const content = JSON.stringify({
      kind: 'project_work_plan_request',
      instruction:
        'Propose a bounded, domain-independent work plan based on the project goals and authorized kickoff discussion. Do not execute any work. Return only JSON matching the schema below. Use only the listed goal IDs and active Session Agent IDs. Dependencies must refer to task keys in this plan and form a directed acyclic graph. Include a page deliverable and measurable acceptance criteria for every task. Assign a reviewer where the team has a suitable reviewer.',
      project: {
        id: master.id,
        name: master.name,
        description: master.description,
        spaceId: master.spaceId,
      },
      goals,
      team,
      constraints: {
        maxTasks: store.workflow(masterSessionId)!.maxTasks,
        maxAttemptsPerTask: store.workflow(masterSessionId)!.maxRetries + 1,
        maxDelegationDepth: store.workflow(masterSessionId)!.maxDelegationDepth,
        userRevisionRequest: workflow.error,
      },
      schema: {
        title: 'string',
        summary: 'string',
        definitionOfDone: ['string'],
        tasks: [
          {
            key: 'unique-short-key',
            goalId: 'existing-goal-id',
            title: 'string',
            description: 'string',
            assigneeSessionAgentId: 'active-session-agent-id',
            reviewerSessionAgentId: 'active-session-agent-id-or-null',
            priority: 'integer 1 to 5',
            dependsOn: ['task-key'],
            acceptanceCriteria: ['string'],
            deliverables: [{ title: 'string', type: 'page' }],
          },
        ],
      },
    });
    const mention = this.mention(conversationId, coordinatorId);
    const { message } = await this.publishActivation(
      masterSessionId,
      conversationId,
      coordinatorId,
      content,
      idempotencyKey,
      mention,
    );
    store.setWorkflow(masterSessionId, 'planning', {
      planningMessageId: message.id,
    });
  }

  private mention(
    conversationId: string,
    sessionAgentId: string,
  ): CollaborationMention {
    const agent = this.workspace.sessionAgent(sessionAgentId);
    const dot = agent && this.workspace.dot(agent.dotId);
    if (!agent || !dot) throw new Error('Session Agent not found.');
    return {
      type: 'agent',
      conversationId,
      sessionAgentId,
      dotId: dot.id,
      displayName: dot.name,
    };
  }

  private findIdempotentMessage(
    conversationId: string,
    idempotencyKey: string,
  ): OrganizationalMessage | undefined {
    let before: number | undefined;
    while (true) {
      const messages = this.workspace.listConversationMessagesForUser(
        conversationId,
        this.workspace.ownerId,
        before,
        100,
      );
      const found = messages.find(
        (message) => message.idempotencyKey === idempotencyKey,
      );
      if (found) return found;
      if (!messages.length) return undefined;
      before = messages[0].sequenceNumber;
    }
  }

  private async publishActivation(
    masterSessionId: string,
    conversationId: string,
    recipientSessionAgentId: string,
    content: string,
    idempotencyKey: string,
    mention = this.mention(conversationId, recipientSessionAgentId),
  ) {
    let message = this.findIdempotentMessage(conversationId, idempotencyKey);
    let execution =
      message &&
      this.workspace.collaboration
        .executions(conversationId)
        .find(
          (candidate) =>
            candidate.triggerMessageId === message!.id &&
            candidate.sessionAgentId === recipientSessionAgentId &&
            candidate.kind === 'response',
        );
    if (!message) {
      if (!this.workspace.projectWork.consumeActivation(masterSessionId))
        throw new Error(
          'Project work activation budget is exhausted. Increase its limit before continuing.',
        );
      try {
        message = this.collaboration.publishHuman(conversationId, {
          content,
          idempotencyKey,
          activation: 'mentioned',
          mentions: [mention],
        });
      } catch (error) {
        this.workspace.projectWork.refundActivation(masterSessionId);
        throw error;
      }
      execution = this.workspace.collaboration
        .executions(conversationId)
        .find(
          (candidate) =>
            candidate.triggerMessageId === message!.id &&
            candidate.sessionAgentId === recipientSessionAgentId &&
            candidate.kind === 'response',
        );
    } else if (!execution) {
      message = this.collaboration.publishHuman(conversationId, {
        content,
        idempotencyKey,
        activation: 'mentioned',
        mentions: [mention],
      });
      execution = this.workspace.collaboration
        .executions(conversationId)
        .find(
          (candidate) =>
            candidate.triggerMessageId === message!.id &&
            candidate.sessionAgentId === recipientSessionAgentId &&
            candidate.kind === 'response',
        );
    }
    if (!message || !execution)
      throw new Error(
        'The work activation was saved without an execution record. Retry safely from the project work panel.',
      );
    return { message, execution };
  }

  private async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      for (const workflow of this.workspace.projectWork.workflows()) {
        if (this.stopped) break;
        if (workflow.status === 'planning')
          await this.processPlanning(workflow);
        if (['running', 'paused'].includes(workflow.status))
          await this.processWorkflow(workflow.masterSessionId);
      }
    } catch {
      console.error(
        'Project work engine tick failed; will retry on the next tick.',
      );
    } finally {
      this.ticking = false;
    }
  }

  private async processPlanning(workflow: ProjectWorkflow) {
    const kickoff = this.workspace.initializeProjectKickoff(
      workflow.masterSessionId,
      this.workspace.ownerId,
    );
    if (!workflow.planningMessageId) {
      await this.launchPlanRequest(
        workflow.masterSessionId,
        kickoff.conversation.id,
      );
      return;
    }
    const execution = this.workspace.collaboration
      .executions(kickoff.conversation.id)
      .find(
        (candidate) =>
          candidate.triggerMessageId === workflow.planningMessageId &&
          candidate.sessionAgentId === workflow.coordinatorSessionAgentId,
      );
    if (!execution || ['queued', 'running'].includes(execution.status)) return;
    if (execution.status !== 'succeeded' || !execution.output) {
      this.blockWorkflow(
        workflow.masterSessionId,
        execution.error ??
          'The coordinator planning execution did not complete.',
      );
      return;
    }
    try {
      const payload = this.validatePlan(
        workflow.masterSessionId,
        parseOutput(workPlanPayloadSchema, execution.output, 'Work plan'),
      );
      const plan = this.workspace.projectWork.saveProposal({
        masterSessionId: workflow.masterSessionId,
        payload,
        coordinatorSessionAgentId: workflow.coordinatorSessionAgentId!,
        sourceConversationId: kickoff.conversation.id,
        sourceMessageId: workflow.planningMessageId,
      });
      this.workspace.projectWork.setWorkflow(
        workflow.masterSessionId,
        'awaiting_approval',
        {
          activePlanId: plan.id,
          planningMessageId: null,
          error: null,
        },
      );
      this.workspace.projectWork.event(
        workflow.masterSessionId,
        'plan_proposed',
        'session_agent',
        workflow.coordinatorSessionAgentId!,
        { planId: plan.id, version: plan.version },
        undefined,
        undefined,
        execution.id,
      );
    } catch (error) {
      this.blockWorkflow(
        workflow.masterSessionId,
        error instanceof Error
          ? error.message
          : 'The proposed work plan was invalid.',
      );
    }
  }

  private async processWorkflow(masterSessionId: string) {
    const store = this.workspace.projectWork;
    const workflow = store.workflow(masterSessionId)!;
    const master = this.workspace.masterSession(masterSessionId);
    if (!master || master.status !== 'active') {
      this.blockWorkflow(masterSessionId, 'The project is paused or archived.');
      return;
    }
    const activePlanId = workflow.activePlanId;
    if (!activePlanId) {
      this.blockWorkflow(
        masterSessionId,
        'The running workflow has no active approved plan.',
      );
      return;
    }
    await this.processConsultations(
      masterSessionId,
      workflow.status === 'running',
    );
    for (let task of store
      .tasks(masterSessionId)
      .filter((item) => item.planId === activePlanId)) {
      if (task.status === 'running' && !task.executionId && task.currentMode) {
        try {
          await this.startTaskExecution(task, task.currentMode);
        } catch (error) {
          this.blockTask(
            task.id,
            error instanceof Error
              ? error.message
              : 'Task activation could not be recovered.',
          );
        }
        task = store.task(task.id)!;
      } else if (
        task.status === 'in_review' &&
        task.stage === 'review' &&
        !task.executionId &&
        task.currentMode === 'review'
      ) {
        try {
          await this.startTaskExecution(task, 'review');
        } catch (error) {
          this.blockTask(
            task.id,
            error instanceof Error
              ? error.message
              : 'Review activation could not be recovered.',
          );
        }
        task = store.task(task.id)!;
      }
      if (task.status === 'running' && task.executionId)
        await this.processTaskExecution(task);
      else if (
        task.status === 'in_review' &&
        task.stage === 'review' &&
        task.executionId
      )
        await this.processAgentReview(task);
      else if (task.status === 'delegating')
        await this.resumeDelegatedParent(task);
    }
    const current = store.workflow(masterSessionId)!;
    if (current.status !== 'running') return;
    store.refreshReadyDependencies(masterSessionId);
    const tasks = store
      .tasks(masterSessionId)
      .filter((item) => item.planId === activePlanId);
    if (
      tasks.some((task) =>
        ['blocked', 'failed', 'interrupted'].includes(task.status),
      )
    ) {
      this.blockWorkflow(
        masterSessionId,
        'A task is blocked, failed, or interrupted. Review its status before resuming.',
      );
      return;
    }
    if (tasks.length && tasks.every((task) => task.status === 'completed')) {
      await this.prepareFinalReport(masterSessionId);
      return;
    }
    if (tasks.some((task) => task.status === 'running')) return;
    const ready = store.claimReady(masterSessionId);
    if (ready) {
      try {
        await this.startTaskExecution(ready, 'begin');
      } catch (error) {
        this.blockTask(
          ready.id,
          error instanceof Error ? error.message : 'Task activation failed.',
        );
      }
    }
  }

  private async startTaskExecution(
    task: ProjectWorkTask,
    mode: 'begin' | 'continue' | 'review',
  ) {
    const store = this.workspace.projectWork;
    const master = this.workspace.masterSession(task.masterSessionId)!;
    const kickoff = this.workspace.initializeProjectKickoff(
      task.masterSessionId,
      this.workspace.ownerId,
    );
    const taskNow = store.task(task.id)!;
    const idempotencyKey =
      mode === 'review'
        ? `project-work-review:${task.id}:${task.attempts}`
        : `project-work-task:${task.id}:attempt:${task.attempts}:${mode}`;
    store.setTaskStage(task.id, mode === 'review' ? 'review' : 'work');
    store.setTaskRequest(task.id, idempotencyKey, mode);
    const consultations = store
      .consultations(task.masterSessionId)
      .filter((item) => item.taskId === task.id && item.status === 'completed')
      .map((item) => ({
        from: this.workspace.dot(
          this.workspace.sessionAgent(item.recipientSessionAgentId)?.dotId ??
            '',
        )?.name,
        question: item.question,
        answer: item.answer,
      }));
    const children = store
      .tasks(task.masterSessionId)
      .filter(
        (item) => item.parentTaskId === task.id && item.status === 'completed',
      );
    const delegatedResults = children.map((child) => ({
      title: child.title,
      assigneeSessionAgentId: child.assigneeSessionAgentId,
      deliverables: store
        .deliverables(task.masterSessionId)
        .filter((item) => item.taskId === child.id)
        .map((item) => {
          try {
            return {
              title: item.title,
              content: this.workspace.pages
                .get(master.spaceId, item.pageId)
                .content.slice(0, 6000),
            };
          } catch {
            return {
              title: item.title,
              content: '[The source page is no longer available.]',
            };
          }
        }),
    }));
    let content: string;
    let recipient = task.assigneeSessionAgentId;
    if (mode === 'review') {
      recipient = task.reviewerSessionAgentId!;
      const deliverables = store
        .deliverables(task.masterSessionId)
        .filter(
          (item) => item.taskId === task.id && item.status === 'in_review',
        );
      content = JSON.stringify({
        kind: 'project_work_review',
        instruction:
          'Review the persisted deliverable against the task acceptance criteria. Return only JSON {"decision":"approved"} or {"decision":"changes_requested","feedback":"specific, actionable changes"}. Do not edit the page, execute tools, or start another task.',
        task: {
          title: task.title,
          description: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
        },
        deliverables: deliverables.map((item) => {
          try {
            return {
              title: item.title,
              content: this.workspace.pages
                .get(master.spaceId, item.pageId)
                .content.slice(0, 8000),
            };
          } catch {
            return {
              title: item.title,
              content: '[The page was removed before review.]',
            };
          }
        }),
      });
    } else {
      content = JSON.stringify({
        kind: 'project_work_task',
        instruction:
          'Do the assigned approved task. Use the provided context and tools only within their existing permissions. An approved work plan does not grant new tool permissions. Do not impersonate colleagues or start unapproved work. Return only JSON matching the result schema. Put actual finished content in each deliverable, never claims without content. If blocked, state why. Consultations must be specific questions for already authorized project collaborators. Delegations may only split this task into small bounded parts.',
        mode,
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
          deliverables: task.deliverables,
          reviewFeedback: taskNow.error,
        },
        priorConsultations: consultations,
        delegatedSubtasks: delegatedResults,
        resultSchema: {
          state: 'complete | blocked',
          summary: 'string',
          deliverables: [{ title: 'string', content: 'markdown content' }],
          consultations: [
            {
              recipientSessionAgentId: 'active project Session Agent ID',
              question: 'specific question',
            },
          ],
          delegations: [
            {
              title: 'string',
              description: 'bounded subtask',
              assigneeSessionAgentId: 'active project Session Agent ID',
              acceptanceCriteria: ['string'],
              deliverableTitle: 'string',
            },
          ],
        },
        limits: {
          maxConsultations: store.workflow(task.masterSessionId)!
            .maxConsultationsPerTask,
          maxDelegationDepth: store.workflow(task.masterSessionId)!
            .maxDelegationDepth,
          maxAttempts: task.maxAttempts,
        },
      });
    }
    const activation = await this.publishActivation(
      task.masterSessionId,
      kickoff.conversation.id,
      recipient,
      content,
      idempotencyKey,
    );
    store.attachExecution(
      task.id,
      activation.message.id,
      activation.execution.id,
    );
  }

  private async processTaskExecution(task: ProjectWorkTask) {
    const execution =
      task.executionId &&
      this.workspace.collaboration.execution(task.executionId);
    if (!execution || ['queued', 'running'].includes(execution.status)) return;
    const store = this.workspace.projectWork;
    if (execution.status !== 'succeeded' || !execution.output) {
      const status =
        execution.status === 'interrupted' || execution.status === 'cancelled'
          ? 'interrupted'
          : 'failed';
      store.setTaskState(task.id, status, {
        error: execution.error ?? 'Agent execution did not complete.',
      });
      store.event(
        task.masterSessionId,
        'task_execution_failed',
        'system',
        'work-engine',
        { taskId: task.id, status, error: execution.error },
        task.id,
        undefined,
        execution.id,
      );
      return;
    }
    let result;
    try {
      result = parseOutput(taskResultSchema, execution.output, 'Task result');
    } catch (error) {
      store.setTaskState(task.id, 'blocked', {
        error:
          error instanceof Error ? error.message : 'Task result was invalid.',
      });
      store.event(
        task.masterSessionId,
        'task_result_invalid',
        'system',
        'work-engine',
        { taskId: task.id, error: store.task(task.id)?.error },
        task.id,
        undefined,
        execution.id,
      );
      return;
    }
    if (result.state === 'blocked') {
      store.setTaskState(task.id, 'blocked', { error: result.summary });
      store.event(
        task.masterSessionId,
        'task_blocked',
        'session_agent',
        task.assigneeSessionAgentId,
        { taskId: task.id, reason: result.summary },
        task.id,
        undefined,
        execution.id,
      );
      return;
    }
    if (result.consultations.length && result.delegations.length) {
      store.setTaskState(task.id, 'blocked', {
        error:
          'A task result cannot start consultations and delegations at the same time. Retry with one bounded action.',
      });
      return;
    }
    const workflow = store.workflow(task.masterSessionId)!;
    if (result.consultations.length) {
      const existing = store
        .consultations(task.masterSessionId)
        .filter((item) => item.taskId === task.id).length;
      if (
        existing + result.consultations.length >
        workflow.maxConsultationsPerTask
      ) {
        store.setTaskState(task.id, 'blocked', {
          error: 'The consultation limit for this task has been reached.',
        });
        return;
      }
      for (const consultation of result.consultations) {
        if (
          consultation.recipientSessionAgentId ===
            task.assigneeSessionAgentId ||
          !store.canAssignAgentForProject(
            task.masterSessionId,
            consultation.recipientSessionAgentId,
          )
        ) {
          store.setTaskState(task.id, 'blocked', {
            error:
              'Consultations can target only another active, authorized project collaborator.',
          });
          return;
        }
      }
      store.transaction(() => {
        for (const consultation of result.consultations)
          store.saveConsultation({
            masterSessionId: task.masterSessionId,
            taskId: task.id,
            requesterSessionAgentId: task.assigneeSessionAgentId,
            recipientSessionAgentId: consultation.recipientSessionAgentId,
            question: consultation.question,
          });
        store.setTaskState(task.id, 'consulting', {
          clearExecution: true,
          error: null,
        });
      });
      return;
    }
    if (result.delegations.length) {
      const existing = store
        .tasks(task.masterSessionId)
        .filter((item) => item.parentTaskId === task.id).length;
      if (
        existing + result.delegations.length > 2 ||
        task.depth >= workflow.maxDelegationDepth
      ) {
        store.setTaskState(task.id, 'blocked', {
          error: 'This task exceeded the bounded delegation limit.',
        });
        return;
      }
      for (const delegated of result.delegations)
        if (
          delegated.assigneeSessionAgentId === task.assigneeSessionAgentId ||
          !store.canAssignAgentForProject(
            task.masterSessionId,
            delegated.assigneeSessionAgentId,
          )
        ) {
          store.setTaskState(task.id, 'blocked', {
            error:
              'Delegation can target only another active, authorized project collaborator.',
          });
          return;
        }
      store.transaction(() => {
        for (const delegated of result.delegations)
          store.addDelegatedTask({
            parent: task,
            ...delegated,
            maxTasks: workflow.maxTasks,
            maxDelegationDepth: workflow.maxDelegationDepth,
          });
        store.setTaskState(task.id, 'delegating', {
          clearExecution: true,
          error: result.summary,
        });
      });
      return;
    }
    if (
      !result.deliverables.length ||
      result.deliverables.length < task.deliverables.length
    ) {
      store.setTaskState(task.id, 'blocked', {
        error: 'The task did not return all required deliverable content.',
      });
      return;
    }
    const master = this.workspace.masterSession(task.masterSessionId)!;
    const planTitles = task.deliverables.map((item) => item.title);
    const version =
      store
        .deliverables(task.masterSessionId)
        .filter((item) => item.taskId === task.id).length + 1;
    store.transaction(() => {
      result.deliverables
        .slice(0, task.deliverables.length)
        .forEach((deliverable, index) => {
          if (!deliverable.content.trim())
            throw new Error('Deliverable content is empty.');
          const page = this.workspace.pages.create(master.spaceId, {
            title: planTitles[index] ?? deliverable.title,
            content: deliverable.content,
            parentId: null,
          });
          const saved = store.saveDeliverable({
            masterSessionId: task.masterSessionId,
            taskId: task.id,
            pageId: page.id,
            sessionAgentId: task.assigneeSessionAgentId,
            type: 'page',
            title: page.title,
            version,
            status: 'in_review',
            sourceExecutionId: execution.id,
          });
          store.event(
            task.masterSessionId,
            'deliverable_created',
            'session_agent',
            task.assigneeSessionAgentId,
            {
              taskId: task.id,
              deliverableId: saved.id,
              pageId: page.id,
              title: page.title,
            },
            task.id,
            saved.id,
            execution.id,
          );
        });
      store.setTaskState(task.id, 'in_review', {
        clearExecution: true,
        error: null,
      });
    });
    store.event(
      task.masterSessionId,
      'task_submitted_for_review',
      'session_agent',
      task.assigneeSessionAgentId,
      { taskId: task.id, summary: result.summary },
      task.id,
      undefined,
      execution.id,
    );
    if (task.reviewerSessionAgentId) {
      store.setTaskStage(task.id, 'review');
      await this.startTaskExecution(store.task(task.id)!, 'review');
    }
  }

  private async processAgentReview(task: ProjectWorkTask) {
    const execution =
      task.executionId &&
      this.workspace.collaboration.execution(task.executionId);
    if (!execution || ['queued', 'running'].includes(execution.status)) return;
    const store = this.workspace.projectWork;
    if (execution.status !== 'succeeded' || !execution.output) {
      store.setTaskState(task.id, 'blocked', {
        error:
          execution.error ??
          'The assigned reviewer did not complete the review.',
      });
      this.blockWorkflow(
        task.masterSessionId,
        'An assigned review could not be completed.',
      );
      return;
    }
    let review;
    try {
      review = parseOutput(workReviewSchema, execution.output, 'Review result');
    } catch (error) {
      store.setTaskState(task.id, 'blocked', {
        error:
          error instanceof Error ? error.message : 'Review output was invalid.',
      });
      this.blockWorkflow(
        task.masterSessionId,
        'The assigned reviewer returned an invalid review.',
      );
      return;
    }
    const deliverables = store
      .deliverables(task.masterSessionId)
      .filter((item) => item.taskId === task.id && item.status === 'in_review');
    store.transaction(() => {
      for (const deliverable of deliverables)
        store.updateDeliverableStatus(
          deliverable.id,
          review.decision === 'approved' ? 'approved' : 'changes_requested',
        );
      if (review.decision === 'approved') {
        store.setTaskState(task.id, 'completed', {
          clearExecution: true,
          error: null,
        });
        store.event(
          task.masterSessionId,
          'task_completed',
          'session_agent',
          task.reviewerSessionAgentId!,
          { taskId: task.id, review: review.decision },
          task.id,
          deliverables[0]?.id,
          execution.id,
        );
      } else if (task.attempts < task.maxAttempts) {
        store.setTaskState(task.id, 'changes_requested', {
          clearExecution: true,
          error: review.feedback,
        });
        store.setTaskState(task.id, 'ready', {
          clearExecution: true,
          error: review.feedback,
        });
        store.event(
          task.masterSessionId,
          'review_changes_requested',
          'session_agent',
          task.reviewerSessionAgentId!,
          { taskId: task.id, feedback: review.feedback },
          task.id,
          deliverables[0]?.id,
          execution.id,
        );
      } else {
        store.setTaskState(task.id, 'blocked', {
          clearExecution: true,
          error: `Review limit reached: ${review.feedback}`,
        });
        store.setWorkflow(task.masterSessionId, 'blocked', {
          error: 'A deliverable did not pass review within its attempt limit.',
        });
      }
    });
  }

  private async processConsultations(
    masterSessionId: string,
    canStart: boolean,
  ) {
    const store = this.workspace.projectWork;
    const activePlanId = store.workflow(masterSessionId)?.activePlanId;
    for (let consultation of store.consultations(masterSessionId)) {
      if (store.task(consultation.taskId)?.planId !== activePlanId) continue;
      if (consultation.status === 'queued') {
        if (!canStart) continue;
        try {
          const kickoff = this.workspace.initializeProjectKickoff(
            masterSessionId,
            this.workspace.ownerId,
          );
          const request = JSON.stringify({
            kind: 'project_work_consultation',
            instruction:
              'Answer the focused question below using your own role and mandate. Return only JSON {"answer":"concise, evidence-based answer"}. Do not start more consultations, delegate, execute unrelated work, or include private conversation transcripts.',
            taskId: consultation.taskId,
            question: consultation.question,
          });
          const activation = await this.publishActivation(
            masterSessionId,
            kickoff.conversation.id,
            consultation.recipientSessionAgentId,
            request,
            `project-work-consult:${consultation.id}`,
          );
          store.updateConsultation(consultation.id, 'running', {
            executionId: activation.execution.id,
          });
          store.event(
            masterSessionId,
            'consultation_started',
            'system',
            'work-engine',
            { consultationId: consultation.id },
            consultation.taskId,
            undefined,
            activation.execution.id,
          );
          consultation = store.consultation(consultation.id)!;
        } catch (error) {
          store.updateConsultation(consultation.id, 'failed');
          this.blockTask(
            consultation.taskId,
            error instanceof Error
              ? error.message
              : 'Consultation could not start.',
          );
          continue;
        }
      }
      if (consultation.status !== 'running' || !consultation.executionId)
        continue;
      const execution = this.workspace.collaboration.execution(
        consultation.executionId,
      );
      if (!execution || ['queued', 'running'].includes(execution.status))
        continue;
      if (execution.status !== 'succeeded' || !execution.output) {
        store.updateConsultation(
          consultation.id,
          execution.status === 'interrupted' ? 'interrupted' : 'failed',
        );
        this.blockTask(
          consultation.taskId,
          execution.error ?? 'Consultation failed.',
        );
        continue;
      }
      try {
        const answer = parseOutput(
          consultationResponseSchema,
          execution.output,
          'Consultation result',
        ).answer;
        store.updateConsultation(consultation.id, 'completed', { answer });
        store.event(
          masterSessionId,
          'consultation_completed',
          'session_agent',
          consultation.recipientSessionAgentId,
          { consultationId: consultation.id, answer },
          consultation.taskId,
          undefined,
          execution.id,
        );
      } catch (error) {
        store.updateConsultation(consultation.id, 'failed');
        this.blockTask(
          consultation.taskId,
          error instanceof Error
            ? error.message
            : 'Consultation result was invalid.',
        );
      }
    }
    if (!canStart) return;
    for (const task of store
      .tasks(masterSessionId)
      .filter(
        (item) => item.status === 'consulting' && item.planId === activePlanId,
      )) {
      const consultations = store
        .consultations(masterSessionId)
        .filter((item) => item.taskId === task.id);
      if (
        consultations.length &&
        consultations.every((item) => item.status === 'completed')
      ) {
        store.setTaskState(task.id, 'running', {
          clearExecution: true,
          error: null,
        });
        await this.startTaskExecution(store.task(task.id)!, 'continue');
      }
    }
  }

  private async resumeDelegatedParent(task: ProjectWorkTask) {
    const store = this.workspace.projectWork;
    const children = store
      .tasks(task.masterSessionId)
      .filter((item) => item.parentTaskId === task.id);
    if (
      children.some((child) =>
        ['blocked', 'failed', 'interrupted'].includes(child.status),
      )
    ) {
      this.blockTask(task.id, 'A delegated subtask is blocked.');
      return;
    }
    if (
      children.length &&
      children.every((child) => child.status === 'completed')
    ) {
      store.setTaskState(task.id, 'running', { clearExecution: true });
      await this.startTaskExecution(store.task(task.id)!, 'continue');
    }
  }

  private async prepareFinalReport(masterSessionId: string) {
    const store = this.workspace.projectWork;
    const workflow = store.workflow(masterSessionId)!;
    const kickoff = this.workspace.initializeProjectKickoff(
      masterSessionId,
      this.workspace.ownerId,
    );
    if (workflow.finalReportExecutionId) {
      const execution = this.workspace.collaboration.execution(
        workflow.finalReportExecutionId,
      );
      if (!execution || ['queued', 'running'].includes(execution.status))
        return;
      if (execution.status === 'succeeded' && execution.output?.trim()) {
        store.saveFinalReport(masterSessionId, execution.output, execution.id);
        return;
      }
      store.saveFinalReport(
        masterSessionId,
        this.deterministicReport(masterSessionId, execution.error),
        execution.id,
      );
      return;
    }
    const coordinatorId = workflow.coordinatorSessionAgentId;
    if (
      !coordinatorId ||
      !store.canAssignAgentForProject(masterSessionId, coordinatorId)
    ) {
      store.saveFinalReport(
        masterSessionId,
        this.deterministicReport(
          masterSessionId,
          'Coordinator is no longer active; this report was assembled from persisted workflow records.',
        ),
      );
      return;
    }
    const summary = this.deterministicReport(masterSessionId);
    try {
      const activation = await this.publishActivation(
        masterSessionId,
        kickoff.conversation.id,
        coordinatorId,
        JSON.stringify({
          kind: 'project_final_delivery',
          instruction:
            'Prepare a concise final delivery report from the approved plan and verified completed task results below. Do not create new tasks or claim an unverified result. Include achieved goals, deliverables, decisions, residual risks and excluded work. Return the report as clear Markdown.',
          persistedSummary: summary,
        }),
        `project-work-final:${masterSessionId}:${workflow.activePlanId}`,
      );
      store.setWorkflow(masterSessionId, 'running', {
        finalReportExecutionId: activation.execution.id,
      });
    } catch (error) {
      store.saveFinalReport(
        masterSessionId,
        this.deterministicReport(
          masterSessionId,
          error instanceof Error ? error.message : 'Coordinator report failed.',
        ),
      );
    }
  }

  private deterministicReport(
    masterSessionId: string,
    warning?: string | null,
  ) {
    const snapshot = this.workspace.projectWork.snapshot(masterSessionId);
    const goals = snapshot.goals
      .map((goal) => `- ${goal.title}: ${goal.expectedOutcome}`)
      .join('\n');
    const deliverables = snapshot.deliverables
      .map((item) => `- ${item.title} (Page ${item.pageId}, ${item.status})`)
      .join('\n');
    const taskSummary = snapshot.tasks
      .map((task) => `- ${task.title}: ${task.status}`)
      .join('\n');
    return [
      `# Project delivery — ${this.workspace.masterSession(masterSessionId)?.name ?? 'Project'}`,
      warning ? `> Coordinator report unavailable: ${warning}` : '',
      '## Goals',
      goals || '- No goals recorded.',
      '## Tasks',
      taskSummary || '- No tasks recorded.',
      '## Deliverables',
      deliverables || '- No deliverables recorded.',
      '## Completion',
      snapshot.plans
        .find((plan) => plan.id === snapshot.workflow.activePlanId)
        ?.definitionOfDone.map((item) => `- ${item}`)
        .join('\n') ??
        'All required tasks and reviews are complete; owner acceptance is pending.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private blockTask(taskId: string, error: string) {
    const store = this.workspace.projectWork;
    const task = store.task(taskId);
    if (!task) return;
    const status = task.status;
    if (['running', 'consulting', 'delegating', 'in_review'].includes(status))
      store.setTaskState(taskId, 'blocked', { error, clearExecution: true });
    store.event(
      task.masterSessionId,
      'workflow_blocked',
      'system',
      'work-engine',
      { taskId, error },
      taskId,
    );
    this.blockWorkflow(task.masterSessionId, error);
  }

  private blockWorkflow(masterSessionId: string, error: string) {
    const store = this.workspace.projectWork;
    store.setWorkflow(masterSessionId, 'blocked', {
      error: error.slice(0, 4000),
    });
    store.markGoalsBlocked(masterSessionId, true);
    store.event(masterSessionId, 'workflow_blocked', 'system', 'work-engine', {
      error: error.slice(0, 1000),
    });
  }
}
