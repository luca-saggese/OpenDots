import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  ProjectGoal,
  ProjectGoalStatus,
  ProjectWorkflow,
  ProjectWorkflowStatus,
  ProjectWorkTask,
  WorkConsultation,
  WorkDeliverable,
  WorkEvent,
  WorkPlan,
  WorkPlanPayload,
  WorkConsultationStatus,
  WorkTaskStatus,
} from '../shared/project-work.js';

const transitions: Record<WorkTaskStatus, WorkTaskStatus[]> = {
  pending: ['ready', 'blocked', 'cancelled'],
  ready: ['running', 'blocked', 'cancelled'],
  running: [
    'consulting',
    'delegating',
    'in_review',
    'blocked',
    'failed',
    'interrupted',
    'cancelled',
  ],
  consulting: ['running', 'blocked', 'failed', 'interrupted', 'cancelled'],
  delegating: ['running', 'blocked', 'failed', 'cancelled'],
  in_review: ['completed', 'changes_requested', 'blocked', 'cancelled'],
  changes_requested: ['ready', 'blocked', 'cancelled'],
  blocked: ['ready', 'cancelled'],
  failed: ['ready', 'cancelled'],
  interrupted: ['ready', 'blocked', 'cancelled'],
  completed: [],
  cancelled: [],
};

const workflowTransitions: Record<
  ProjectWorkflowStatus,
  ProjectWorkflowStatus[]
> = {
  draft: ['planning', 'cancelled', 'failed'],
  planning: ['awaiting_approval', 'blocked', 'cancelled'],
  awaiting_approval: ['running', 'draft', 'planning', 'blocked', 'cancelled'],
  running: ['paused', 'blocked', 'awaiting_final_acceptance', 'cancelled'],
  paused: ['running', 'blocked', 'cancelled'],
  blocked: ['planning', 'running', 'failed', 'cancelled'],
  awaiting_final_acceptance: ['completed', 'blocked', 'cancelled'],
  completed: [],
  cancelled: [],
  failed: ['planning', 'cancelled'],
};

function decodeJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

export class ProjectWorkStore {
  constructor(
    private db: DatabaseSync,
    private canAssign: (
      masterSessionId: string,
      sessionAgentId: string,
    ) => boolean,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_workflows(
        masterSessionId TEXT PRIMARY KEY REFERENCES master_sessions(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT 'draft', activePlanId TEXT,
        coordinatorSessionAgentId TEXT, error TEXT,
        planningMessageId TEXT, finalReport TEXT, finalReportExecutionId TEXT,
        activationCount INTEGER NOT NULL DEFAULT 0,
        maxTasks INTEGER NOT NULL DEFAULT 40, maxActivations INTEGER NOT NULL DEFAULT 100,
        maxConsultationsPerTask INTEGER NOT NULL DEFAULT 3,
        maxDelegationDepth INTEGER NOT NULL DEFAULT 1,
        maxRetries INTEGER NOT NULL DEFAULT 2,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_goals(
        id TEXT PRIMARY KEY, masterSessionId TEXT NOT NULL REFERENCES master_sessions(id) ON DELETE RESTRICT,
        title TEXT NOT NULL, description TEXT NOT NULL, expectedOutcome TEXT NOT NULL,
        completionCriteria TEXT NOT NULL, priority INTEGER NOT NULL,
        status TEXT NOT NULL, createdBy TEXT NOT NULL, assigneeSessionAgentId TEXT,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_goals_master_idx ON project_goals(masterSessionId,status,priority);
      CREATE TABLE IF NOT EXISTS project_work_plans(
        id TEXT PRIMARY KEY, masterSessionId TEXT NOT NULL REFERENCES master_sessions(id) ON DELETE RESTRICT,
        version INTEGER NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
        definitionOfDone TEXT NOT NULL, tasks TEXT NOT NULL,
        coordinatorSessionAgentId TEXT NOT NULL, sourceConversationId TEXT NOT NULL,
        sourceMessageId TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        UNIQUE(masterSessionId,version)
      );
      CREATE TABLE IF NOT EXISTS project_work_tasks(
        id TEXT PRIMARY KEY, masterSessionId TEXT NOT NULL REFERENCES master_sessions(id) ON DELETE RESTRICT,
        goalId TEXT NOT NULL REFERENCES project_goals(id) ON DELETE RESTRICT,
        planId TEXT NOT NULL REFERENCES project_work_plans(id) ON DELETE RESTRICT,
        planVersion INTEGER NOT NULL, taskKey TEXT NOT NULL, parentTaskId TEXT REFERENCES project_work_tasks(id),
        depth INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, description TEXT NOT NULL,
        assigneeSessionAgentId TEXT NOT NULL REFERENCES session_agents(id) ON DELETE RESTRICT,
        reviewerSessionAgentId TEXT REFERENCES session_agents(id) ON DELETE RESTRICT,
        priority INTEGER NOT NULL, dependsOn TEXT NOT NULL, acceptanceCriteria TEXT NOT NULL,
        deliverables TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'work', attempts INTEGER NOT NULL DEFAULT 0,
        maxAttempts INTEGER NOT NULL DEFAULT 3, executionId TEXT, triggerMessageId TEXT,
        currentRequestKey TEXT, currentMode TEXT,
        leaseId TEXT, leaseUntil INTEGER, error TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        UNIQUE(planId,taskKey)
      );
      CREATE INDEX IF NOT EXISTS project_work_tasks_schedule_idx ON project_work_tasks(masterSessionId,status,priority,createdAt);
      CREATE INDEX IF NOT EXISTS project_work_tasks_execution_idx ON project_work_tasks(executionId);
      CREATE TABLE IF NOT EXISTS project_work_deliverables(
        id TEXT PRIMARY KEY, masterSessionId TEXT NOT NULL REFERENCES master_sessions(id) ON DELETE RESTRICT,
        taskId TEXT NOT NULL REFERENCES project_work_tasks(id) ON DELETE RESTRICT,
        pageId TEXT NOT NULL, sessionAgentId TEXT NOT NULL REFERENCES session_agents(id) ON DELETE RESTRICT,
        type TEXT NOT NULL, title TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
        sourceExecutionId TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        UNIQUE(taskId,version), UNIQUE(pageId)
      );
      CREATE TABLE IF NOT EXISTS project_work_consultations(
        id TEXT PRIMARY KEY, masterSessionId TEXT NOT NULL REFERENCES master_sessions(id) ON DELETE RESTRICT,
        taskId TEXT NOT NULL REFERENCES project_work_tasks(id) ON DELETE RESTRICT,
        requesterSessionAgentId TEXT NOT NULL REFERENCES session_agents(id) ON DELETE RESTRICT,
        recipientSessionAgentId TEXT NOT NULL REFERENCES session_agents(id) ON DELETE RESTRICT,
        question TEXT NOT NULL, status TEXT NOT NULL, executionId TEXT,
        answer TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_work_consultations_task_idx ON project_work_consultations(taskId,createdAt);
      CREATE TABLE IF NOT EXISTS project_work_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, masterSessionId TEXT NOT NULL REFERENCES master_sessions(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL, actorType TEXT NOT NULL, actorId TEXT NOT NULL,
        taskId TEXT, deliverableId TEXT, executionId TEXT, value TEXT NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_work_events_master_idx ON project_work_events(masterSessionId,id);
    `);
    for (const [table, column, definition] of [
      ['project_workflows', 'planningMessageId', 'TEXT'],
      ['project_workflows', 'finalReport', 'TEXT'],
      ['project_workflows', 'finalReportExecutionId', 'TEXT'],
      ['project_workflows', 'activationCount', 'INTEGER NOT NULL DEFAULT 0'],
      ['project_work_tasks', 'stage', "TEXT NOT NULL DEFAULT 'work'"],
      ['project_work_tasks', 'currentRequestKey', 'TEXT'],
      ['project_work_tasks', 'currentMode', 'TEXT'],
    ]) {
      if (
        !db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((field) => field.name === column)
      )
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  ensureWorkflow(masterSessionId: string): ProjectWorkflow {
    const now = Date.now();
    this.db
      .prepare(
        'INSERT OR IGNORE INTO project_workflows(masterSessionId,createdAt,updatedAt) VALUES (?,?,?)',
      )
      .run(masterSessionId, now, now);
    return this.workflow(masterSessionId)!;
  }

  workflow(masterSessionId: string): ProjectWorkflow | undefined {
    return this.db
      .prepare('SELECT * FROM project_workflows WHERE masterSessionId=?')
      .get(masterSessionId) as unknown as ProjectWorkflow | undefined;
  }

  canAssignAgentForProject(masterSessionId: string, sessionAgentId: string) {
    return this.canAssign(masterSessionId, sessionAgentId);
  }

  workflows(statuses?: ProjectWorkflowStatus[]): ProjectWorkflow[] {
    if (statuses?.length) {
      const placeholders = statuses.map(() => '?').join(',');
      return this.db
        .prepare(
          `SELECT * FROM project_workflows WHERE status IN (${placeholders}) ORDER BY updatedAt`,
        )
        .all(...statuses) as unknown as ProjectWorkflow[];
    }
    return this.db
      .prepare('SELECT * FROM project_workflows ORDER BY updatedAt')
      .all() as unknown as ProjectWorkflow[];
  }

  consumeActivation(masterSessionId: string): boolean {
    return (
      this.db
        .prepare(
          'UPDATE project_workflows SET activationCount=activationCount+1,updatedAt=? WHERE masterSessionId=? AND activationCount<maxActivations',
        )
        .run(Date.now(), masterSessionId).changes > 0
    );
  }

  refundActivation(masterSessionId: string) {
    this.db
      .prepare(
        'UPDATE project_workflows SET activationCount=MAX(0,activationCount-1),updatedAt=? WHERE masterSessionId=?',
      )
      .run(Date.now(), masterSessionId);
  }

  acceptFinalDelivery(masterSessionId: string) {
    const workflow = this.workflow(masterSessionId);
    if (workflow?.status !== 'awaiting_final_acceptance')
      throw new Error('This project is not awaiting final acceptance.');
    return this.transaction(() => {
      this.db
        .prepare(
          "UPDATE project_workflows SET status='completed',error=NULL,updatedAt=? WHERE masterSessionId=?",
        )
        .run(Date.now(), masterSessionId);
      this.db
        .prepare(
          "UPDATE project_goals SET status='completed',updatedAt=? WHERE masterSessionId=? AND status IN ('active','blocked')",
        )
        .run(Date.now(), masterSessionId);
      this.db
        .prepare(
          "UPDATE project_work_deliverables SET status='accepted',updatedAt=? WHERE masterSessionId=? AND status='approved'",
        )
        .run(Date.now(), masterSessionId);
      this.event(
        masterSessionId,
        'final_delivery_accepted',
        'user',
        'owner',
        {},
      );
      return this.workflow(masterSessionId)!;
    });
  }

  requestFinalChanges(masterSessionId: string, feedback: string) {
    const workflow = this.workflow(masterSessionId);
    if (workflow?.status !== 'awaiting_final_acceptance')
      throw new Error('This project is not awaiting final acceptance.');
    this.transaction(() => {
      this.event(
        masterSessionId,
        'final_delivery_changes_requested',
        'user',
        'owner',
        { feedback },
      );
      this.db
        .prepare(
          "UPDATE project_goals SET status='active',updatedAt=? WHERE masterSessionId=? AND status='completed'",
        )
        .run(Date.now(), masterSessionId);
      this.setWorkflow(masterSessionId, 'blocked', { error: feedback });
    });
    return this.workflow(masterSessionId)!;
  }

  markGoalsBlocked(masterSessionId: string, blocked: boolean) {
    this.db
      .prepare(
        'UPDATE project_goals SET status=?,updatedAt=? WHERE masterSessionId=? AND status=?',
      )
      .run(
        blocked ? 'blocked' : 'active',
        Date.now(),
        masterSessionId,
        blocked ? 'active' : 'blocked',
      );
  }

  cancelPendingTasks(masterSessionId: string) {
    const ids = this.db
      .prepare(
        "SELECT id FROM project_work_tasks WHERE masterSessionId=? AND status IN ('pending','ready','changes_requested')",
      )
      .all(masterSessionId) as Array<{ id: string }>;
    for (const { id } of ids) this.setTaskState(id, 'cancelled');
    return ids.map(({ id }) => id);
  }

  saveFinalReport(
    masterSessionId: string,
    report: string,
    executionId: string | null = null,
  ) {
    this.db
      .prepare(
        "UPDATE project_workflows SET finalReport=?,finalReportExecutionId=?,status='awaiting_final_acceptance',error=NULL,updatedAt=? WHERE masterSessionId=?",
      )
      .run(report.slice(0, 20000), executionId, Date.now(), masterSessionId);
    this.event(
      masterSessionId,
      'final_report_prepared',
      'system',
      'work-engine',
      {
        executionId,
      },
      undefined,
      undefined,
      executionId ?? undefined,
    );
    return this.workflow(masterSessionId)!;
  }

  refreshReadyDependencies(masterSessionId: string) {
    const changed: ProjectWorkTask[] = [];
    const activePlanId = this.workflow(masterSessionId)?.activePlanId;
    if (!activePlanId) return changed;
    for (const task of this.tasks(masterSessionId).filter(
      (item) => item.planId === activePlanId,
    )) {
      if (
        task.status === 'pending' &&
        task.dependsOn.every((id) => this.task(id)?.status === 'completed') &&
        this.canAssign(masterSessionId, task.assigneeSessionAgentId)
      ) {
        this.db
          .prepare(
            "UPDATE project_work_tasks SET status='ready',updatedAt=? WHERE id=? AND status='pending'",
          )
          .run(Date.now(), task.id);
        changed.push(this.task(task.id)!);
        this.event(
          masterSessionId,
          'task_ready',
          'system',
          'work-engine',
          {
            taskId: task.id,
          },
          task.id,
        );
      }
    }
    return changed;
  }

  setTaskStage(id: string, stage: 'work' | 'review') {
    this.db
      .prepare('UPDATE project_work_tasks SET stage=?,updatedAt=? WHERE id=?')
      .run(stage, Date.now(), id);
    return this.task(id)!;
  }

  setWorkflow(
    masterSessionId: string,
    status: ProjectWorkflowStatus,
    patch: Partial<
      Pick<
        ProjectWorkflow,
        | 'activePlanId'
        | 'coordinatorSessionAgentId'
        | 'error'
        | 'planningMessageId'
        | 'finalReport'
        | 'finalReportExecutionId'
      >
    > = {},
  ) {
    this.ensureWorkflow(masterSessionId);
    const current = this.workflow(masterSessionId)!;
    if (
      current.status !== status &&
      !workflowTransitions[current.status].includes(status)
    )
      throw new Error(
        `Invalid project workflow transition: ${current.status} → ${status}.`,
      );
    this.db
      .prepare(
        'UPDATE project_workflows SET status=?,activePlanId=?,coordinatorSessionAgentId=?,error=?,planningMessageId=?,finalReport=?,finalReportExecutionId=?,updatedAt=? WHERE masterSessionId=?',
      )
      .run(
        status,
        patch.activePlanId === undefined
          ? current.activePlanId
          : patch.activePlanId,
        patch.coordinatorSessionAgentId === undefined
          ? current.coordinatorSessionAgentId
          : patch.coordinatorSessionAgentId,
        patch.error === undefined ? null : patch.error,
        patch.planningMessageId === undefined
          ? current.planningMessageId
          : patch.planningMessageId,
        patch.finalReport === undefined
          ? current.finalReport
          : patch.finalReport,
        patch.finalReportExecutionId === undefined
          ? current.finalReportExecutionId
          : patch.finalReportExecutionId,
        Date.now(),
        masterSessionId,
      );
    return this.workflow(masterSessionId)!;
  }

  goals(masterSessionId: string): ProjectGoal[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM project_goals WHERE masterSessionId=? ORDER BY priority DESC,createdAt,id',
        )
        .all(masterSessionId) as Array<Record<string, unknown>>
    ).map(
      (row) =>
        ({
          ...row,
          completionCriteria: decodeJson<string[]>(row.completionCriteria),
        }) as unknown as ProjectGoal,
    );
  }

  goal(id: string): ProjectGoal | undefined {
    const row = this.db
      .prepare('SELECT * FROM project_goals WHERE id=?')
      .get(id) as Record<string, unknown> | undefined;
    return row
      ? ({
          ...row,
          completionCriteria: decodeJson<string[]>(row.completionCriteria),
        } as unknown as ProjectGoal)
      : undefined;
  }

  saveGoal(
    masterSessionId: string,
    input: {
      title: string;
      description: string;
      expectedOutcome: string;
      completionCriteria: string[];
      priority: number;
      assigneeSessionAgentId: string | null;
    },
    actorId: string,
    id?: string,
  ) {
    const now = Date.now();
    if (id) {
      const existing = this.goal(id);
      if (!existing || existing.masterSessionId !== masterSessionId)
        throw new Error('Project goal not found.');
      this.db
        .prepare(
          'UPDATE project_goals SET title=?,description=?,expectedOutcome=?,completionCriteria=?,priority=?,assigneeSessionAgentId=?,updatedAt=? WHERE id=?',
        )
        .run(
          input.title,
          input.description,
          input.expectedOutcome,
          JSON.stringify(input.completionCriteria),
          input.priority,
          input.assigneeSessionAgentId,
          now,
          id,
        );
      return this.goal(id)!;
    }
    const goalId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO project_goals(id,masterSessionId,title,description,expectedOutcome,completionCriteria,priority,status,createdBy,assigneeSessionAgentId,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,'draft',?,?,?,?)",
      )
      .run(
        goalId,
        masterSessionId,
        input.title,
        input.description,
        input.expectedOutcome,
        JSON.stringify(input.completionCriteria),
        input.priority,
        actorId,
        input.assigneeSessionAgentId,
        now,
        now,
      );
    return this.goal(goalId)!;
  }

  setGoalStatus(id: string, status: ProjectGoalStatus) {
    this.db
      .prepare('UPDATE project_goals SET status=?,updatedAt=? WHERE id=?')
      .run(status, Date.now(), id);
    return this.goal(id);
  }

  plans(masterSessionId: string): WorkPlan[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM project_work_plans WHERE masterSessionId=? ORDER BY version DESC',
        )
        .all(masterSessionId) as Array<Record<string, unknown>>
    ).map((row) => this.planFromRow(row));
  }

  plan(id: string): WorkPlan | undefined {
    const row = this.db
      .prepare('SELECT * FROM project_work_plans WHERE id=?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.planFromRow(row) : undefined;
  }

  private planFromRow(row: Record<string, unknown>): WorkPlan {
    return {
      ...row,
      definitionOfDone: decodeJson<string[]>(row.definitionOfDone),
      tasks: decodeJson<WorkPlanPayload['tasks']>(row.tasks),
    } as unknown as WorkPlan;
  }

  saveProposal(input: {
    masterSessionId: string;
    payload: WorkPlanPayload;
    coordinatorSessionAgentId: string;
    sourceConversationId: string;
    sourceMessageId: string;
  }): WorkPlan {
    const version =
      (
        this.db
          .prepare(
            'SELECT MAX(version) AS version FROM project_work_plans WHERE masterSessionId=?',
          )
          .get(input.masterSessionId) as { version: number | null }
      ).version ?? 0;
    this.db
      .prepare(
        "UPDATE project_work_plans SET status='superseded',updatedAt=? WHERE masterSessionId=? AND status='proposed'",
      )
      .run(Date.now(), input.masterSessionId);
    const plan: WorkPlan = {
      id: randomUUID(),
      masterSessionId: input.masterSessionId,
      version: version + 1,
      status: 'proposed',
      ...input.payload,
      coordinatorSessionAgentId: input.coordinatorSessionAgentId,
      sourceConversationId: input.sourceConversationId,
      sourceMessageId: input.sourceMessageId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO project_work_plans(id,masterSessionId,version,status,title,summary,definitionOfDone,tasks,coordinatorSessionAgentId,sourceConversationId,sourceMessageId,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        plan.id,
        plan.masterSessionId,
        plan.version,
        plan.status,
        plan.title,
        plan.summary,
        JSON.stringify(plan.definitionOfDone),
        JSON.stringify(plan.tasks),
        plan.coordinatorSessionAgentId,
        plan.sourceConversationId,
        plan.sourceMessageId,
        plan.createdAt,
        plan.updatedAt,
      );
    return plan;
  }

  updateProposal(planId: string, payload: WorkPlanPayload) {
    const plan = this.plan(planId);
    if (!plan || plan.status !== 'proposed')
      throw new Error('Only a proposed work plan can be edited.');
    this.db
      .prepare(
        'UPDATE project_work_plans SET title=?,summary=?,definitionOfDone=?,tasks=?,updatedAt=? WHERE id=?',
      )
      .run(
        payload.title,
        payload.summary,
        JSON.stringify(payload.definitionOfDone),
        JSON.stringify(payload.tasks),
        Date.now(),
        planId,
      );
    return this.plan(planId)!;
  }

  approvePlan(planId: string) {
    const plan = this.plan(planId);
    if (!plan || plan.status !== 'proposed')
      throw new Error('Work plan is no longer awaiting approval.');
    const workflow = this.workflow(plan.masterSessionId);
    if (
      workflow?.status !== 'awaiting_approval' ||
      workflow.activePlanId !== planId
    )
      throw new Error('This is not the active work plan proposal.');
    const goals = new Set(
      this.goals(plan.masterSessionId).map((goal) => goal.id),
    );
    if (plan.tasks.length > workflow.maxTasks)
      throw new Error(`Work plan exceeds the ${workflow.maxTasks} task limit.`);
    for (const task of plan.tasks) {
      if (!goals.has(task.goalId))
        throw new Error('Task references an unknown project goal.');
      if (!this.canAssign(plan.masterSessionId, task.assigneeSessionAgentId))
        throw new Error(
          'A task assignee is no longer an active authorized collaborator.',
        );
      if (
        task.reviewerSessionAgentId &&
        !this.canAssign(plan.masterSessionId, task.reviewerSessionAgentId)
      )
        throw new Error(
          'A task reviewer is no longer an active authorized collaborator.',
        );
    }
    return this.transaction(() => {
      this.db
        .prepare(
          "UPDATE project_work_plans SET status='approved',updatedAt=? WHERE id=? AND status='proposed'",
        )
        .run(Date.now(), planId);
      const idsByKey = new Map(
        plan.tasks.map((task) => [task.key, randomUUID()]),
      );
      const now = Date.now();
      for (const task of plan.tasks) {
        const dependencies = task.dependsOn.map((key) => {
          const dependencyId = idsByKey.get(key);
          if (!dependencyId) throw new Error(`Unknown dependency key: ${key}`);
          return dependencyId;
        });
        this.insertTask({
          ...task,
          id: idsByKey.get(task.key)!,
          masterSessionId: plan.masterSessionId,
          planId: plan.id,
          planVersion: plan.version,
          taskKey: task.key,
          parentTaskId: null,
          depth: 0,
          dependsOn: dependencies,
          status: dependencies.length ? 'pending' : 'ready',
          stage: 'work',
          attempts: 0,
          maxAttempts: workflow.maxRetries + 1,
          executionId: null,
          triggerMessageId: null,
          currentRequestKey: null,
          currentMode: null,
          leaseId: null,
          leaseUntil: null,
          error: null,
          createdAt: now,
          updatedAt: now,
        });
      }
      this.db
        .prepare(
          "UPDATE project_goals SET status='active',updatedAt=? WHERE masterSessionId=? AND status='draft'",
        )
        .run(now, plan.masterSessionId);
      this.setWorkflow(plan.masterSessionId, 'running', { error: null });
      this.event(plan.masterSessionId, 'plan_approved', 'user', 'owner', {
        planId,
        planVersion: plan.version,
      });
      return this.plan(planId)!;
    });
  }

  private insertTask(task: ProjectWorkTask) {
    const columns = [
      'id',
      'masterSessionId',
      'goalId',
      'planId',
      'planVersion',
      'taskKey',
      'parentTaskId',
      'depth',
      'title',
      'description',
      'assigneeSessionAgentId',
      'reviewerSessionAgentId',
      'priority',
      'dependsOn',
      'acceptanceCriteria',
      'deliverables',
      'status',
      'attempts',
      'maxAttempts',
      'executionId',
      'triggerMessageId',
      'currentRequestKey',
      'currentMode',
      'leaseId',
      'leaseUntil',
      'error',
      'createdAt',
      'updatedAt',
    ];
    const values: unknown[] = [
      task.id,
      task.masterSessionId,
      task.goalId,
      task.planId,
      task.planVersion,
      task.taskKey,
      task.parentTaskId,
      task.depth,
      task.title,
      task.description,
      task.assigneeSessionAgentId,
      task.reviewerSessionAgentId,
      task.priority,
      JSON.stringify(task.dependsOn),
      JSON.stringify(task.acceptanceCriteria),
      JSON.stringify(task.deliverables),
      task.status,
      task.attempts,
      task.maxAttempts,
      task.executionId,
      task.triggerMessageId,
      task.currentRequestKey,
      task.currentMode,
      task.leaseId,
      task.leaseUntil,
      task.error,
      task.createdAt,
      task.updatedAt,
    ];
    this.db
      .prepare(
        `INSERT INTO project_work_tasks(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      )
      .run(...(values as SQLInputValue[]));
  }

  rejectPlan(planId: string) {
    const plan = this.plan(planId);
    if (!plan || plan.status !== 'proposed')
      throw new Error('Work plan is no longer awaiting approval.');
    this.db
      .prepare(
        "UPDATE project_work_plans SET status='rejected',updatedAt=? WHERE id=?",
      )
      .run(Date.now(), planId);
    this.setWorkflow(plan.masterSessionId, 'draft', {
      activePlanId: null,
      error: null,
    });
    return this.plan(planId)!;
  }

  tasks(masterSessionId: string): ProjectWorkTask[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM project_work_tasks WHERE masterSessionId=? ORDER BY priority DESC,createdAt,id',
        )
        .all(masterSessionId) as Array<Record<string, unknown>>
    ).map((row) => this.taskFromRow(row));
  }

  task(id: string): ProjectWorkTask | undefined {
    const row = this.db
      .prepare('SELECT * FROM project_work_tasks WHERE id=?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.taskFromRow(row) : undefined;
  }

  private taskFromRow(row: Record<string, unknown>): ProjectWorkTask {
    return {
      ...row,
      dependsOn: decodeJson<string[]>(row.dependsOn),
      acceptanceCriteria: decodeJson<string[]>(row.acceptanceCriteria),
      deliverables: decodeJson<
        WorkPlanPayload['tasks'][number]['deliverables']
      >(row.deliverables),
    } as unknown as ProjectWorkTask;
  }

  claimReady(
    masterSessionId: string,
    leaseMs = 30000,
  ): ProjectWorkTask | undefined {
    const workflow = this.workflow(masterSessionId);
    if (workflow?.status !== 'running' || !workflow.activePlanId)
      return undefined;
    const now = Date.now();
    const candidates = this.tasks(masterSessionId).filter(
      (task) =>
        task.planId === workflow.activePlanId && task.status === 'ready',
    );
    for (const task of candidates) {
      if (task.dependsOn.some((id) => this.task(id)?.status !== 'completed'))
        continue;
      if (!this.canAssign(masterSessionId, task.assigneeSessionAgentId)) {
        this.transitionTask(task.id, 'blocked', {
          error: 'Assigned collaborator is no longer active or authorized.',
        });
        continue;
      }
      const leaseId = randomUUID();
      const claimed = this.db
        .prepare(
          "UPDATE project_work_tasks SET status='running',stage='work',attempts=attempts+1,executionId=NULL,triggerMessageId=NULL,currentRequestKey=NULL,currentMode=NULL,leaseId=?,leaseUntil=?,updatedAt=? WHERE id=? AND status='ready' RETURNING id",
        )
        .get(leaseId, now + leaseMs, now, task.id);
      if (!claimed) continue;
      this.event(
        masterSessionId,
        'task_started',
        'system',
        'work-engine',
        {
          taskId: task.id,
          attempt: task.attempts + 1,
        },
        task.id,
      );
      return this.task(task.id);
    }
    return undefined;
  }

  attachExecution(taskId: string, messageId: string, executionId: string) {
    this.db
      .prepare(
        'UPDATE project_work_tasks SET triggerMessageId=?,executionId=?,updatedAt=? WHERE id=?',
      )
      .run(messageId, executionId, Date.now(), taskId);
    const task = this.task(taskId)!;
    this.event(
      task.masterSessionId,
      'task_execution_queued',
      'system',
      'work-engine',
      {
        taskId,
        messageId,
        executionId,
      },
      taskId,
      undefined,
      executionId,
    );
  }

  setTaskRequest(
    taskId: string,
    key: string,
    mode: 'begin' | 'continue' | 'review',
  ) {
    this.db
      .prepare(
        'UPDATE project_work_tasks SET currentRequestKey=?,currentMode=?,updatedAt=? WHERE id=?',
      )
      .run(key, mode, Date.now(), taskId);
  }

  setTaskState(
    id: string,
    status: WorkTaskStatus,
    options: { error?: string | null; clearExecution?: boolean } = {},
  ) {
    const task = this.task(id);
    if (!task) throw new Error('Project task not found.');
    if (task.status !== status && !transitions[task.status].includes(status))
      throw new Error(
        `Invalid project task transition: ${task.status} → ${status}.`,
      );
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE project_work_tasks SET status=?,error=?,executionId=?,triggerMessageId=?,leaseId=?,leaseUntil=?,updatedAt=? WHERE id=?',
      )
      .run(
        status,
        options.error === undefined ? task.error : options.error,
        options.clearExecution ? null : task.executionId,
        options.clearExecution ? null : task.triggerMessageId,
        ['running', 'consulting', 'delegating'].includes(status)
          ? task.leaseId
          : null,
        ['running', 'consulting', 'delegating'].includes(status)
          ? task.leaseUntil
          : null,
        now,
        id,
      );
    if (options.clearExecution)
      this.db
        .prepare(
          'UPDATE project_work_tasks SET currentRequestKey=NULL,currentMode=NULL WHERE id=?',
        )
        .run(id);
    return this.task(id)!;
  }

  transitionTask(
    id: string,
    status: WorkTaskStatus,
    options: { error?: string | null } = {},
  ) {
    return this.setTaskState(id, status, options);
  }

  updateAssignee(id: string, agentId: string) {
    const task = this.task(id);
    if (
      !task ||
      !['ready', 'blocked', 'failed', 'interrupted'].includes(task.status)
    )
      throw new Error(
        'Only a ready, blocked, failed, or interrupted task can be reassigned.',
      );
    if (!this.canAssign(task.masterSessionId, agentId))
      throw new Error(
        'Choose an active collaborator authorized for this project.',
      );
    this.db
      .prepare(
        'UPDATE project_work_tasks SET assigneeSessionAgentId=?,updatedAt=? WHERE id=?',
      )
      .run(agentId, Date.now(), id);
    this.event(
      task.masterSessionId,
      'task_reassigned',
      'user',
      'owner',
      {
        taskId: id,
        assigneeSessionAgentId: agentId,
      },
      id,
    );
    return this.task(id)!;
  }

  updatePriority(id: string, priority: number) {
    const task = this.task(id);
    if (!task || ['completed', 'cancelled'].includes(task.status))
      throw new Error('This task priority can no longer be changed.');
    this.db
      .prepare(
        'UPDATE project_work_tasks SET priority=?,updatedAt=? WHERE id=?',
      )
      .run(priority, Date.now(), id);
    this.event(
      task.masterSessionId,
      'task_priority_changed',
      'user',
      'owner',
      {
        taskId: id,
        priority,
      },
      id,
    );
    return this.task(id)!;
  }

  saveConsultation(
    input: Omit<
      WorkConsultation,
      'id' | 'status' | 'executionId' | 'answer' | 'createdAt' | 'updatedAt'
    >,
  ) {
    const consultation: WorkConsultation = {
      ...input,
      id: randomUUID(),
      status: 'queued',
      executionId: null,
      answer: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO project_work_consultations(id,masterSessionId,taskId,requesterSessionAgentId,recipientSessionAgentId,question,status,executionId,answer,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?)',
      )
      .run(
        consultation.id,
        consultation.masterSessionId,
        consultation.taskId,
        consultation.requesterSessionAgentId,
        consultation.recipientSessionAgentId,
        consultation.question,
        consultation.status,
        consultation.createdAt,
        consultation.updatedAt,
      );
    this.event(
      consultation.masterSessionId,
      'consultation_requested',
      'session_agent',
      consultation.requesterSessionAgentId,
      {
        consultationId: consultation.id,
        recipientSessionAgentId: consultation.recipientSessionAgentId,
        question: consultation.question,
      },
      consultation.taskId,
    );
    return consultation;
  }

  consultations(masterSessionId: string): WorkConsultation[] {
    return this.db
      .prepare(
        'SELECT * FROM project_work_consultations WHERE masterSessionId=? ORDER BY createdAt,id',
      )
      .all(masterSessionId) as unknown as WorkConsultation[];
  }

  consultation(id: string): WorkConsultation | undefined {
    return this.db
      .prepare('SELECT * FROM project_work_consultations WHERE id=?')
      .get(id) as unknown as WorkConsultation | undefined;
  }

  updateConsultation(
    id: string,
    status: WorkConsultationStatus,
    patch: { executionId?: string | null; answer?: string | null } = {},
  ) {
    const current = this.consultation(id);
    if (!current) throw new Error('Work consultation not found.');
    this.db
      .prepare(
        'UPDATE project_work_consultations SET status=?,executionId=?,answer=?,updatedAt=? WHERE id=?',
      )
      .run(
        status,
        patch.executionId === undefined
          ? current.executionId
          : patch.executionId,
        patch.answer === undefined ? current.answer : patch.answer,
        Date.now(),
        id,
      );
    return this.consultation(id)!;
  }

  addDelegatedTask(input: {
    parent: ProjectWorkTask;
    title: string;
    description: string;
    assigneeSessionAgentId: string;
    acceptanceCriteria: string[];
    deliverableTitle: string;
    maxTasks: number;
    maxDelegationDepth: number;
  }) {
    const count = this.tasks(input.parent.masterSessionId).length;
    if (count >= input.maxTasks)
      throw new Error('The project task limit has been reached.');
    if (input.parent.depth >= input.maxDelegationDepth)
      throw new Error('Delegation depth limit has been reached.');
    if (
      !this.canAssign(
        input.parent.masterSessionId,
        input.assigneeSessionAgentId,
      )
    )
      throw new Error(
        'Choose an active collaborator authorized for this project.',
      );
    const id = randomUUID();
    const now = Date.now();
    const task: ProjectWorkTask = {
      ...input.parent,
      id,
      taskKey: `delegate-${id.slice(0, 8)}`,
      parentTaskId: input.parent.id,
      depth: input.parent.depth + 1,
      title: input.title,
      description: input.description,
      assigneeSessionAgentId: input.assigneeSessionAgentId,
      priority: input.parent.priority,
      dependsOn: [...input.parent.dependsOn],
      acceptanceCriteria: input.acceptanceCriteria,
      deliverables: [{ title: input.deliverableTitle, type: 'page' }],
      status: input.parent.dependsOn.some(
        (dependency) => this.task(dependency)?.status !== 'completed',
      )
        ? 'pending'
        : 'ready',
      attempts: 0,
      maxAttempts: input.parent.maxAttempts,
      executionId: null,
      triggerMessageId: null,
      leaseId: null,
      leaseUntil: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.insertTask(task);
    this.event(
      task.masterSessionId,
      'task_delegated',
      'session_agent',
      input.parent.assigneeSessionAgentId,
      {
        taskId: id,
        parentTaskId: input.parent.id,
        assigneeSessionAgentId: input.assigneeSessionAgentId,
        title: input.title,
      },
      id,
    );
    return this.task(id)!;
  }

  saveDeliverable(
    input: Omit<WorkDeliverable, 'id' | 'createdAt' | 'updatedAt'>,
  ) {
    const previous = this.db
      .prepare(
        'SELECT * FROM project_work_deliverables WHERE taskId=? AND version=?',
      )
      .get(input.taskId, input.version) as WorkDeliverable | undefined;
    if (previous) {
      if (
        previous.pageId !== input.pageId ||
        previous.sourceExecutionId !== input.sourceExecutionId
      )
        throw new Error(
          'This task attempt already has a different saved deliverable.',
        );
      return previous;
    }
    const deliverable: WorkDeliverable = {
      ...input,
      id: randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO project_work_deliverables(id,masterSessionId,taskId,pageId,sessionAgentId,type,title,version,status,sourceExecutionId,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        deliverable.id,
        deliverable.masterSessionId,
        deliverable.taskId,
        deliverable.pageId,
        deliverable.sessionAgentId,
        deliverable.type,
        deliverable.title,
        deliverable.version,
        deliverable.status,
        deliverable.sourceExecutionId,
        deliverable.createdAt,
        deliverable.updatedAt,
      );
    return deliverable;
  }

  deliverable(id: string): WorkDeliverable | undefined {
    return this.db
      .prepare('SELECT * FROM project_work_deliverables WHERE id=?')
      .get(id) as unknown as WorkDeliverable | undefined;
  }

  deliverables(masterSessionId: string): WorkDeliverable[] {
    return this.db
      .prepare(
        'SELECT * FROM project_work_deliverables WHERE masterSessionId=? ORDER BY createdAt,id',
      )
      .all(masterSessionId) as unknown as WorkDeliverable[];
  }

  updateDeliverableStatus(id: string, status: WorkDeliverable['status']) {
    this.db
      .prepare(
        'UPDATE project_work_deliverables SET status=?,updatedAt=? WHERE id=?',
      )
      .run(status, Date.now(), id);
    return this.deliverable(id)!;
  }

  event(
    masterSessionId: string,
    kind: string,
    actorType: WorkEvent['actorType'],
    actorId: string,
    value: Record<string, unknown>,
    taskId?: string,
    deliverableId?: string,
    executionId?: string,
  ) {
    const createdAt = Date.now();
    const result = this.db
      .prepare(
        'INSERT INTO project_work_events(masterSessionId,kind,actorType,actorId,taskId,deliverableId,executionId,value,createdAt) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        masterSessionId,
        kind,
        actorType,
        actorId,
        taskId ?? null,
        deliverableId ?? null,
        executionId ?? null,
        JSON.stringify(value),
        createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  events(masterSessionId: string): WorkEvent[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM project_work_events WHERE masterSessionId=? ORDER BY id DESC LIMIT 500',
        )
        .all(masterSessionId) as Array<Record<string, unknown>>
    ).map(
      (row) =>
        ({
          ...row,
          value: decodeJson<Record<string, unknown>>(row.value),
        }) as unknown as WorkEvent,
    );
  }

  snapshot(masterSessionId: string) {
    return {
      workflow: this.ensureWorkflow(masterSessionId),
      goals: this.goals(masterSessionId),
      plans: this.plans(masterSessionId),
      tasks: this.tasks(masterSessionId),
      deliverables: this.deliverables(masterSessionId),
      consultations: this.consultations(masterSessionId),
      events: this.events(masterSessionId),
    };
  }
}
