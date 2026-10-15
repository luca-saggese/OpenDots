import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
it('persists spaces, specialist permissions, and canonical thread ownership', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const space = store.createSpace('Design', 'Design decisions');
  const dot = store.createDot(space.id, 'Scout', 'Be concise', false, true);
  store.bindThread('thread-1', dot.id, 'Design research');
  expect(store.requireThread('thread-1', dot.id).ownerId).toBe('owner');
  expect(() => store.requireThread('thread-1', 'another-dot')).toThrow();
  expect(() => store.requireThread('unknown')).toThrow();
  expect(store.dot(dot.id)?.researchAllowed).toBe(false);
  store.close();
});
it('rejects a dot in a nonexistent space and does not rebind an existing thread', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  expect(() => store.createDot('missing', 'Dot', 'Help', true, true)).toThrow();
  const dots = store.dots();
  store.bindThread('one', dots[0].id, 'First');
  expect(() => store.bindThread('one', dots[0].id, 'Second')).toThrow();
  store.close();
});

it('persists Master Sessions, isolated Dot memberships, and native thread bindings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-sessions-'));
  const path = join(dir, 'workspace.sqlite');
  try {
    const store = new WorkspaceStore(path, 'owner');
    const firstSpace = store.createSpace('Novel', '');
    const secondSpace = store.createSpace('Research', '');
    const sharedDot = store.createDot(
      firstSpace.id,
      'Writer',
      'Global instructions',
      true,
      true,
      [firstSpace.id, secondSpace.id],
    );
    const otherDot = store.createDot(
      secondSpace.id,
      'Researcher',
      'Research instructions',
      false,
      true,
    );
    const first = store.createMasterSession(firstSpace.id, 'Novel draft');
    expect(() =>
      store.createMasterSession(firstSpace.id, 'Duplicate'),
    ).toThrow();
    const second = store.createMasterSession(secondSpace.id, 'Research notes');
    const writer = store.addSessionAgent(
      first.id,
      sharedDot.id,
      'author',
      'Write only this novel.',
      'Novel Writer',
      'Use the novel style.',
    );
    expect(() =>
      store.addSessionAgent(
        first.id,
        sharedDot.id,
        'editor',
        'Duplicate membership.',
      ),
    ).toThrow();
    const researcher = store.addSessionAgent(
      second.id,
      sharedDot.id,
      'researcher',
      'Investigate a different project.',
      null,
      'Use the research style.',
    );
    const specialist = store.addSessionAgent(
      second.id,
      otherDot.id,
      'fact_checker',
      'Verify claims.',
    );
    expect(writer).toMatchObject({
      mandate: 'Write only this novel.',
      soulOverride: 'Use the novel style.',
    });
    expect(researcher).toMatchObject({
      mandate: 'Investigate a different project.',
      soulOverride: 'Use the research style.',
    });
    expect(store.dot(sharedDot.id)?.instructions).toBe('Global instructions');

    store.bindThread('novel-main', sharedDot.id, 'Novel main');
    store.bindThread('novel-notes', sharedDot.id, 'Novel notes');
    store.bindThread('research-thread', otherDot.id, 'Research');
    const main = store.associateSessionThread(writer.id, 'novel-main', true);
    store.associateSessionThread(writer.id, 'novel-notes');
    expect(main.isPrimary).toBe(true);
    expect(
      store.sessionThreads(writer.id).filter((thread) => thread.isPrimary),
    ).toHaveLength(1);
    expect(() =>
      store.associateSessionThread(writer.id, 'research-thread'),
    ).toThrow(/does not belong/);
    expect(() =>
      store.addSessionAgent(
        first.id,
        otherDot.id,
        'editor',
        'Cannot access this Space.',
      ),
    ).toThrow(/does not have access/);
    expect(() =>
      store.associateSessionThread(researcher.id, 'novel-main'),
    ).toThrow(/already associated/);

    const otherOwner = new WorkspaceStore(path, 'another-owner');
    expect(() =>
      otherOwner.associateSessionThread(specialist.id, 'research-thread'),
    ).toThrow();
    otherOwner.close();

    store.setMasterSessionStatus(first.id, 'paused');
    expect(() => store.associateSessionThread(writer.id, 'novel-main')).toThrow(
      /active Master Session/,
    );
    store.setMasterSessionStatus(first.id, 'active');
    store.setSessionAgentStatus(writer.id, 'paused');
    expect(() => store.associateSessionThread(writer.id, 'novel-main')).toThrow(
      /active Session Agent/,
    );
    store.setSessionAgentStatus(writer.id, 'active');
    store.updateSessionAgent(writer.id, { role: 'lead author' });
    store.setSessionAgentStatus(writer.id, 'removed');
    expect(() =>
      store.updateSessionAgent(writer.id, { role: 'editor' }),
    ).toThrow(/Removed Session Agents/);
    store.setMasterSessionStatus(first.id, 'archived');
    expect(() =>
      store.updateMasterSession(first.id, { name: 'No longer editable' }),
    ).toThrow(/Archived Master Sessions/);
    expect(() => store.setMasterSessionStatus(first.id, 'active')).toThrow(
      /cannot be reactivated/,
    );
    store.close();

    const reopened = new WorkspaceStore(path, 'owner');
    expect(reopened.masterSession(first.id)).toMatchObject({
      id: first.id,
      spaceId: firstSpace.id,
      status: 'archived',
    });
    expect(reopened.sessionAgent(writer.id)).toMatchObject({
      mandate: 'Write only this novel.',
      role: 'lead author',
      status: 'removed',
    });
    expect(reopened.sessionAgent(researcher.id)?.masterSessionId).toBe(
      second.id,
    );
    expect(reopened.sessionThreads(writer.id)).toHaveLength(2);
    expect(reopened.requireThread('novel-main', sharedDot.id).ownerId).toBe(
      'owner',
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('rechecks current Dot Space permissions before associating a thread', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const space = store.createSpace('Project', '');
  const dot = store.createDot(space.id, 'Specialist', 'Help', true, true);
  const masterSession = store.createMasterSession(space.id, 'Project');
  const agent = store.addSessionAgent(
    masterSession.id,
    dot.id,
    'specialist',
    'Work on this project.',
  );
  store.bindThread('project-thread', dot.id, 'Project thread');
  store.updateDot(dot.id, {
    ...dot,
    spaceId: store.spaces()[0].id,
    spaceIds: [store.spaces()[0].id],
  });
  expect(() =>
    store.associateSessionThread(agent.id, 'project-thread'),
  ).toThrow(/does not have access/);
  store.close();
});

it('migrates legacy Space ownership once and never restores revoked access on restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-access-'));
  const path = join(dir, 'workspace.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      INSERT INTO spaces VALUES ('old', 'Original', '', 1), ('new', 'New', '', 2);
      INSERT INTO dots VALUES ('dot', 'old', 'Dot', 'Help', 1, 1, 1);
      INSERT INTO thread_bindings VALUES ('legacy-thread', 'dot', 'owner', 'Legacy conversation', 1);`);
    legacy.close();
    const ws = new WorkspaceStore(path, 'owner');
    const legacySession = ws.createMasterSession('old', 'Legacy project');
    const dot = ws.dot('dot')!;
    expect(dot.spaceIds).toEqual(['old']);
    expect(ws.canAccessSpace('dot', 'new')).toBe(false);
    expect(ws.requireThread('legacy-thread', 'dot').title).toBe(
      'Legacy conversation',
    );
    expect(() =>
      ws.updateDot('dot', { ...dot, spaceIds: ['missing'] }),
    ).toThrow();
    expect(ws.dot('dot')?.spaceIds).toEqual(['old']);
    ws.bindThread('existing-thread', 'dot', 'Keep me');
    ws.updateDot('dot', { ...dot, spaceId: 'new', spaceIds: ['new'] });
    ws.close();
    const reopened = new WorkspaceStore(path, 'owner');
    expect(reopened.dot('dot')?.spaceIds).toEqual(['new']);
    expect(reopened.canAccessSpace('dot', 'old')).toBe(false);
    expect(reopened.requireThread('existing-thread').dotId).toBe('dot');
    expect(reopened.requireThread('legacy-thread').title).toBe(
      'Legacy conversation',
    );
    expect(reopened.masterSession(legacySession.id)).toMatchObject({
      spaceId: 'old',
      name: 'Legacy project',
    });
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
