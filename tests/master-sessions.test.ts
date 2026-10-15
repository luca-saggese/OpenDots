import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function fixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
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
  return {
    workspace,
    app: createApp({
      store,
      runner: new Runner(store, config),
      config,
      platform,
    }),
  };
}

const request = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

it('manages Master Sessions, context-specific agents, and native threads through the owner API', async () => {
  const { workspace, app } = fixture();
  const space = workspace.createSpace('Novel', 'A shared project.');
  const dot = workspace.createDot(
    space.id,
    'Writer',
    'Global Dot instructions.',
    false,
    true,
  );
  const outsideDot = workspace.dots()[0];

  const created = await app.request(
    '/api/master-sessions',
    request({ spaceId: space.id, name: 'Novel', description: 'Drafting.' }),
  );
  expect(created.status).toBe(201);
  const master = await created.json();
  expect(master).toMatchObject({
    spaceId: space.id,
    name: 'Novel',
    status: 'active',
  });
  expect(
    (
      await app.request(
        '/api/master-sessions',
        request({ spaceId: space.id, name: 'Duplicate' }),
      )
    ).status,
  ).toBe(409);

  const added = await app.request(
    `/api/master-sessions/${master.id}/agents`,
    request({
      dotId: dot.id,
      role: 'author',
      mandate: 'Write chapters for this project.',
      soulOverride: 'Prefer literary prose.',
    }),
  );
  expect(added.status).toBe(201);
  const agent = await added.json();
  expect(agent).toMatchObject({
    masterSessionId: master.id,
    dotId: dot.id,
    mandate: 'Write chapters for this project.',
    soulOverride: 'Prefer literary prose.',
  });
  expect(
    (
      await app.request(
        `/api/master-sessions/${master.id}/agents`,
        request({
          dotId: dot.id,
          role: 'editor',
          mandate: 'Duplicate membership.',
        }),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await app.request(
        `/api/master-sessions/${master.id}/agents`,
        request({
          dotId: outsideDot.id,
          role: 'editor',
          mandate: 'The Dot has no access to this Space.',
        }),
      )
    ).status,
  ).toBe(403);

  expect(
    (
      await app.request(
        `/api/master-sessions/${master.id}/agents/${agent.id}`,
        request({ mandate: 'Edit only this project.', role: 'editor' }, 'PUT'),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(
        `/api/master-sessions/${master.id}/agents/${agent.id}/status`,
        request({ status: 'paused' }, 'PUT'),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(
        `/api/master-sessions/${master.id}/agents/${agent.id}/status`,
        request({ status: 'active' }, 'PUT'),
      )
    ).status,
  ).toBe(200);

  workspace.bindThread('novel-thread', dot.id, 'Novel discussion');
  const linked = await app.request(
    `/api/master-sessions/${master.id}/agents/${agent.id}/threads`,
    request({ threadId: 'novel-thread', isPrimary: true }),
  );
  expect(linked.status).toBe(201);
  expect(await linked.json()).toMatchObject({
    sessionAgentId: agent.id,
    threadId: 'novel-thread',
    isPrimary: true,
  });
  expect(
    (
      await app.request(
        `/api/master-sessions/${master.id}/agents/${agent.id}/threads`,
      )
    ).status,
  ).toBe(200);
  expect(workspace.requireThread('novel-thread', dot.id).title).toBe(
    'Novel discussion',
  );

  expect(
    (
      await app.request(
        `/api/master-sessions/${master.id}/status`,
        request({ status: 'archived' }, 'PUT'),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(
        `/api/master-sessions/${master.id}`,
        request({ name: 'Archived project' }, 'PATCH'),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request(
        `/api/master-sessions/${master.id}/status`,
        request({ status: 'active' }, 'PUT'),
      )
    ).status,
  ).toBe(400);
});
