import { setupInputSchema } from './setup-telemetry.js';
import { collaborationRoutes, mentionSchema } from './collaboration-routes.js';
import { pageRoutes } from './page-routes.js';
import { projectWorkRoutes } from './project-work-routes.js';
import { searchWorkspace } from './search.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Platform } from './platform.js';
import { VoiceService } from './voice.js';
import {
  learningContainerIdSchema,
  validateLearningSettings,
} from '../shared/learning.js';
const masterSessionSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(4000).default(''),
  })
  .strict();
const conversationParticipantIdsSchema = z.array(z.string().min(1)).max(100);
const sessionAgentSchema = z
  .object({
    dotId: z.string().min(1),
    role: z.string().trim().min(1).max(80),
    displayName: z.string().trim().max(80).nullable().optional(),
    mandate: z.string().trim().min(1).max(10000),
    soulOverride: z.string().max(10000).default(''),
  })
  .strict();
function sessionError(c: Context, error: unknown) {
  const message =
    error instanceof Error ? error.message : 'Master Session operation failed.';
  const status = message.includes('not found')
    ? 404
    : message.includes('already') || message.includes('UNIQUE constraint')
      ? 409
      : message.includes('does not have access') ||
          message.includes('does not belong')
        ? 403
        : 400;
  return c.json({ error: message }, status);
}
const dotSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    instructions: z.string().trim().min(3).max(2000),
    researchAllowed: z.boolean(),
    memoryAllowed: z.boolean(),
    appsAllowed: z.boolean().default(false),
    composioToolkits: z
      .array(z.string().regex(/^[a-z0-9_]+$/))
      .max(100)
      .default([]),
    learningContainerId: learningContainerIdSchema.optional(),
    skillDeliveryEnabled: z.boolean().optional(),
    spaceIds: z.array(z.string().min(1)).min(1).max(100).optional(),
    spaceId: z.string().min(1).optional(),
  })
  .strict();
export function workspaceRoutes(platform: Platform, voice: VoiceService) {
  const app = new Hono();
  app.route('/', pageRoutes(platform));
  app.route('/', projectWorkRoutes(platform.projectWork, platform));
  app.post('/setup-telemetry', async (c) => {
    const parsed = setupInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: 'Invalid setup event.' }, 400);
    const event = parsed.data;
    if (
      event.kind === 'step_viewed' &&
      event.step !== 'settings' &&
      event.step !==
        (platform.setup().missing.length ? 'setup_required' : 'ready')
    )
      return c.json({ error: 'Setup step does not match server state.' }, 400);
    platform.setupTelemetry.capture(event);
    return c.json({ ok: true });
  });
  app.get('/workspace', (c) =>
    c.json({
      spaces: platform.workspace.spaces(),
      dots: platform.workspace.dots(),
      conversations: platform.workspace.conversations(),
      masterSessions: platform.workspace.masterSessions(),
      setup: platform.setup(),
      calls: platform.workspace.calls(),
    }),
  );
  app.get('/office/navigation', (c) => {
    try {
      return c.json(
        platform.workspace.officeNavigationSummary(platform.workspace.ownerId),
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.get('/master-sessions', (c) =>
    c.json(platform.workspace.masterSessions()),
  );
  app.get('/office/member-templates', (c) =>
    c.json(platform.workspace.memberTemplates(c.req.query('q') ?? '')),
  );
  app.get('/office/member-templates/:id', (c) => {
    const template = platform.workspace.memberTemplate(c.req.param('id'));
    return template
      ? c.json(template)
      : c.json({ error: 'Member Template not found.' }, 404);
  });
  app.get('/office/team-templates', (c) =>
    c.json(platform.workspace.teamTemplates()),
  );
  app.get('/office/team-templates/:id', (c) => {
    const template = platform.workspace.teamTemplate(c.req.param('id'));
    return template
      ? c.json(template)
      : c.json({ error: 'Team Template not found.' }, 404);
  });
  app.get('/office/dots', (c) => c.json(platform.workspace.dotProfiles()));
  app.put('/office/dots/:id/name', async (c) => {
    const data = z
      .object({ name: z.string().trim().min(1).max(40) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'Provide a valid permanent collaborator name.' },
        400,
      );
    const dot = platform.workspace.dot(c.req.param('id'));
    if (!dot) return c.json({ error: 'Dot not found.' }, 404);
    return c.json(
      platform.workspace.updateDot(dot.id, { ...dot, name: data.data.name }),
    );
  });
  app.get('/office/dots/:id/profile', (c) => {
    try {
      return c.json({
        dot: platform.workspace.dot(c.req.param('id')),
        profile: platform.workspace.dotProfile(c.req.param('id')),
      });
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.put('/office/dots/:id/profile', async (c) => {
    const data = z
      .object({
        summary: z.string().max(2000),
        skills: z.array(z.string().trim().min(1).max(80)).max(30),
        workStyle: z.string().max(2000),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Provide a valid collaborator profile.' }, 400);
    try {
      return c.json(
        platform.workspace.updateDotProfile(c.req.param('id'), data.data),
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.post('/office/dots/from-template', async (c) => {
    const data = z
      .object({
        memberTemplateId: z.string().min(1),
        name: z.string().trim().min(1).max(40),
        customization: z.string().max(1200).default(''),
        agentInstructions: z.string().max(10000).optional(),
        soulInstructions: z.string().max(10000).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'Provide a valid collaborator template and name.' },
        400,
      );
    try {
      return c.json(
        platform.workspace.createDotFromMemberTemplate(data.data),
        201,
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.post('/office/projects', async (c) => {
    const data = z
      .object({
        creationKey: z.string().trim().min(1).max(120),
        name: z.string().trim().min(1).max(120),
        description: z.string().max(4000).default(''),
        team: z
          .array(
            z
              .object({
                id: z.string().min(1).optional(),
                dotId: z.string().min(1).optional(),
                memberTemplateId: z.string().min(1).optional(),
                name: z.string().trim().max(40).optional(),
                customization: z.string().max(1200).optional(),
                agentInstructions: z.string().max(10000).optional(),
                soulInstructions: z.string().max(10000).optional(),
                role: z.string().trim().min(1).max(80),
                mandate: z.string().trim().min(1).max(10000),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'Provide valid project details and team assignments.' },
        400,
      );
    try {
      return c.json(platform.workspace.createOfficeProject(data.data), 201);
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.put('/office/projects/:id/kickoff', (c) => {
    try {
      return c.json(
        platform.workspace.initializeProjectKickoff(
          c.req.param('id'),
          platform.workspace.ownerId,
        ),
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.post('/office/projects/:id/kickoff/start', (c) => {
    try {
      return c.json(
        platform.collaboration.startProjectKickoff(c.req.param('id')),
        202,
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.post('/office/projects/:id/team', async (c) => {
    const data = z
      .object({
        dotId: z.string().min(1).optional(),
        memberTemplateId: z.string().min(1).optional(),
        name: z.string().trim().max(40).optional(),
        customization: z.string().max(1200).optional(),
        agentInstructions: z.string().max(10000).optional(),
        soulInstructions: z.string().max(10000).optional(),
        role: z.string().trim().min(1).max(80),
        mandate: z.string().trim().min(1).max(10000),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Provide a valid project collaborator.' }, 400);
    try {
      return c.json(
        platform.workspace.addOfficeProjectMember(c.req.param('id'), data.data),
        201,
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.post('/master-sessions', async (c) => {
    const data = z
      .object({
        spaceId: z.string().min(1),
        ...masterSessionSchema.shape,
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Provide a Space, name, and description.' }, 400);
    try {
      return c.json(
        platform.workspace.createMasterSession(
          data.data.spaceId,
          data.data.name,
          data.data.description,
        ),
        201,
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.get('/master-sessions/:id', (c) => {
    const masterSession = platform.workspace.masterSession(c.req.param('id'));
    if (!masterSession)
      return c.json({ error: 'Master Session not found.' }, 404);
    return c.json({
      ...masterSession,
      agents: platform.workspace.sessionAgents(masterSession.id),
    });
  });
  app.patch('/master-sessions/:id', async (c) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().max(4000).optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0)
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Provide valid Master Session metadata.' }, 400);
    try {
      return c.json(
        platform.workspace.updateMasterSession(c.req.param('id'), data.data),
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.put('/master-sessions/:id/status', async (c) => {
    const data = z
      .object({ status: z.enum(['active', 'paused', 'archived']) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Provide a valid Master Session status.' }, 400);
    try {
      return c.json(
        platform.workspace.setMasterSessionStatus(
          c.req.param('id'),
          data.data.status,
        ),
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.get('/master-sessions/:id/agents', (c) => {
    try {
      return c.json(platform.workspace.sessionAgents(c.req.param('id')));
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.post('/master-sessions/:id/agents', async (c) => {
    const data = sessionAgentSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!data.success)
      return c.json({ error: 'Provide a Dot, role, and mandate.' }, 400);
    try {
      return c.json(
        platform.workspace.addSessionAgent(
          c.req.param('id'),
          data.data.dotId,
          data.data.role,
          data.data.mandate,
          data.data.displayName ?? null,
          data.data.soulOverride,
        ),
        201,
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.get('/master-sessions/:id/agents/:agentId', (c) => {
    const agent = platform.workspace.sessionAgent(c.req.param('agentId'));
    if (!agent || agent.masterSessionId !== c.req.param('id'))
      return c.json({ error: 'Session Agent not found.' }, 404);
    return c.json(agent);
  });
  app.put('/master-sessions/:id/agents/:agentId', async (c) => {
    const data = z
      .object({
        role: z.string().trim().min(1).max(80).optional(),
        displayName: z.string().trim().max(80).nullable().optional(),
        mandate: z.string().trim().min(1).max(10000).optional(),
        soulOverride: z.string().max(10000).optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0)
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Provide valid Session Agent settings.' }, 400);
    const agent = platform.workspace.sessionAgent(c.req.param('agentId'));
    if (!agent || agent.masterSessionId !== c.req.param('id'))
      return c.json({ error: 'Session Agent not found.' }, 404);
    try {
      return c.json(platform.workspace.updateSessionAgent(agent.id, data.data));
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.put('/master-sessions/:id/agents/:agentId/status', async (c) => {
    const data = z
      .object({ status: z.enum(['active', 'paused', 'removed']) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Provide a valid Session Agent status.' }, 400);
    const agent = platform.workspace.sessionAgent(c.req.param('agentId'));
    if (!agent || agent.masterSessionId !== c.req.param('id'))
      return c.json({ error: 'Session Agent not found.' }, 404);
    try {
      return c.json(
        platform.workspace.setSessionAgentStatus(agent.id, data.data.status),
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.get('/master-sessions/:id/agents/:agentId/threads', (c) => {
    const agent = platform.workspace.sessionAgent(c.req.param('agentId'));
    if (!agent || agent.masterSessionId !== c.req.param('id'))
      return c.json({ error: 'Session Agent not found.' }, 404);
    try {
      return c.json(platform.workspace.sessionThreads(agent.id));
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.post('/master-sessions/:id/agents/:agentId/threads', async (c) => {
    const data = z
      .object({
        threadId: z.string().min(1),
        isPrimary: z.boolean().default(false),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'Provide a native thread and primary flag.' },
        400,
      );
    const agent = platform.workspace.sessionAgent(c.req.param('agentId'));
    if (!agent || agent.masterSessionId !== c.req.param('id'))
      return c.json({ error: 'Session Agent not found.' }, 404);
    try {
      return c.json(
        platform.workspace.associateSessionThread(
          agent.id,
          data.data.threadId,
          data.data.isPrimary,
        ),
        201,
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  const conversationCreateSchema = z
    .object({
      title: z.string().trim().min(1).max(160),
      kind: z.enum(['direct', 'group', 'plenary', 'agent_only']),
      visibility: z.enum(['private', 'restricted', 'team']),
      participantIds: conversationParticipantIdsSchema.default([]),
    })
    .strict();
  const conversationMessageSchema = z
    .object({
      content: z.string().trim().min(1).max(20000),
      contentType: z.enum(['text', 'json']).default('text'),
      visibility: z
        .enum(['conversation', 'participants'])
        .default('conversation'),
      idempotencyKey: z.string().trim().min(1).max(200).optional(),
      mentions: z.array(mentionSchema).max(100).optional(),
      activation: z.enum(['none', 'mentioned', 'direct']).optional(),
    })
    .strict();
  app.get('/master-sessions/:id/conversations', (c) => {
    try {
      return c.json(
        platform.workspace.listConversationsForOwner(
          c.req.param('id'),
          platform.workspace.ownerId,
        ),
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.get('/master-sessions/:id/conversation-summaries', (c) => {
    try {
      return c.json(
        platform.workspace.conversationSummariesForOwner(
          c.req.param('id'),
          platform.workspace.ownerId,
        ),
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.post('/master-sessions/:id/conversations/direct', async (c) => {
    const data = z
      .object({ sessionAgentId: z.string().min(1) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Choose a valid project collaborator.' }, 400);
    try {
      return c.json(
        platform.workspace.openDirectConversationForOwner(
          c.req.param('id'),
          platform.workspace.ownerId,
          data.data.sessionAgentId,
        ),
        200,
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.post('/master-sessions/:id/conversations', async (c) => {
    const data = conversationCreateSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!data.success)
      return c.json({ error: 'Provide valid conversation settings.' }, 400);
    if (data.data.kind === 'agent_only')
      return c.json(
        { error: 'Agent-only conversations require an internal creator.' },
        403,
      );
    try {
      const session = platform.workspace.masterSession(c.req.param('id'));
      if (!session) return c.json({ error: 'Master Session not found.' }, 404);
      const ids = new Set(data.data.participantIds);
      if (data.data.kind === 'plenary') {
        for (const agent of platform.workspace.sessionAgents(session.id))
          if (agent.status === 'active') ids.add(agent.id);
      }
      const participants = [...ids].map((participantId) => ({
        participantType: 'session_agent' as const,
        participantId,
        role: 'participant' as const,
      }));
      return c.json(
        platform.workspace.createOrganizationalConversation({
          masterSessionId: session.id,
          title: data.data.title,
          kind: data.data.kind,
          visibility: data.data.visibility,
          createdByType: 'user',
          createdById: platform.workspace.ownerId,
          participants: [
            ...participants,
            {
              participantType: 'user' as const,
              participantId: platform.workspace.ownerId,
              role: 'participant' as const,
            },
          ],
        }),
        201,
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.get('/organizational-conversations/:id', (c) => {
    try {
      platform.workspace.organizationalConversationForParticipant(
        c.req.param('id'),
        'user',
        platform.workspace.ownerId,
      );
      return c.json({
        conversation: platform.workspace.organizationalConversation(
          c.req.param('id'),
        ),
        participants: platform.workspace.listConversationParticipants(
          c.req.param('id'),
          'user',
          platform.workspace.ownerId,
        ),
        threads: platform.workspace.listConversationThreadsForParticipant(
          c.req.param('id'),
          'user',
          platform.workspace.ownerId,
        ),
      });
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.get('/organizational-conversations/:id/participants', (c) => {
    try {
      return c.json(
        platform.workspace.listConversationParticipants(
          c.req.param('id'),
          'user',
          platform.workspace.ownerId,
        ),
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.post('/organizational-conversations/:id/participants', async (c) => {
    const data = z
      .object({
        participantType: z.literal('session_agent'),
        participantId: z.string().min(1),
        role: z
          .enum(['moderator', 'participant', 'observer'])
          .default('participant'),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'Provide a valid Session Agent participant.' },
        400,
      );
    try {
      return c.json(
        platform.workspace.addConversationParticipant(
          c.req.param('id'),
          'user',
          platform.workspace.ownerId,
          data.data.participantType,
          data.data.participantId,
          data.data.role,
        ),
        201,
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.delete('/organizational-conversations/:id/participants/:agentId', (c) => {
    try {
      platform.workspace.removeConversationParticipant(
        c.req.param('id'),
        platform.workspace.ownerId,
        c.req.param('agentId'),
      );
      return c.json({ ok: true });
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.put(
    '/organizational-conversations/:id/participants/:agentId/role',
    async (c) => {
      const data = z
        .object({
          role: z.enum(['moderator', 'participant', 'observer']),
        })
        .strict()
        .safeParse(await c.req.json().catch(() => null));
      if (!data.success)
        return c.json({ error: 'Provide a valid participant role.' }, 400);
      try {
        return c.json(
          platform.workspace.setConversationParticipantRole(
            c.req.param('id'),
            platform.workspace.ownerId,
            c.req.param('agentId'),
            data.data.role,
          ),
        );
      } catch (error) {
        return sessionError(c, error);
      }
    },
  );
  app.post('/organizational-conversations/:id/leave', (c) => {
    try {
      platform.workspace.leaveConversation(
        c.req.param('id'),
        'user',
        platform.workspace.ownerId,
      );
      return c.json({ ok: true });
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.post('/organizational-conversations/:id/rejoin', (c) => {
    try {
      return c.json(
        platform.workspace.rejoinConversation(
          c.req.param('id'),
          'user',
          platform.workspace.ownerId,
        ),
        201,
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.get('/organizational-conversations/:id/threads', (c) => {
    try {
      return c.json(
        platform.workspace.listConversationThreadsForParticipant(
          c.req.param('id'),
          'user',
          platform.workspace.ownerId,
        ),
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.post('/organizational-conversations/:id/threads', async (c) => {
    const data = z
      .object({
        sessionAgentId: z.string().min(1),
        threadId: z.string().min(1),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'Provide a valid Session Agent thread link.' },
        400,
      );
    try {
      return c.json(
        platform.workspace.addConversationThread(
          c.req.param('id'),
          platform.workspace.ownerId,
          data.data.sessionAgentId,
          data.data.threadId,
        ),
        201,
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.put('/organizational-conversations/:id/owner', async (c) => {
    const data = z
      .object({ sessionAgentId: z.string().min(1) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Provide a valid Session Agent owner.' }, 400);
    try {
      return c.json(
        platform.workspace.transferConversationOwnership(
          c.req.param('id'),
          platform.workspace.ownerId,
          data.data.sessionAgentId,
        ),
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.get('/organizational-conversations/:id/messages', (c) => {
    const data = z
      .object({
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .safeParse({
        before: c.req.query('before'),
        limit: c.req.query('limit'),
      });
    if (!data.success)
      return c.json(
        { error: 'Provide a valid message cursor and page size.' },
        400,
      );
    try {
      return c.json(
        platform.workspace
          .listConversationMessagesForUser(
            c.req.param('id'),
            platform.workspace.ownerId,
            data.data.before,
            data.data.limit,
          )
          .map((message) => ({
            ...message,
            mentions:
              platform.workspace.collaboration.command(message.id)?.mentions ??
              [],
          })),
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.post('/organizational-conversations/:id/messages', async (c) => {
    const data = conversationMessageSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!data.success)
      return c.json({ error: 'Provide a valid conversation message.' }, 400);
    if (
      data.data.contentType === 'json' &&
      (() => {
        try {
          JSON.parse(data.data.content);
          return false;
        } catch {
          return true;
        }
      })()
    )
      return c.json({ error: 'JSON message content must be valid JSON.' }, 400);
    try {
      return c.json(
        platform.collaboration.publishHuman(c.req.param('id'), data.data),
        201,
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.route(
    '/organizational-conversations',
    collaborationRoutes(platform.collaboration),
  );
  app.put('/organizational-conversations/:id/status', async (c) => {
    const data = z
      .object({ status: z.enum(['closed', 'archived']) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Provide a valid conversation status.' }, 400);
    try {
      return c.json(
        platform.workspace.closeOrganizationalConversation(
          c.req.param('id'),
          platform.workspace.ownerId,
          data.data.status,
        ),
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });
  app.get('/search', (c) => {
    const parsed = z
      .object({
        q: z.string().trim().min(2).max(200),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .safeParse({
        q: c.req.query('q') ?? '',
        limit: c.req.query('limit') ?? undefined,
      });
    if (!parsed.success)
      return c.json({ error: 'Enter at least 2 characters to search.' }, 400);
    return c.json(
      searchWorkspace(platform.workspace, parsed.data.q, parsed.data.limit),
    );
  });
  app.post('/spaces', async (c) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(60),
        description: z.string().max(500).default(''),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'Enter a Space name (up to 60 characters).' },
        400,
      );
    return c.json(
      platform.workspace.createSpace(data.data.name, data.data.description),
      201,
    );
  });
  app.post('/dots', async (c) => {
    const data = dotSchema
      .extend({ spaceId: z.string() })
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        {
          error:
            'Provide a name, role instructions, and explicit tool permissions.',
        },
        400,
      );
    try {
      validateLearningSettings(
        data.data.learningContainerId ?? null,
        data.data.skillDeliveryEnabled ?? false,
      );
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Invalid Learning settings.',
        },
        400,
      );
    }
    return c.json(
      platform.workspace.createDot(
        data.data.spaceId,
        data.data.name,
        data.data.instructions,
        data.data.researchAllowed,
        data.data.memoryAllowed,
        data.data.spaceIds,
        data.data.learningContainerId,
        data.data.skillDeliveryEnabled,
        data.data.appsAllowed,
        data.data.composioToolkits,
      ),
      201,
    );
  });
  app.put('/dots/:id', async (c) => {
    const data = dotSchema.safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Invalid specialist settings.' }, 400);
    const current = platform.workspace.dot(c.req.param('id'));
    if (!current) return c.json({ error: 'Dot not found.' }, 404);
    try {
      validateLearningSettings(
        data.data.learningContainerId === undefined
          ? (current.learningContainerId ?? null)
          : data.data.learningContainerId,
        data.data.skillDeliveryEnabled ?? current.skillDeliveryEnabled ?? false,
      );
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Invalid Learning settings.',
        },
        400,
      );
    }
    return c.json(platform.workspace.updateDot(c.req.param('id'), data.data));
  });
  app.post('/conversations', async (c) => {
    const data = z
      .object({
        dotId: z.string(),
        title: z.string().trim().min(1).max(120).default('A new thought'),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Select a Dot and a conversation title.' }, 400);
    if (platform.setup().missing.length)
      return c.json(
        { error: `Setup required: ${platform.setup().missing.join(', ')}.` },
        503,
      );
    return c.json(
      await platform.createConversation(data.data.dotId, data.data.title),
      201,
    );
  });
  app.get('/conversations/:id/capture', (c) => {
    platform.workspace.requireHumanThread(c.req.param('id'));
    return c.json(platform.workspace.capture(c.req.param('id')));
  });
  app.post('/voice/calls', async (c) => {
    const data = z
      .object({ threadId: z.string(), sdp: z.string().max(100000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'A conversation and audio SDP offer are required.' },
        400,
      );
    return c.json(
      await voice.begin(data.data.threadId, data.data.sdp, c.req.raw.signal),
      201,
    );
  });
  app.get('/voice/calls/:id', (c) =>
    c.json(platform.workspace.call(c.req.param('id'))),
  );
  app.post('/voice/calls/:id/active', (c) =>
    c.json(voice.activate(c.req.param('id'))),
  );
  app.post('/voice/calls/:id/compute', async (c) => {
    const data = z
      .object({
        toolCallId: z.string().min(1).max(200),
        request: z.string().trim().min(1).max(4000),
        transcript: z.string().max(12000).default(''),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'A bounded compute request and tool call ID are required.' },
        400,
      );
    return c.json({
      text: await voice.compute(
        c.req.param('id'),
        data.data.toolCallId,
        `${data.data.request}\n\nUntrusted current-call transcript for context:\n${data.data.transcript}`,
      ),
    });
  });
  app.post('/voice/calls/:id/end', async (c) => {
    const data = z
      .object({
        transcript: z.string().max(20000),
        anchorMessageId: z.string().max(200).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'Transcript exceeds the 20,000 character limit.' },
        400,
      );
    platform.workspace.anchorCall(c.req.param('id'), data.data.anchorMessageId);
    return c.json(await voice.end(c.req.param('id'), data.data.transcript));
  });
  app.all('/copilotkit/*', (c) => platform.handle(c.req.raw));
  app.onError((error, c) => {
    const text = error.message;
    if (text.startsWith('Space access must include'))
      return c.json({ error: text }, 400);
    const known =
      /^(Setup|Voice setup|Dot |Space |Specialist |Conversation |Call |This call|End the current|Voice provider|An audio|Intelligence could not)/.test(
        text,
      );
    // A conversation, call or Dot the caller named that does not exist is a missing resource, not a
    // server fault.
    if (
      /^(Dot not found|Call not found|Conversation does not belong)/.test(text)
    )
      return c.json({ error: text }, 404);
    return c.json(
      {
        error: known
          ? text
          : 'The service request failed. Check the server configuration and try again.',
      },
      503,
    );
  });
  return app;
}
