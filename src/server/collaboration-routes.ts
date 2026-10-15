import { Hono } from 'hono';
import { z } from 'zod';
import type { CollaborationService } from './collaboration.js';

export const mentionSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('all'), conversationId: z.string().min(1) })
    .strict(),
  z
    .object({
      type: z.literal('agent'),
      conversationId: z.string().min(1),
      sessionAgentId: z.string().min(1),
      dotId: z.string().min(1),
      displayName: z.string().min(1).max(80),
    })
    .strict(),
]);
export function collaborationRoutes(service: CollaborationService) {
  const app = new Hono();
  app.onError((error, c) =>
    c.json(
      { error: error.message },
      /denied|authorized|membership|owners|moderators/.test(error.message)
        ? 403
        : 400,
    ),
  );
  app.get('/:id/collaboration', (c) =>
    c.json(service.state(c.req.param('id'))),
  );
  app.put('/:id/collaboration', async (c) => {
    const data = z
      .object({
        mode: z.enum(['manual', 'hand_raise']),
        maxActivations: z.number().int().min(1).max(8),
        evaluationBudget: z.number().int().min(1).max(4),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(service.settings(c.req.param('id'), data));
  });
  app.post('/:id/hand-raises/evaluate', async (c) => {
    const data = z
      .object({ messageId: z.string().min(1) })
      .strict()
      .parse(await c.req.json());
    service.evaluate(c.req.param('id'), data.messageId);
    return c.json(service.state(c.req.param('id')), 202);
  });
  app.post('/:id/hand-raises/:raiseId/resolve', async (c) => {
    const data = z
      .object({ action: z.enum(['approved', 'dismissed']) })
      .strict()
      .parse(await c.req.json());
    service.resolve(c.req.param('id'), c.req.param('raiseId'), data.action);
    return c.json(service.state(c.req.param('id')), 202);
  });
  app.post('/:id/executions/:executionId/cancel', async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json());
    service.cancel(c.req.param('id'), c.req.param('executionId'));
    return c.json(service.state(c.req.param('id')));
  });
  app.post('/:id/executions/:executionId/publish', async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json());
    return c.json(
      service.retryPublication(c.req.param('id'), c.req.param('executionId')),
    );
  });
  return app;
}
