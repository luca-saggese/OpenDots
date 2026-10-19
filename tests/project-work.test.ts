import { afterEach, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  workPlanPayloadSchema,
  type WorkPlanPayload,
} from '../src/shared/project-work.js';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import type { CollaborationExecution } from '../src/shared/types.js';

const stores: WorkspaceStore[] = [];
const platforms: Platform[] = [];
const dbStores: Store[] = [];
afterEach(() => {
  for (const platform of platforms.splice(0)) platform.collaboration.stop();
  for (const store of dbStores.splice(0)) store.close();
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(workspace);
  const space = workspace.createSpace('Workflow project', 'A bounded project.');
  const master = workspace.createMasterSession(space.id, 'Workflow project');
  const directorDot = workspace.createDot(
    space.id,
    'Director',
    'Facilitate project planning.',
    false,
    false,
  );
  const workerDot = workspace.createDot(
    space.id,
    'Worker',
    'Deliver a page.',
    false,
    false,
  );
  const director = workspace.addSessionAgent(
    master.id,
    directorDot.id,
    'Director',
    'Coordinate the plan.',
  );
  const worker = workspace.addSessionAgent(
    master.id,
    workerDot.id,
    'Story Teller',
    'Write project deliverables.',
  );
  const goal = workspace.projectWork.saveGoal(
    master.id,
    {
      title: 'Prepare brief',
      description: '',
      expectedOutcome: 'A reviewed brief.',
      completionCriteria: ['The brief covers the agreed scope.'],
      priority: 3,
      assigneeSessionAgentId: null,
    },
    workspace.ownerId,
  );
  return { workspace, master, director, worker, goal };
}
function payload(goalId: string, agentId: string): WorkPlanPayload {
  return {
    title: 'Project plan',
    summary: 'Create and review the requested brief.',
    definitionOfDone: ['The page is approved.'],
    tasks: [
      {
        key: 'write-brief',
        goalId,
        title: 'Write brief',
        description: 'Create the brief page.',
        assigneeSessionAgentId: agentId,
        reviewerSessionAgentId: null,
        priority: 3,
        dependsOn: [],
        acceptanceCriteria: ['Covers the agreed scope.'],
        deliverables: [{ title: 'Project brief', type: 'page' as const }],
      },
    ],
  };
}

it('rejects cyclic plans and unknown dependencies before approval', () => {
  const plan = payload('goal', 'agent');
  plan.tasks.push({
    ...plan.tasks[0],
    key: 'second',
    dependsOn: ['write-brief'],
  });
  plan.tasks[0].dependsOn = ['second'];
  expect(workPlanPayloadSchema.safeParse(plan).success).toBe(false);
  plan.tasks[0].dependsOn = ['missing'];
  expect(workPlanPayloadSchema.safeParse(plan).success).toBe(false);
});

it('approves a plan atomically, resolves dependencies, and makes duplicate approval harmlessly fail', () => {
  const f = fixture();
  const store = f.workspace.projectWork;
  store.setWorkflow(f.master.id, 'planning', {
    coordinatorSessionAgentId: f.director.id,
  });
  const conversation = f.workspace.createOrganizationalConversation({
    masterSessionId: f.master.id,
    title: 'Kickoff',
    kind: 'group',
    visibility: 'restricted',
    createdByType: 'user',
    createdById: 'owner',
    participants: [
      { participantType: 'user', participantId: 'owner' },
      { participantType: 'session_agent', participantId: f.director.id },
      { participantType: 'session_agent', participantId: f.worker.id },
    ],
  });
  const proposal = store.saveProposal({
    masterSessionId: f.master.id,
    payload: payload(f.goal.id, f.worker.id),
    coordinatorSessionAgentId: f.director.id,
    sourceConversationId: conversation.id,
    sourceMessageId: 'planning-message',
  });
  store.setWorkflow(f.master.id, 'awaiting_approval', {
    activePlanId: proposal.id,
  });
  store.approvePlan(proposal.id);
  const tasks = store.tasks(f.master.id);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({
    status: 'ready',
    taskKey: 'write-brief',
    attempts: 0,
    stage: 'work',
  });
  expect(store.workflow(f.master.id)?.status).toBe('running');
  expect(() => store.approvePlan(proposal.id)).toThrow(
    /no longer awaiting approval/i,
  );
});

it('does not approve a proposal after collaborator authorization is revoked', () => {
  const f = fixture();
  const store = f.workspace.projectWork;
  store.setWorkflow(f.master.id, 'planning', {
    coordinatorSessionAgentId: f.director.id,
  });
  const conversation = f.workspace.createOrganizationalConversation({
    masterSessionId: f.master.id,
    title: 'Kickoff',
    kind: 'group',
    visibility: 'restricted',
    createdByType: 'user',
    createdById: 'owner',
    participants: [
      { participantType: 'user', participantId: 'owner' },
      { participantType: 'session_agent', participantId: f.director.id },
      { participantType: 'session_agent', participantId: f.worker.id },
    ],
  });
  const proposal = store.saveProposal({
    masterSessionId: f.master.id,
    payload: payload(f.goal.id, f.worker.id),
    coordinatorSessionAgentId: f.director.id,
    sourceConversationId: conversation.id,
    sourceMessageId: 'planning-message',
  });
  store.setWorkflow(f.master.id, 'awaiting_approval', {
    activePlanId: proposal.id,
  });
  f.workspace.setSessionAgentStatus(f.worker.id, 'removed');
  expect(() => store.approvePlan(proposal.id)).toThrow(
    /no longer an active authorized collaborator/i,
  );
  expect(store.tasks(f.master.id)).toHaveLength(0);
});

it('claims a task once at a time and persists an explicit bounded retry attempt', () => {
  const f = fixture();
  const store = f.workspace.projectWork;
  store.setWorkflow(f.master.id, 'planning', {
    coordinatorSessionAgentId: f.director.id,
  });
  const conversation = f.workspace.createOrganizationalConversation({
    masterSessionId: f.master.id,
    title: 'Kickoff',
    kind: 'group',
    visibility: 'restricted',
    createdByType: 'user',
    createdById: 'owner',
    participants: [
      { participantType: 'user', participantId: 'owner' },
      { participantType: 'session_agent', participantId: f.director.id },
      { participantType: 'session_agent', participantId: f.worker.id },
    ],
  });
  const proposal = store.saveProposal({
    masterSessionId: f.master.id,
    payload: payload(f.goal.id, f.worker.id),
    coordinatorSessionAgentId: f.director.id,
    sourceConversationId: conversation.id,
    sourceMessageId: 'planning-message',
  });
  store.setWorkflow(f.master.id, 'awaiting_approval', {
    activePlanId: proposal.id,
  });
  store.approvePlan(proposal.id);

  const firstClaim = store.claimReady(f.master.id)!;
  expect(firstClaim.attempts).toBe(1);
  expect(store.claimReady(f.master.id)).toBeUndefined();
  store.setTaskRequest(firstClaim.id, 'stable-attempt-1', 'begin');
  expect(store.task(firstClaim.id)?.currentRequestKey).toBe('stable-attempt-1');
  store.setTaskState(firstClaim.id, 'failed', {
    error: 'Interrupted after the owner reviewed external side effects.',
  });
  store.setTaskState(firstClaim.id, 'ready', { clearExecution: true });

  const retryClaim = store.claimReady(f.master.id)!;
  expect(retryClaim.attempts).toBe(2);
  expect(retryClaim.currentRequestKey).toBeNull();
  expect(retryClaim.maxAttempts).toBe(3);
  expect(store.plans(f.master.id)[0]?.sourceConversationId).toBe(
    conversation.id,
  );
});

it('continues planning in the kickoff history and reuses the same planning activation on retry', async () => {
  const f = fixture();
  const dbStore = new Store(':memory:');
  dbStores.push(dbStore);
  const runtime = {
    ready: () => {},
    createThread: async () => {},
    turn: async (execution: CollaborationExecution) => {
      const trigger = f.workspace
        .listConversationMessagesForUser(execution.conversationId, 'owner')
        .find((message) => message.id === execution.triggerMessageId);
      if (trigger?.content.includes('project_work_plan_request'))
        return JSON.stringify(payload(f.goal.id, f.worker.id));
      if (trigger?.content.includes('"kind":"project_work_task"'))
        return JSON.stringify({
          state: 'complete',
          summary: 'Created the project brief.',
          deliverables: [
            {
              title: 'Project brief',
              content: '# Project brief\n\nScope and success criteria.',
            },
          ],
          consultations: [],
          delegations: [],
        });
      return `Kickoff contribution from ${execution.sessionAgentId}.`;
    },
  };
  const platform = new Platform(
    dbStore,
    f.workspace,
    {
      baseUrl: 'https://example.test',
      voiceName: 'marin',
      slackUsers: [],
      runtimeUrl: '',
      agentRunTimeoutMs: 1000,
    },
    runtime,
  );
  platforms.push(platform);
  const kickoff = f.workspace.initializeProjectKickoff(f.master.id, 'owner');
  expect(kickoff.started).toBe(false);
  platform.collaboration.startProjectKickoff(f.master.id);
  await platform.collaboration.idle();
  expect(
    f.workspace.initializeProjectKickoff(f.master.id, 'owner').started,
  ).toBe(true);

  await platform.projectWork.requestPlan(f.master.id, f.director.id);
  await platform.projectWork.requestPlan(f.master.id, f.director.id);
  await platform.collaboration.idle();
  await platform.projectWork.runOnce();
  const snapshot = f.workspace.projectWork.snapshot(f.master.id);
  expect(snapshot.workflow.status).toBe('awaiting_approval');
  expect(snapshot.plans[0]?.sourceConversationId).toBe(kickoff.conversation.id);
  expect(
    f.workspace
      .listConversationMessagesForUser(kickoff.conversation.id, 'owner')
      .filter((message) =>
        message.idempotencyKey?.startsWith('project-work-plan:'),
      ),
  ).toHaveLength(1);

  f.workspace.projectWork.approvePlan(snapshot.plans[0]!.id);
  const claimed = f.workspace.projectWork.claimReady(f.master.id)!;
  expect(claimed).toMatchObject({
    status: 'running',
    executionId: null,
    currentMode: null,
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await platform.collaboration.idle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await platform.projectWork.runOnce();
    if (
      f.workspace.projectWork.snapshot(f.master.id).tasks[0]?.status !==
      'running'
    )
      break;
  }
  const inReview = f.workspace.projectWork.snapshot(f.master.id);
  expect(inReview.tasks[0]?.status).toBe('in_review');
  expect(inReview.deliverables[0]?.status).toBe('in_review');
  expect(
    f.workspace.pages.get(f.master.spaceId, inReview.deliverables[0]!.pageId)
      .content,
  ).toContain('Scope and success criteria');
  platform.projectWork.reviewDeliverable(
    inReview.deliverables[0]!.id,
    'approved',
    '',
  );
  expect(f.workspace.projectWork.snapshot(f.master.id).tasks[0]?.status).toBe(
    'completed',
  );
});
