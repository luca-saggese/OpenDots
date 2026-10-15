import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { Platform } from '../src/server/platform.js';
import { createApp } from '../src/server/app.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
function fixture(path = ':memory:', token?: string) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(path, 'owner');
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
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    ownerToken: token,
  });
  return { app, workspace };
}
const post = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

it('seeds versioned member and team templates idempotently and keeps the catalog global', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opendots-seed-'));
  const path = join(directory, 'workspace.sqlite');
  try {
    let workspace = new WorkspaceStore(path, 'owner');
    const beforeMembers = workspace.memberTemplates();
    const beforeTeams = workspace.teamTemplates();
    workspace.close();
    // Constructing the same persistent workspace must not add duplicate seeds.
    workspace = new WorkspaceStore(path, 'owner');
    expect(workspace.memberTemplates()).toHaveLength(beforeMembers.length);
    expect(workspace.teamTemplates()).toHaveLength(beforeTeams.length);
    expect(workspace.memberTemplate('aerospace-engineer')).toBeDefined();
    workspace.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const { app } = fixture();
  expect(
    (await app.request('/api/office/member-templates?q=aerospace')).status,
  ).toBe(200);
  const filtered = await app.request(
    '/api/office/member-templates?q=aerospace',
  );
  expect(
    (await filtered.json()).map((item: { id: string }) => item.id),
  ).toContain('aerospace-engineer');
});

it('creates a permanent Dot from a Member Template with explicit AGENT and SOUL customization', async () => {
  const { app, workspace } = fixture();
  const response = await app.request(
    '/api/office/dots/from-template',
    post({
      memberTemplateId: 'world-builder',
      name: 'Cyberpunk World Builder',
      customization: 'Focus on dense, rain-soaked science fiction settings.',
    }),
  );
  expect(response.status).toBe(201);
  const result = await response.json();
  expect(result.dot.instructions).toContain('Permanent owner customization');
  expect(result.dot.instructions).toContain('rain-soaked');
  expect(result.profile.soulInstructions).toContain('rain-soaked');
  expect(result.profile.skills).toContain('continuity');
  expect(workspace.dot(result.dot.id)).toEqual(result.dot);
});

it('creates and reuses a permanent Dot across projects without changing its instructions', async () => {
  const { app, workspace } = fixture();
  const made = await app.request(
    '/api/office/dots/from-template',
    post({ memberTemplateId: 'director', name: 'Ari' }),
  );
  const { dot } = await made.json();
  const body = (creationKey: string, name: string, role: string) => ({
    creationKey,
    name,
    description: 'A project goal.',
    team: [{ id: 'slot-1', dotId: dot.id, role, mandate: `${role} mandate.` }],
  });
  const first = await app.request(
    '/api/office/projects',
    post(body('book-key', 'Book', 'Director')),
  );
  const second = await app.request(
    '/api/office/projects',
    post(body('research-key', 'Research', 'Research lead')),
  );
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  const [book, research] = await Promise.all([first.json(), second.json()]);
  expect(book.agents[0].dotId).toBe(dot.id);
  expect(research.agents[0].dotId).toBe(dot.id);
  expect(research.agents[0].role).toBe('Research lead');
  expect(workspace.dot(dot.id)?.instructions).toBe(dot.instructions);
  expect(workspace.sessionAgents(book.masterSession.id)[0].mandate).not.toBe(
    workspace.sessionAgents(research.masterSession.id)[0].mandate,
  );
  expect(workspace.canAccessSpace(dot.id, research.masterSession.spaceId)).toBe(
    true,
  );
});

it('allows a modified team to hire a cross-category archetype and makes retries idempotent', async () => {
  const { app, workspace } = fixture();
  const template = await app.request('/api/office/team-templates/write-a-book');
  const book = await template.json();
  const team = [
    ...book.positions.filter(
      (item: { id: string }) => item.id !== 'character-builder',
    ),
    {
      id: 'aerospace-specialist',
      memberTemplateId: 'aerospace-engineer',
      name: 'Flight Consultant',
      role: 'Aerospace Consultant',
      mandate: 'Check the flight science.',
    },
  ];
  const payload = {
    creationKey: 'custom-book',
    name: 'Orbital Novel',
    description: 'A novel set in orbit.',
    team: team.map(
      (item: {
        id: string;
        memberTemplateId: string;
        role: string;
        responsibility?: string;
        name?: string;
        mandate?: string;
      }) => ({
        id: item.id,
        memberTemplateId: item.memberTemplateId,
        name: item.name ?? item.role,
        role: item.role,
        mandate:
          item.mandate ?? item.responsibility ?? 'Contribute to the book.',
      }),
    ),
  };
  const first = await app.request('/api/office/projects', post(payload));
  const second = await app.request('/api/office/projects', post(payload));
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  const one = await first.json();
  const two = await second.json();
  expect(one.masterSession.id).toBe(two.masterSession.id);
  expect(workspace.masterSessions()).toHaveLength(1);
  expect(one.agents).toHaveLength(team.length);
  const aerospace = one.dots.find(
    (dot: { name: string }) => dot.name === 'Flight Consultant',
  );
  expect(aerospace).toBeDefined();
  expect(workspace.dotProfile(aerospace.id).memberTemplateId).toBe(
    'aerospace-engineer',
  );
});

it('adds new global-catalog collaborators to an existing project atomically', async () => {
  const { app, workspace } = fixture();
  const projectResponse = await app.request(
    '/api/office/projects',
    post({
      creationKey: 'initial-project',
      name: 'Novel',
      description: '',
      team: [
        {
          memberTemplateId: 'director',
          name: 'Director',
          role: 'Director',
          mandate: 'Coordinate the work.',
        },
      ],
    }),
  );
  const project = await projectResponse.json();
  const before = workspace.dots().length;
  const added = await app.request(
    `/api/office/projects/${project.masterSession.id}/team`,
    post({
      memberTemplateId: 'aerospace-engineer',
      name: 'Flight Expert',
      customization: 'Focus on orbital mechanics.',
      role: 'Technical Reviewer',
      mandate: 'Review technical plausibility.',
    }),
  );
  expect(added.status).toBe(201);
  const result = await added.json();
  expect(workspace.dots()).toHaveLength(before + 1);
  expect(workspace.sessionAgents(project.masterSession.id)).toHaveLength(2);
  expect(result.dot.instructions).toContain('orbital mechanics');
  expect(result.agent.mandate).toBe('Review technical plausibility.');
});

it('rejects invalid project templates without side effects and protects Office APIs with owner auth', async () => {
  const { app, workspace } = fixture(':memory:', 'secret');
  const denied = await app.request('/api/office/team-templates');
  expect(denied.status).toBe(401);
  const beforeSpaces = workspace.spaces().length;
  const failed = await app.request('/api/office/projects', {
    ...post(
      {
        creationKey: 'bad',
        name: 'Broken',
        team: [
          {
            id: 'bad',
            memberTemplateId: 'not-a-template',
            name: 'Bad',
            role: 'Role',
            mandate: 'Mandate',
          },
        ],
      },
      'POST',
    ),
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret',
    },
  });
  expect(failed.status).toBe(404);
  expect(workspace.spaces()).toHaveLength(beforeSpaces);
  const allowed = await app.request('/api/office/team-templates', {
    headers: { Authorization: 'Bearer secret' },
  });
  expect(allowed.status).toBe(200);
});

it('persists templates, profiles, projects, and assignments after reopening SQLite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opendots-office-'));
  const path = join(directory, 'workspace.sqlite');
  let workspace = new WorkspaceStore(path, 'owner');
  try {
    const { dot } = workspace.createDotFromMemberTemplate({
      memberTemplateId: 'philosopher',
      name: 'Sage',
    });
    workspace.updateDotProfile(dot.id, {
      summary: 'A project philosopher.',
      skills: ['ethics'],
      workStyle: 'Careful and clear.',
    });
    const project = workspace.createOfficeProject({
      creationKey: 'persistent',
      name: 'Questions',
      description: 'Think well.',
      team: [
        {
          id: 'p',
          dotId: dot.id,
          role: 'Philosopher',
          mandate: 'Explore assumptions.',
        },
      ],
    });
    workspace.close();
    workspace = new WorkspaceStore(path, 'owner');
    expect(workspace.memberTemplate('philosopher')).toBeDefined();
    expect(workspace.dotProfile(dot.id).summary).toBe('A project philosopher.');
    expect(workspace.masterSession(project.masterSession.id)?.name).toBe(
      'Questions',
    );
    expect(workspace.sessionAgents(project.masterSession.id)[0].dotId).toBe(
      dot.id,
    );
  } finally {
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
