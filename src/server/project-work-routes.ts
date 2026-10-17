import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ProjectWorkService } from './project-work.js';
import type { Platform } from './platform.js';
import {
  goalInputSchema,
  workPlanPayloadSchema,
} from '../shared/project-work.js';

const respond = (c: Context, error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Project work request failed.';
  const status = message.includes('not found')
    ? 404
    : message.includes('access denied') || message.includes('not authorized')
      ? 403
      : message.includes('already') || message.includes('no longer')
        ? 409
        : 400;
  return c.json({ error: message }, status);
};

export function projectWorkRoutes(
  service: ProjectWorkService,
  platform: Platform,
) {
  const app = new Hono();
  app.get('/master-sessions/:id/work', (c) => {
    try {
      return c.json(service.snapshot(c.req.param('id')));
    } catch (error) {
      return respond(c, error);
    }
  });
  app.post('/master-sessions/:id/work/goals', async (c) => {
    const data = goalInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!data.success)
      return c.json({ error: 'Provide a valid project goal.' }, 400);
    try {
      return c.json(service.saveGoal(c.req.param('id'), data.data), 201);
    } catch (error) {
      return respond(c, error);
    }
  });
  app.put('/master-sessions/:id/work/goals/:goalId', async (c) => {
    const data = goalInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!data.success)
      return c.json({ error: 'Provide a valid project goal.' }, 400);
    try {
      const goal = platform.workspace.projectWork.goal(c.req.param('goalId'));
      if (!goal || goal.masterSessionId !== c.req.param('id'))
        return c.json({ error: 'Project goal not found.' }, 404);
      return c.json(service.saveGoal(c.req.param('id'), data.data, goal.id));
    } catch (error) {
      return respond(c, error);
    }
  });
  app.post('/master-sessions/:id/work/plan', async (c) => {
    const data = z
      .object({ coordinatorSessionAgentId: z.string().min(1) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Choose an active project coordinator.' }, 400);
    try {
      return c.json(
        await service.requestPlan(
          c.req.param('id'),
          data.data.coordinatorSessionAgentId,
        ),
        202,
      );
    } catch (error) {
      return respond(c, error);
    }
  });
  app.put('/master-sessions/:id/work/plans/:planId', async (c) => {
    const data = workPlanPayloadSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!data.success)
      return c.json(
        {
          error: `Provide a complete work plan: ${data.error.issues[0]?.message ?? 'invalid plan'}`,
        },
        400,
      );
    try {
      const plan = platform.workspace.projectWork.plan(c.req.param('planId'));
      if (!plan || plan.masterSessionId !== c.req.param('id'))
        return c.json({ error: 'Work plan proposal not found.' }, 404);
      return c.json(service.updatePlan(plan.id, data.data));
    } catch (error) {
      return respond(c, error);
    }
  });
  app.post('/master-sessions/:id/work/plans/:planId/approve', (c) => {
    try {
      const plan = platform.workspace.projectWork.plan(c.req.param('planId'));
      if (!plan || plan.masterSessionId !== c.req.param('id'))
        return c.json({ error: 'Work plan proposal not found.' }, 404);
      return c.json(service.approvePlan(plan.id), 202);
    } catch (error) {
      return respond(c, error);
    }
  });
  app.post('/master-sessions/:id/work/plans/:planId/reject', (c) => {
    try {
      const plan = platform.workspace.projectWork.plan(c.req.param('planId'));
      if (!plan || plan.masterSessionId !== c.req.param('id'))
        return c.json({ error: 'Work plan proposal not found.' }, 404);
      return c.json(service.rejectPlan(plan.id));
    } catch (error) {
      return respond(c, error);
    }
  });
  app.post('/master-sessions/:id/work/workflow', async (c) => {
    const data = z
      .object({ action: z.enum(['pause', 'resume', 'cancel']) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Choose pause, resume, or cancel.' }, 400);
    try {
      return c.json(
        service.setWorkflowStatus(c.req.param('id'), data.data.action),
      );
    } catch (error) {
      return respond(c, error);
    }
  });
  app.post('/master-sessions/:id/work/tasks/:taskId/retry', (c) => {
    try {
      const task = platform.workspace.projectWork.task(c.req.param('taskId'));
      if (!task || task.masterSessionId !== c.req.param('id'))
        return c.json({ error: 'Project task not found.' }, 404);
      return c.json(service.retryTask(task.id), 202);
    } catch (error) {
      return respond(c, error);
    }
  });
  app.put('/master-sessions/:id/work/tasks/:taskId/assignee', async (c) => {
    const data = z
      .object({ sessionAgentId: z.string().min(1) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Choose an active collaborator.' }, 400);
    try {
      const task = platform.workspace.projectWork.task(c.req.param('taskId'));
      if (!task || task.masterSessionId !== c.req.param('id'))
        return c.json({ error: 'Project task not found.' }, 404);
      return c.json(service.reassignTask(task.id, data.data.sessionAgentId));
    } catch (error) {
      return respond(c, error);
    }
  });
  app.put('/master-sessions/:id/work/tasks/:taskId/priority', async (c) => {
    const data = z
      .object({ priority: z.number().int().min(1).max(5) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Priority must be between 1 and 5.' }, 400);
    try {
      const task = platform.workspace.projectWork.task(c.req.param('taskId'));
      if (!task || task.masterSessionId !== c.req.param('id'))
        return c.json({ error: 'Project task not found.' }, 404);
      return c.json(service.prioritizeTask(task.id, data.data.priority));
    } catch (error) {
      return respond(c, error);
    }
  });
  app.post(
    '/master-sessions/:id/work/deliverables/:deliverableId/review',
    async (c) => {
      const data = z
        .object({
          decision: z.enum(['approved', 'changes_requested']),
          feedback: z.string().max(4000).default(''),
        })
        .strict()
        .safeParse(await c.req.json().catch(() => null));
      if (!data.success)
        return c.json({ error: 'Provide a valid review decision.' }, 400);
      try {
        const deliverable = platform.workspace.projectWork.deliverable(
          c.req.param('deliverableId'),
        );
        if (!deliverable || deliverable.masterSessionId !== c.req.param('id'))
          return c.json({ error: 'Project deliverable not found.' }, 404);
        return c.json(
          service.reviewDeliverable(
            deliverable.id,
            data.data.decision,
            data.data.feedback,
          ),
        );
      } catch (error) {
        return respond(c, error);
      }
    },
  );
  app.get('/master-sessions/:id/work/deliverables/:deliverableId', (c) => {
    const deliverable = platform.workspace.projectWork.deliverable(
      c.req.param('deliverableId'),
    );
    if (!deliverable || deliverable.masterSessionId !== c.req.param('id'))
      return c.json({ error: 'Project deliverable not found.' }, 404);
    const master = platform.workspace.masterSession(
      deliverable.masterSessionId,
    );
    if (!master) return c.json({ error: 'Project not found.' }, 404);
    try {
      return c.json({
        deliverable,
        page: platform.workspace.pages.get(master.spaceId, deliverable.pageId),
      });
    } catch (error) {
      return respond(c, error);
    }
  });
  app.post('/master-sessions/:id/work/final', async (c) => {
    const data = z
      .object({
        decision: z.enum(['accept', 'changes_requested']),
        feedback: z.string().max(4000).default(''),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Provide a valid final delivery decision.' }, 400);
    try {
      return c.json(
        service.finalDecision(
          c.req.param('id'),
          data.data.decision,
          data.data.feedback,
        ),
      );
    } catch (error) {
      return respond(c, error);
    }
  });
  return app;
}
