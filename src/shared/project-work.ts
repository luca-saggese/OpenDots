import { z } from 'zod';

export const WORKFLOW_STATUSES = [
  'draft',
  'planning',
  'awaiting_approval',
  'running',
  'paused',
  'blocked',
  'awaiting_final_acceptance',
  'completed',
  'cancelled',
  'failed',
] as const;
export type ProjectWorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export type ProjectGoalStatus =
  'draft' | 'active' | 'blocked' | 'completed' | 'cancelled';
export interface ProjectGoal {
  id: string;
  masterSessionId: string;
  title: string;
  description: string;
  expectedOutcome: string;
  completionCriteria: string[];
  priority: number;
  status: ProjectGoalStatus;
  createdBy: string;
  assigneeSessionAgentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type WorkPlanStatus =
  'proposed' | 'approved' | 'rejected' | 'superseded';
export interface ProposedWorkTask {
  key: string;
  goalId: string;
  title: string;
  description: string;
  assigneeSessionAgentId: string;
  reviewerSessionAgentId: string | null;
  priority: number;
  dependsOn: string[];
  acceptanceCriteria: string[];
  deliverables: Array<{ title: string; type: 'page' }>;
}
export interface WorkPlanPayload {
  title: string;
  summary: string;
  definitionOfDone: string[];
  tasks: ProposedWorkTask[];
}
export interface WorkPlan extends WorkPlanPayload {
  id: string;
  masterSessionId: string;
  version: number;
  status: WorkPlanStatus;
  coordinatorSessionAgentId: string;
  sourceConversationId: string;
  sourceMessageId: string;
  createdAt: number;
  updatedAt: number;
}

export type WorkTaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'consulting'
  | 'delegating'
  | 'in_review'
  | 'changes_requested'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled';
export interface ProjectWorkTask {
  id: string;
  masterSessionId: string;
  goalId: string;
  planId: string;
  planVersion: number;
  taskKey: string;
  parentTaskId: string | null;
  depth: number;
  title: string;
  description: string;
  assigneeSessionAgentId: string;
  reviewerSessionAgentId: string | null;
  priority: number;
  dependsOn: string[];
  acceptanceCriteria: string[];
  deliverables: Array<{ title: string; type: 'page' }>;
  status: WorkTaskStatus;
  stage: 'work' | 'review';
  attempts: number;
  maxAttempts: number;
  executionId: string | null;
  triggerMessageId: string | null;
  currentRequestKey: string | null;
  currentMode: 'begin' | 'continue' | 'review' | null;
  leaseId: string | null;
  leaseUntil: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export type WorkDeliverableStatus =
  'in_review' | 'changes_requested' | 'approved' | 'accepted';
export interface WorkDeliverable {
  id: string;
  masterSessionId: string;
  taskId: string;
  pageId: string;
  sessionAgentId: string;
  type: 'page';
  title: string;
  version: number;
  status: WorkDeliverableStatus;
  sourceExecutionId: string;
  createdAt: number;
  updatedAt: number;
}

export type WorkConsultationStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
export interface WorkConsultation {
  id: string;
  masterSessionId: string;
  taskId: string;
  requesterSessionAgentId: string;
  recipientSessionAgentId: string;
  question: string;
  status: WorkConsultationStatus;
  executionId: string | null;
  answer: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkEvent {
  id: number;
  masterSessionId: string;
  kind: string;
  actorType: 'user' | 'session_agent' | 'system';
  actorId: string;
  taskId: string | null;
  deliverableId: string | null;
  executionId: string | null;
  value: Record<string, unknown>;
  createdAt: number;
}

export interface ProjectWorkflow {
  masterSessionId: string;
  status: ProjectWorkflowStatus;
  activePlanId: string | null;
  coordinatorSessionAgentId: string | null;
  planningMessageId: string | null;
  finalReport: string | null;
  finalReportExecutionId: string | null;
  activationCount: number;
  error: string | null;
  maxTasks: number;
  maxActivations: number;
  maxConsultationsPerTask: number;
  maxDelegationDepth: number;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectWorkSnapshot {
  workflow: ProjectWorkflow;
  goals: ProjectGoal[];
  plans: WorkPlan[];
  tasks: ProjectWorkTask[];
  deliverables: WorkDeliverable[];
  consultations: WorkConsultation[];
  events: WorkEvent[];
}

export const goalInputSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().max(4000).default(''),
    expectedOutcome: z.string().trim().min(1).max(4000),
    completionCriteria: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(12),
    priority: z.number().int().min(1).max(5).default(3),
    assigneeSessionAgentId: z.string().min(1).nullable().optional(),
  })
  .strict();

const proposedTaskSchema = z
  .object({
    key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}$/),
    goalId: z.string().min(1),
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(4000),
    assigneeSessionAgentId: z.string().min(1),
    reviewerSessionAgentId: z.string().min(1).nullable().default(null),
    priority: z.number().int().min(1).max(5).default(3),
    dependsOn: z.array(z.string().min(1)).max(40).default([]),
    acceptanceCriteria: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(12),
    deliverables: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(160),
            type: z.literal('page'),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

export const workPlanPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(4000),
    definitionOfDone: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
    tasks: z.array(proposedTaskSchema).min(1).max(40),
  })
  .strict()
  .superRefine((plan, context) => {
    const keys = new Set<string>();
    plan.tasks.forEach((task, index) => {
      if (keys.has(task.key))
        context.addIssue({
          code: 'custom',
          path: ['tasks', index, 'key'],
          message: 'Task keys must be unique.',
        });
      keys.add(task.key);
    });
    const indexByKey = new Map(
      plan.tasks.map((task, index) => [task.key, index]),
    );
    for (const [index, task] of plan.tasks.entries()) {
      if (new Set(task.dependsOn).size !== task.dependsOn.length)
        context.addIssue({
          code: 'custom',
          path: ['tasks', index, 'dependsOn'],
          message: 'Dependencies must be unique.',
        });
      for (const key of task.dependsOn) {
        if (!indexByKey.has(key) || key === task.key)
          context.addIssue({
            code: 'custom',
            path: ['tasks', index, 'dependsOn'],
            message: `Unknown or self-referencing dependency: ${key}`,
          });
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycle = (key: string): boolean => {
      if (visiting.has(key)) return true;
      if (visited.has(key)) return false;
      visiting.add(key);
      const task = plan.tasks[indexByKey.get(key)!];
      for (const dependency of task.dependsOn)
        if (indexByKey.has(dependency) && hasCycle(dependency)) return true;
      visiting.delete(key);
      visited.add(key);
      return false;
    };
    if ([...keys].some(hasCycle))
      context.addIssue({
        code: 'custom',
        path: ['tasks'],
        message: 'Task dependencies cannot contain a cycle.',
      });
  });

export const taskResultSchema = z
  .object({
    state: z.enum(['complete', 'blocked']),
    summary: z.string().trim().min(1).max(4000),
    deliverables: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(160),
            content: z.string().trim().min(1).max(100000),
          })
          .strict(),
      )
      .max(8),
    consultations: z
      .array(
        z
          .object({
            recipientSessionAgentId: z.string().min(1),
            question: z.string().trim().min(1).max(2000),
          })
          .strict(),
      )
      .max(3)
      .default([]),
    delegations: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(160),
            description: z.string().trim().min(1).max(2000),
            assigneeSessionAgentId: z.string().min(1),
            acceptanceCriteria: z
              .array(z.string().trim().min(1).max(500))
              .min(1)
              .max(8),
            deliverableTitle: z.string().trim().min(1).max(160),
          })
          .strict(),
      )
      .max(2)
      .default([]),
  })
  .strict();

export const workReviewSchema = z
  .object({
    decision: z.enum(['approved', 'changes_requested']),
    feedback: z.string().max(4000).default(''),
  })
  .strict()
  .superRefine((review, context) => {
    if (review.decision === 'changes_requested' && !review.feedback.trim())
      context.addIssue({
        code: 'custom',
        path: ['feedback'],
        message: 'A review requesting changes must include feedback.',
      });
  });

export const consultationResponseSchema = z
  .object({ answer: z.string().trim().min(1).max(8000) })
  .strict();
