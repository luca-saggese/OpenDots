import { ComputerStore } from './computer-store.js';
import { CollaborationStore } from './collaboration-store.js';
import { ConnectionStore } from './connection-store.js';
import { Pages } from './pages.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateLearningSettings } from '../shared/learning.js';
import type {
  CallReceipt,
  Conversation,
  ConversationParticipant,
  ConversationParticipantRole,
  ConversationParticipantType,
  ConversationThreadLink,
  Dot,
  DotProfile,
  MasterSession,
  MasterSessionStatus,
  OrganizationalConversation,
  OrganizationalConversationKind,
  OrganizationalConversationStatus,
  OrganizationalConversationVisibility,
  OrganizationalMessage,
  SessionAgent,
  SessionAgentStatus,
  SessionThread,
  Space,
  MemberTemplate,
  TeamTemplate,
} from '../shared/types.js';
import { memberTemplates, teamTemplates } from './office-templates.js';
export class WorkspaceStore {
  private db: DatabaseSync;
  readonly collaboration: CollaborationStore;
  private runningThreads = new Set<string>();
  readonly pages: Pages;
  readonly computers: ComputerStore;
  readonly connections: ConnectionStore;
  constructor(
    path: string,
    readonly ownerId: string,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_threads(taskId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER, status TEXT NOT NULL, transcript TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS captures(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS master_sessions(
        id TEXT PRIMARY KEY,
        spaceId TEXT NOT NULL UNIQUE REFERENCES spaces(id) ON DELETE RESTRICT,
        name TEXT NOT NULL CHECK(length(trim(name)) > 0),
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'archived')),
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        creationKey TEXT
      );
      CREATE TABLE IF NOT EXISTS member_templates(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        category TEXT NOT NULL, tags TEXT NOT NULL, skills TEXT NOT NULL,
        agentInstructions TEXT NOT NULL, soulInstructions TEXT NOT NULL,
        version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_templates(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        category TEXT NOT NULL, tags TEXT NOT NULL, version INTEGER NOT NULL,
        positions TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dot_profiles(
        dotId TEXT PRIMARY KEY REFERENCES dots(id) ON DELETE CASCADE,
        summary TEXT NOT NULL DEFAULT '', skills TEXT NOT NULL DEFAULT '[]',
        workStyle TEXT NOT NULL DEFAULT '', memberTemplateId TEXT,
        soulInstructions TEXT NOT NULL DEFAULT '', updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_agents(
        id TEXT PRIMARY KEY,
        masterSessionId TEXT NOT NULL REFERENCES master_sessions(id) ON DELETE RESTRICT,
        dotId TEXT NOT NULL REFERENCES dots(id) ON DELETE RESTRICT,
        role TEXT NOT NULL CHECK(length(trim(role)) > 0),
        displayName TEXT,
        status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'removed')),
        mandate TEXT NOT NULL CHECK(length(trim(mandate)) > 0),
        soulOverride TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        UNIQUE(masterSessionId, dotId)
      );
      CREATE INDEX IF NOT EXISTS session_agents_dot_idx ON session_agents(dotId);
      CREATE TABLE IF NOT EXISTS session_threads(
        id TEXT PRIMARY KEY,
        sessionAgentId TEXT NOT NULL REFERENCES session_agents(id) ON DELETE RESTRICT,
        threadId TEXT NOT NULL UNIQUE REFERENCES thread_bindings(id) ON DELETE RESTRICT,
        isPrimary INTEGER NOT NULL CHECK(isPrimary IN (0, 1)),
        createdAt INTEGER NOT NULL,
        UNIQUE(sessionAgentId, threadId)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS session_threads_primary_idx
        ON session_threads(sessionAgentId) WHERE isPrimary=1;
      CREATE INDEX IF NOT EXISTS session_threads_agent_idx ON session_threads(sessionAgentId);
      CREATE TABLE IF NOT EXISTS session_conversations(
        id TEXT PRIMARY KEY,
        masterSessionId TEXT NOT NULL REFERENCES master_sessions(id) ON DELETE RESTRICT,
        title TEXT NOT NULL CHECK(length(trim(title)) > 0),
        kind TEXT NOT NULL CHECK(kind IN ('direct', 'group', 'plenary', 'agent_only')),
        visibility TEXT NOT NULL CHECK(visibility IN ('private', 'restricted', 'team')),
        status TEXT NOT NULL CHECK(status IN ('active', 'closed', 'archived')),
        createdByType TEXT NOT NULL CHECK(createdByType IN ('user', 'session_agent')),
        createdById TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        CHECK(
          (kind='direct' AND visibility='private') OR
          (kind='group' AND visibility='restricted') OR
          (kind='plenary' AND visibility='team') OR
            (kind='agent_only' AND visibility='restricted')
        )
      );
      CREATE INDEX IF NOT EXISTS session_conversations_session_idx
        ON session_conversations(masterSessionId, updatedAt);
      CREATE TABLE IF NOT EXISTS conversation_participants(
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL REFERENCES session_conversations(id) ON DELETE RESTRICT,
        participantType TEXT NOT NULL CHECK(participantType IN ('user', 'session_agent')),
        participantId TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner', 'moderator', 'participant', 'observer')),
        joinedAt INTEGER NOT NULL,
        joinedAfterSequence INTEGER NOT NULL CHECK(joinedAfterSequence >= 0),
        leftAt INTEGER,
        leftAfterSequence INTEGER,
        status TEXT NOT NULL CHECK(status IN ('active', 'left', 'removed')),
        CHECK(
          (status='active' AND leftAt IS NULL AND leftAfterSequence IS NULL) OR
          (status IN ('left', 'removed') AND leftAt IS NOT NULL AND leftAfterSequence IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS conversation_participants_active_idx
        ON conversation_participants(conversationId, participantType, participantId)
        WHERE status='active';
      CREATE INDEX IF NOT EXISTS conversation_participants_principal_idx
        ON conversation_participants(participantType, participantId, conversationId, status);
      CREATE INDEX IF NOT EXISTS conversation_participants_conversation_idx
        ON conversation_participants(conversationId, status);
      CREATE TABLE IF NOT EXISTS conversation_messages(
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL REFERENCES session_conversations(id) ON DELETE RESTRICT,
        sequenceNumber INTEGER NOT NULL CHECK(sequenceNumber > 0),
        senderType TEXT NOT NULL CHECK(senderType IN ('user', 'session_agent')),
        senderId TEXT NOT NULL,
        content TEXT NOT NULL,
        contentType TEXT NOT NULL CHECK(contentType IN ('text', 'json')),
        createdAt INTEGER NOT NULL,
        visibility TEXT NOT NULL CHECK(visibility IN ('conversation', 'participants')),
        sourceThreadId TEXT REFERENCES thread_bindings(id) ON DELETE RESTRICT,
        sourceTurnId TEXT,
        idempotencyKey TEXT,
        UNIQUE(conversationId, sequenceNumber),
        UNIQUE(conversationId, idempotencyKey)
      );
      CREATE INDEX IF NOT EXISTS conversation_messages_page_idx
        ON conversation_messages(conversationId, sequenceNumber);
      CREATE INDEX IF NOT EXISTS conversation_messages_source_idx
        ON conversation_messages(sourceThreadId, sourceTurnId);
      CREATE TABLE IF NOT EXISTS conversation_threads(
        conversationId TEXT NOT NULL REFERENCES session_conversations(id) ON DELETE RESTRICT,
        sessionAgentId TEXT NOT NULL REFERENCES session_agents(id) ON DELETE RESTRICT,
        threadId TEXT NOT NULL UNIQUE REFERENCES thread_bindings(id) ON DELETE RESTRICT,
        linkedAt INTEGER NOT NULL,
        PRIMARY KEY(conversationId, sessionAgentId),
        UNIQUE(conversationId, threadId)
      );
      CREATE INDEX IF NOT EXISTS conversation_threads_agent_idx
        ON conversation_threads(sessionAgentId, conversationId);`);
    for (const [table, column, definition] of [
      ['master_sessions', 'creationKey', 'TEXT'],
      ['dots', 'learningContainerId', 'TEXT'],
      ['dots', 'skillDeliveryEnabled', 'INTEGER NOT NULL DEFAULT 0'],
      ['dots', 'appsAllowed', 'INTEGER NOT NULL DEFAULT 0'],
      ['dots', 'composioToolkits', "TEXT NOT NULL DEFAULT '[]'"],
      ['dots', 'composioSessionId', 'TEXT'],
      ['dots', 'composioPolicyHash', 'TEXT'],
      ['thread_bindings', 'learningContainerId', 'TEXT'],
    ]) {
      if (
        !this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((field) => field.name === column)
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    this.seedOfficeTemplates();
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS master_sessions_creation_key_idx ON master_sessions(creationKey) WHERE creationKey IS NOT NULL',
    );
    // Migrate only once: restarting must never restore a revoked grant.
    if (
      !this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='dot_spaces'",
        )
        .get()
    ) {
      this.db.exec(`BEGIN;
        CREATE TABLE dot_spaces(dotId TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(dotId, spaceId));
        INSERT INTO dot_spaces SELECT id, spaceId FROM dots;
        COMMIT;`);
    }
    this.collaboration = new CollaborationStore(this.db);
    this.computers = new ComputerStore(this.db);
    this.connections = new ConnectionStore(this.db);
    this.pages = new Pages(this.db, (id) =>
      this.spaces().some((space) => space.id === id),
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(calls)')
        .all()
        .some((column) => column.name === 'anchorMessageId')
    )
      this.db.exec('ALTER TABLE calls ADD COLUMN anchorMessageId TEXT');
    if (!this.spaces().length) {
      const space = this.createSpace(
        'Everyday',
        'A little space for your day.',
      );
      this.createDot(
        space.id,
        'Dot',
        'Be thoughtful, practical, and concise. Help the user think clearly and follow through.',
        true,
        true,
      );
    }
  }
  close() {
    this.db.close();
  }
  private seedOfficeTemplates() {
    const member = this.db.prepare(
      `INSERT INTO member_templates (id,name,description,category,tags,skills,agentInstructions,soulInstructions,version)
       VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, description=excluded.description, category=excluded.category,
       tags=excluded.tags, skills=excluded.skills, agentInstructions=excluded.agentInstructions,
       soulInstructions=excluded.soulInstructions, version=excluded.version
       WHERE excluded.version > member_templates.version`,
    );
    for (const item of memberTemplates)
      member.run(
        item.id,
        item.name,
        item.description,
        item.category,
        JSON.stringify(item.tags),
        JSON.stringify(item.skills),
        item.agentInstructions,
        item.soulInstructions,
        item.version,
      );
    const team = this.db.prepare(
      `INSERT INTO team_templates (id,name,description,category,tags,version,positions)
       VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, description=excluded.description, category=excluded.category,
       tags=excluded.tags, version=excluded.version, positions=excluded.positions
       WHERE excluded.version > team_templates.version`,
    );
    for (const item of teamTemplates)
      team.run(
        item.id,
        item.name,
        item.description,
        item.category,
        JSON.stringify(item.tags),
        item.version,
        JSON.stringify(item.positions),
      );
  }
  memberTemplates(query = ''): MemberTemplate[] {
    const needle = query.trim().toLocaleLowerCase();
    return (
      this.db
        .prepare('SELECT * FROM member_templates ORDER BY name')
        .all() as Array<Record<string, unknown>>
    )
      .map(
        (row) =>
          ({
            ...row,
            tags: JSON.parse(String(row.tags)),
            skills: JSON.parse(String(row.skills)),
          }) as unknown as MemberTemplate,
      )
      .filter(
        (item) =>
          !needle ||
          [
            item.name,
            item.description,
            item.category,
            ...item.tags,
            ...item.skills,
          ].some((value) => value.toLocaleLowerCase().includes(needle)),
      );
  }
  memberTemplate(id: string) {
    return this.memberTemplates().find((item) => item.id === id);
  }
  teamTemplates() {
    return (
      this.db
        .prepare('SELECT * FROM team_templates ORDER BY name')
        .all() as Array<Record<string, unknown>>
    ).map(
      (row) =>
        ({
          ...row,
          tags: JSON.parse(String(row.tags)),
          positions: JSON.parse(String(row.positions)),
        }) as unknown as TeamTemplate,
    );
  }
  teamTemplate(id: string) {
    return this.teamTemplates().find((item) => item.id === id);
  }
  dotProfile(dotId: string): DotProfile {
    if (!this.dot(dotId)) throw new Error('Dot not found.');
    const row = this.db
      .prepare('SELECT * FROM dot_profiles WHERE dotId=?')
      .get(dotId) as Record<string, unknown> | undefined;
    return row
      ? ({
          ...row,
          skills: JSON.parse(String(row.skills)),
        } as unknown as DotProfile)
      : {
          dotId,
          summary: '',
          skills: [],
          workStyle: '',
          memberTemplateId: null,
          soulInstructions: '',
          updatedAt: 0,
        };
  }
  dotProfiles() {
    return this.dots().map((dot) => ({
      dot,
      profile: this.dotProfile(dot.id),
      projects: this.db
        .prepare(
          `SELECT m.id,m.name,m.status,a.role,a.status AS agentStatus FROM session_agents a
        JOIN master_sessions m ON m.id=a.masterSessionId WHERE a.dotId=? ORDER BY m.createdAt DESC`,
        )
        .all(dot.id),
    }));
  }
  updateDotProfile(
    dotId: string,
    patch: Pick<DotProfile, 'summary' | 'skills' | 'workStyle'>,
  ) {
    if (!this.dot(dotId)) throw new Error('Dot not found.');
    if (
      patch.summary.length > 2000 ||
      patch.workStyle.length > 2000 ||
      patch.skills.length > 30 ||
      patch.skills.some((skill) => !skill.trim() || skill.length > 80)
    )
      throw new Error('Invalid collaborator profile.');
    const current = this.dotProfile(dotId);
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.db
      .prepare(
        `INSERT INTO dot_profiles (dotId,summary,skills,workStyle,memberTemplateId,soulInstructions,updatedAt)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(dotId) DO UPDATE SET summary=excluded.summary,skills=excluded.skills,workStyle=excluded.workStyle,updatedAt=excluded.updatedAt`,
      )
      .run(
        dotId,
        next.summary,
        JSON.stringify(next.skills),
        next.workStyle,
        next.memberTemplateId,
        next.soulInstructions,
        next.updatedAt,
      );
    return next;
  }
  createDotFromMemberTemplate(input: {
    memberTemplateId: string;
    name: string;
    customization?: string;
  }) {
    const template = this.memberTemplate(input.memberTemplateId);
    if (!template) throw new Error('Member Template not found.');
    const name = input.name.trim();
    if (!name || name.length > 40 || (input.customization?.length ?? 0) > 1200)
      throw new Error('Provide a valid collaborator name and customization.');
    const space = this.spaces()[0];
    if (!space) throw new Error('Space not found.');
    const customization = input.customization?.trim() ?? '';
    const instructions = `${template.agentInstructions}${customization ? `\n\nPermanent owner customization:\n${customization}` : ''}`;
    const dotId = randomUUID();
    const createdAt = Date.now();
    const dot: Dot = {
      id: dotId,
      spaceId: space.id,
      spaceIds: [space.id],
      name,
      instructions,
      researchAllowed: false,
      memoryAllowed: false,
      appsAllowed: false,
      composioToolkits: [],
      composioSessionId: null,
      composioPolicyHash: null,
      learningContainerId: null,
      skillDeliveryEnabled: false,
      createdAt,
    };
    const profile: DotProfile = {
      dotId,
      summary: template.description,
      skills: [...template.skills],
      workStyle: template.soulInstructions,
      memberTemplateId: template.id,
      soulInstructions:
        template.soulInstructions +
        (customization ? `\n\nOwner customization: ${customization}` : ''),
      updatedAt: createdAt,
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO dots (id,spaceId,name,instructions,researchAllowed,memoryAllowed,createdAt,learningContainerId,skillDeliveryEnabled,appsAllowed,composioToolkits) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          dot.id,
          dot.spaceId,
          dot.name,
          dot.instructions,
          0,
          0,
          dot.createdAt,
          null,
          0,
          0,
          '[]',
        );
      this.db
        .prepare('INSERT INTO dot_spaces (dotId,spaceId) VALUES (?,?)')
        .run(dot.id, space.id);
      this.db
        .prepare(
          `INSERT INTO dot_profiles (dotId,summary,skills,workStyle,memberTemplateId,soulInstructions,updatedAt) VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          profile.dotId,
          profile.summary,
          JSON.stringify(profile.skills),
          profile.workStyle,
          profile.memberTemplateId,
          profile.soulInstructions,
          profile.updatedAt,
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { dot, profile };
  }
  createOfficeProject(input: {
    creationKey: string;
    name: string;
    description: string;
    team: Array<{
      id?: string;
      dotId?: string;
      memberTemplateId?: string;
      name?: string;
      customization?: string;
      role: string;
      mandate: string;
    }>;
  }) {
    const name = input.name.trim();
    const key = input.creationKey.trim();
    if (
      !key ||
      key.length > 120 ||
      !name ||
      name.length > 120 ||
      input.description.length > 4000
    )
      throw new Error('Invalid project details.');
    if (!input.team.length || input.team.length > 100)
      throw new Error('A project needs between 1 and 100 collaborators.');
    const existingProject = this.db
      .prepare('SELECT id FROM master_sessions WHERE creationKey=?')
      .get(key) as { id: string } | undefined;
    if (existingProject)
      return {
        masterSession: this.masterSession(existingProject.id)!,
        agents: this.sessionAgents(existingProject.id),
        dots: this.dots(),
      };
    const spaceId = randomUUID();
    const masterSessionId = randomUUID();
    const now = Date.now();
    const dotIds = new Set<string>();
    const requestedDotIds = new Set<string>();
    for (const row of input.team) {
      if (
        !row.role.trim() ||
        !row.mandate.trim() ||
        row.role.length > 80 ||
        row.mandate.length > 10000
      )
        throw new Error('Each collaborator needs a role and mandate.');
      if (!!row.dotId === !!row.memberTemplateId)
        throw new Error(
          'Choose an existing collaborator or a Member Template for each role.',
        );
      if (row.dotId) {
        const dot = this.dot(row.dotId);
        if (!dot) throw new Error('Dot not found.');
        if (dotIds.has(dot.id))
          throw new Error('A Dot can only have one role in this project.');
        dotIds.add(dot.id);
      } else {
        const requestedDotId = row.id?.trim();
        if (requestedDotId) {
          if (this.dot(requestedDotId) || requestedDotIds.has(requestedDotId))
            throw new Error('Dot identifier is already in use.');
          requestedDotIds.add(requestedDotId);
        }
        if (!this.memberTemplate(row.memberTemplateId!))
          throw new Error('Member Template not found.');
        if (
          !row.name?.trim() ||
          row.name.trim().length > 40 ||
          (row.customization?.length ?? 0) > 1200
        )
          throw new Error(
            'Provide a valid name and customization for each new Dot.',
          );
      }
    }
    const createdAgents: SessionAgent[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'INSERT INTO spaces (id,name,description,createdAt) VALUES (?,?,?,?)',
        )
        .run(spaceId, name, input.description, now);
      this.db
        .prepare(
          'INSERT INTO master_sessions (id,spaceId,name,description,status,createdAt,updatedAt,creationKey) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          masterSessionId,
          spaceId,
          name,
          input.description,
          'active',
          now,
          now,
          key,
        );
      for (const row of input.team) {
        let dotId = row.dotId;
        if (!dotId) {
          const template = this.memberTemplate(row.memberTemplateId!)!;
          const customization = row.customization?.trim() ?? '';
          dotId = row.id?.trim() || randomUUID();
          const instructions = `${template.agentInstructions}${customization ? `\n\nPermanent owner customization:\n${customization}` : ''}`;
          this.db
            .prepare(
              `INSERT INTO dots (id,spaceId,name,instructions,researchAllowed,memoryAllowed,createdAt,learningContainerId,skillDeliveryEnabled,appsAllowed,composioToolkits) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              dotId,
              spaceId,
              row.name!.trim(),
              instructions,
              0,
              0,
              now,
              null,
              0,
              0,
              '[]',
            );
          this.db
            .prepare('INSERT INTO dot_spaces (dotId,spaceId) VALUES (?,?)')
            .run(dotId, spaceId);
          this.db
            .prepare(
              `INSERT INTO dot_profiles (dotId,summary,skills,workStyle,memberTemplateId,soulInstructions,updatedAt) VALUES (?,?,?,?,?,?,?)`,
            )
            .run(
              dotId,
              template.description,
              JSON.stringify(template.skills),
              template.soulInstructions,
              template.id,
              template.soulInstructions +
                (customization
                  ? `\n\nOwner customization: ${customization}`
                  : ''),
              now,
            );
        } else {
          // A permanent Dot may be reused by projects in other Spaces.
          this.db
            .prepare(
              'INSERT OR IGNORE INTO dot_spaces (dotId,spaceId) VALUES (?,?)',
            )
            .run(dotId, spaceId);
        }
        if (dotIds.has(dotId) && row.dotId === undefined)
          throw new Error('A Dot can only have one role in this project.');
        dotIds.add(dotId);
        const agent: SessionAgent = {
          id: randomUUID(),
          masterSessionId,
          dotId,
          role: row.role.trim(),
          displayName: null,
          status: 'active',
          mandate: row.mandate.trim(),
          soulOverride: '',
          createdAt: now,
          updatedAt: now,
        };
        this.db
          .prepare(
            `INSERT INTO session_agents (id,masterSessionId,dotId,role,displayName,status,mandate,soulOverride,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            agent.id,
            masterSessionId,
            dotId,
            agent.role,
            null,
            agent.status,
            agent.mandate,
            '',
            now,
            now,
          );
        createdAgents.push(agent);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      const duplicate = this.db
        .prepare('SELECT id FROM master_sessions WHERE creationKey=?')
        .get(key) as { id: string } | undefined;
      if (duplicate)
        return {
          masterSession: this.masterSession(duplicate.id)!,
          agents: this.sessionAgents(duplicate.id),
          dots: this.dots(),
        };
      throw error;
    }
    return {
      masterSession: this.requireMasterSession(masterSessionId),
      agents: createdAgents,
      dots: this.dots(),
    };
  }
  addOfficeProjectMember(
    masterSessionId: string,
    row: {
      dotId?: string;
      memberTemplateId?: string;
      name?: string;
      customization?: string;
      role: string;
      mandate: string;
    },
  ) {
    const master = this.requireMasterSession(masterSessionId);
    if (master.status !== 'active')
      throw new Error('Master Session is not active.');
    if (
      !row.role.trim() ||
      row.role.length > 80 ||
      !row.mandate.trim() ||
      row.mandate.length > 10000
    )
      throw new Error('Each collaborator needs a role and mandate.');
    if (!!row.dotId === !!row.memberTemplateId)
      throw new Error('Choose an existing collaborator or a Member Template.');
    const template = row.memberTemplateId
      ? this.memberTemplate(row.memberTemplateId)
      : undefined;
    if (row.memberTemplateId && !template)
      throw new Error('Member Template not found.');
    if (row.dotId && !this.dot(row.dotId)) throw new Error('Dot not found.');
    if (
      !row.dotId &&
      (!row.name?.trim() ||
        row.name.trim().length > 40 ||
        (row.customization?.length ?? 0) > 1200)
    )
      throw new Error(
        'Provide a valid name and customization for the new Dot.',
      );
    const dotId = row.dotId ?? randomUUID();
    const now = Date.now();
    const agent: SessionAgent = {
      id: randomUUID(),
      masterSessionId,
      dotId,
      role: row.role.trim(),
      displayName: null,
      status: 'active',
      mandate: row.mandate.trim(),
      soulOverride: '',
      createdAt: now,
      updatedAt: now,
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (template) {
        const customization = row.customization?.trim() ?? '';
        const instructions = `${template.agentInstructions}${customization ? `\n\nPermanent owner customization:\n${customization}` : ''}`;
        this.db
          .prepare(
            `INSERT INTO dots (id,spaceId,name,instructions,researchAllowed,memoryAllowed,createdAt,learningContainerId,skillDeliveryEnabled,appsAllowed,composioToolkits) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            dotId,
            master.spaceId,
            row.name!.trim(),
            instructions,
            0,
            0,
            now,
            null,
            0,
            0,
            '[]',
          );
        this.db
          .prepare('INSERT INTO dot_spaces (dotId,spaceId) VALUES (?,?)')
          .run(dotId, master.spaceId);
        this.db
          .prepare(
            `INSERT INTO dot_profiles (dotId,summary,skills,workStyle,memberTemplateId,soulInstructions,updatedAt) VALUES (?,?,?,?,?,?,?)`,
          )
          .run(
            dotId,
            template.description,
            JSON.stringify(template.skills),
            template.soulInstructions,
            template.id,
            template.soulInstructions +
              (customization
                ? `\n\nOwner customization: ${customization}`
                : ''),
            now,
          );
      } else {
        this.db
          .prepare(
            'INSERT OR IGNORE INTO dot_spaces (dotId,spaceId) VALUES (?,?)',
          )
          .run(dotId, master.spaceId);
      }
      this.db
        .prepare(
          `INSERT INTO session_agents (id,masterSessionId,dotId,role,displayName,status,mandate,soulOverride,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          agent.id,
          masterSessionId,
          dotId,
          agent.role,
          null,
          agent.status,
          agent.mandate,
          '',
          now,
          now,
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { agent, dot: this.dot(dotId)!, profile: this.dotProfile(dotId) };
  }
  masterSessions(): MasterSession[] {
    return this.db
      .prepare(
        'SELECT id,spaceId,name,description,status,createdAt,updatedAt FROM master_sessions ORDER BY createdAt',
      )
      .all() as unknown as MasterSession[];
  }
  masterSession(id: string): MasterSession | undefined {
    return this.db
      .prepare(
        'SELECT id,spaceId,name,description,status,createdAt,updatedAt FROM master_sessions WHERE id=?',
      )
      .get(id) as unknown as MasterSession | undefined;
  }
  createMasterSession(
    spaceId: string,
    name: string,
    description = '',
  ): MasterSession {
    if (!this.spaces().some((space) => space.id === spaceId))
      throw new Error('Space not found.');
    if (!name.trim() || name.trim().length > 120)
      throw new Error(
        'Master Session name must be between 1 and 120 characters.',
      );
    if (description.length > 4000)
      throw new Error('Master Session description exceeds 4000 characters.');
    const now = Date.now();
    const session: MasterSession = {
      id: randomUUID(),
      spaceId,
      name: name.trim(),
      description,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO master_sessions (id, spaceId, name, description, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        session.id,
        session.spaceId,
        session.name,
        session.description,
        session.status,
        now,
        now,
      );
    return session;
  }
  updateMasterSession(
    id: string,
    patch: { name?: string; description?: string },
  ): MasterSession {
    const current = this.requireMasterSession(id);
    this.ensureMasterSessionNotArchived(current);
    const name = patch.name === undefined ? current.name : patch.name.trim();
    const description = patch.description ?? current.description;
    if (!name || name.length > 120)
      throw new Error(
        'Master Session name must be between 1 and 120 characters.',
      );
    if (description.length > 4000)
      throw new Error('Master Session description exceeds 4000 characters.');
    this.db
      .prepare(
        'UPDATE master_sessions SET name=?, description=?, updatedAt=? WHERE id=?',
      )
      .run(name, description, Date.now(), id);
    return this.requireMasterSession(id);
  }
  setMasterSessionStatus(
    id: string,
    status: MasterSessionStatus,
  ): MasterSession {
    const current = this.requireMasterSession(id);
    if (current.status === 'archived' && status !== 'archived')
      throw new Error('Archived Master Sessions cannot be reactivated.');
    if (!['active', 'paused', 'archived'].includes(status))
      throw new Error('Invalid Master Session status.');
    if (current.status === status) return current;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('UPDATE master_sessions SET status=?, updatedAt=? WHERE id=?')
        .run(status, Date.now(), id);
      if (status === 'paused' || status === 'archived') {
        const conversations = this.db
          .prepare(
            `SELECT id FROM session_conversations
             WHERE masterSessionId=? AND status='active'`,
          )
          .all(id) as Array<{ id: string }>;
        for (const { id: conversationId } of conversations) {
          if (status === 'archived')
            this.db
              .prepare(
                `UPDATE session_conversations SET status='archived', updatedAt=? WHERE id=?`,
              )
              .run(Date.now(), conversationId);
          const participants = this.db
            .prepare(
              `SELECT * FROM conversation_participants
               WHERE conversationId=? AND status='active'`,
            )
            .all(conversationId) as unknown as ConversationParticipant[];
          if (current.status === 'active' || status === 'archived')
            for (const participant of participants)
              this.closeParticipantInterval(participant, 'removed');
        }
      }
      if (status === 'active' && current.status === 'paused') {
        const conversations = this.db
          .prepare(
            `SELECT id FROM session_conversations
             WHERE masterSessionId=? AND status='active'`,
          )
          .all(id) as Array<{ id: string }>;
        for (const { id: conversationId } of conversations) {
          const agents = this.sessionAgentsForConversation(
            conversationId,
          ).filter((agent) => agent.status === 'active');
          for (const agent of agents) {
            const previous = this.latestParticipantInterval(
              conversationId,
              'session_agent',
              agent.id,
            );
            if (previous?.status === 'removed')
              this.insertParticipant(
                conversationId,
                'session_agent',
                agent.id,
                'participant',
                this.currentConversationSequence(conversationId),
              );
          }
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.requireMasterSession(id);
  }
  private requireMasterSession(id: string): MasterSession {
    const session = this.masterSession(id);
    if (!session) throw new Error('Master Session not found.');
    return session;
  }
  private ensureMasterSessionNotArchived(session: MasterSession) {
    if (session.status === 'archived')
      throw new Error('Archived Master Sessions cannot be changed.');
  }
  private validateSessionConversation(
    masterSessionId: string,
    kind: OrganizationalConversationKind,
    visibility: OrganizationalConversationVisibility,
  ) {
    this.requireMasterSession(masterSessionId);
    const valid =
      (kind === 'direct' && visibility === 'private') ||
      (kind === 'group' && visibility === 'restricted') ||
      (kind === 'plenary' && visibility === 'team') ||
      (kind === 'agent_only' && visibility === 'restricted');
    if (!valid)
      throw new Error('Conversation kind and visibility are incompatible.');
  }
  private validateConversationParticipants(
    participants: Array<{
      participantType: ConversationParticipantType;
      participantId: string;
      role?: Exclude<ConversationParticipantRole, 'owner'>;
    }>,
    masterSessionId: string,
    creatorType: ConversationParticipantType,
    creatorId: string,
  ) {
    const normalized = new Map<
      string,
      {
        participantType: ConversationParticipantType;
        participantId: string;
        role: Exclude<ConversationParticipantRole, 'owner'>;
      }
    >();
    if (!Array.isArray(participants) || participants.length > 100)
      throw new Error('Conversation participant list is invalid.');
    const supplied = new Set<string>();
    for (const participant of participants) {
      if (
        participant.participantType !== 'user' &&
        participant.participantType !== 'session_agent'
      )
        throw new Error('Invalid conversation participant type.');
      const role = participant.role ?? 'participant';
      if (!['moderator', 'participant', 'observer'].includes(role))
        throw new Error('Invalid conversation participant role.');
      if (
        participant.participantType === 'user'
          ? participant.participantId !== this.ownerId
          : !this.activeSessionAgent(participant.participantId, masterSessionId)
      )
        throw new Error('Conversation participant is not authorized.');
      const key = `${participant.participantType}:${participant.participantId}`;
      if (supplied.has(key))
        throw new Error('Conversation participant list contains duplicates.');
      supplied.add(key);
      normalized.set(key, { ...participant, role });
    }
    if (!normalized.has(`${creatorType}:${creatorId}`))
      throw new Error(
        'Conversation creator must be included as a participant.',
      );
    return normalized;
  }
  private validateConversationMembershipPolicy(
    kind: OrganizationalConversationKind,
    visibility: OrganizationalConversationVisibility,
    participants: Array<{
      participantType: ConversationParticipantType;
      participantId: string;
    }>,
  ) {
    const unique = new Set(
      participants.map(
        (participant) =>
          `${participant.participantType}:${participant.participantId}`,
      ),
    );
    if (unique.size !== participants.length)
      throw new Error('Conversation participant list contains duplicates.');
    const agents = participants.filter(
      (participant) => participant.participantType === 'session_agent',
    ).length;
    if (kind === 'direct' && agents !== 1)
      throw new Error(
        'Direct conversations require exactly one Session Agent.',
      );
    if (kind === 'group' && agents < 2)
      throw new Error(
        'Group conversations require at least two Session Agents.',
      );
    if (kind === 'plenary' && visibility !== 'team')
      throw new Error('Plenary conversations must be team-visible.');
    if (kind === 'agent_only' && visibility !== 'restricted')
      throw new Error('Agent-only conversations must be restricted.');
  }
  private validateConversationShape(
    masterSessionId: string,
    kind: OrganizationalConversationKind,
    visibility: OrganizationalConversationVisibility,
    participants: Array<{
      participantType: ConversationParticipantType;
      participantId: string;
    }>,
  ) {
    this.validateSessionConversation(masterSessionId, kind, visibility);
    this.validateConversationMembershipPolicy(kind, visibility, participants);
    if (
      kind === 'plenary' &&
      this.sessionAgents(masterSessionId).some(
        (agent) =>
          agent.status === 'active' &&
          !participants.some(
            (participant) =>
              participant.participantType === 'session_agent' &&
              participant.participantId === agent.id,
          ),
      )
    )
      throw new Error(
        'Plenary conversations must include every active Session Agent.',
      );
    if (
      kind === 'agent_only' &&
      participants.some(
        (participant) => participant.participantType !== 'session_agent',
      )
    )
      throw new Error(
        'Agent-only conversations may only include Session Agents.',
      );
    if (kind === 'agent_only' && participants.length < 2)
      throw new Error(
        'Agent-only conversations require at least two Session Agents.',
      );
  }
  organizationalConversation(
    id: string,
  ): OrganizationalConversation | undefined {
    return this.db
      .prepare(
        `SELECT c.* FROM session_conversations c
         WHERE c.id=? AND c.status='active'
           AND EXISTS (
             SELECT 1 FROM conversation_participants p
             WHERE p.conversationId=c.id AND p.participantType='user'
               AND p.participantId=? AND p.status='active'
           )`,
      )
      .get(id, this.ownerId) as unknown as
      OrganizationalConversation | undefined;
  }
  listConversationsForOwner(
    masterSessionId: string,
    userId: string,
  ): OrganizationalConversation[] {
    const master = this.requireMasterSession(masterSessionId);
    if (userId !== this.ownerId || master.status !== 'active') return [];
    return this.db
      .prepare(
        `SELECT c.* FROM session_conversations c
         JOIN conversation_participants p ON p.conversationId=c.id
         WHERE c.masterSessionId=? AND c.status='active'
           AND p.participantType='user' AND p.participantId=? AND p.status='active'
         ORDER BY c.updatedAt DESC`,
      )
      .all(masterSessionId, userId) as unknown as OrganizationalConversation[];
  }
  conversationSummariesForOwner(masterSessionId: string, userId: string) {
    const conversations = this.listConversationsForOwner(
      masterSessionId,
      userId,
    ).filter((conversation) => conversation.kind !== 'agent_only');
    return conversations.map((conversation) => ({
      conversation,
      participants: this.listConversationParticipants(
        conversation.id,
        'user',
        userId,
      ).flatMap((participant) => {
        if (participant.participantType !== 'session_agent')
          return [{ ...participant, name: 'You', summary: '' }];
        const agent = this.sessionAgent(participant.participantId);
        const dot = agent && this.dot(agent.dotId);
        if (!agent || !dot) return [];
        return [
          {
            ...participant,
            name: dot.name,
            summary: this.dotProfile(dot.id).summary,
          },
        ];
      }),
      lastMessage:
        this.listConversationMessagesForUser(
          conversation.id,
          userId,
          undefined,
          1,
        )[0] ?? null,
    }));
  }
  openDirectConversationForOwner(
    masterSessionId: string,
    userId: string,
    sessionAgentId: string,
  ) {
    if (userId !== this.ownerId) throw new Error('Conversation access denied.');
    const master = this.requireMasterSession(masterSessionId);
    if (master.status !== 'active')
      throw new Error('Conversations require an active Master Session.');
    if (!this.activeSessionAgent(sessionAgentId, masterSessionId))
      throw new Error('Session Agent is not authorized for this project.');
    const existing = this.db
      .prepare(
        `SELECT c.id FROM session_conversations c
      JOIN conversation_participants u ON u.conversationId=c.id AND u.participantType='user' AND u.participantId=? AND u.status='active'
      JOIN conversation_participants a ON a.conversationId=c.id AND a.participantType='session_agent' AND a.participantId=? AND a.status='active'
      WHERE c.masterSessionId=? AND c.kind='direct' AND c.visibility='private' AND c.status='active'
      ORDER BY c.updatedAt DESC LIMIT 1`,
      )
      .get(userId, sessionAgentId, masterSessionId) as
      { id: string } | undefined;
    if (existing) return this.requireOrganizationalConversation(existing.id);
    return this.createOrganizationalConversation({
      masterSessionId,
      title: `Conversation with ${this.sessionAgent(sessionAgentId)?.displayName ?? this.dot(this.sessionAgent(sessionAgentId)!.dotId)?.name ?? 'collaborator'}`,
      kind: 'direct',
      visibility: 'private',
      createdByType: 'user',
      createdById: userId,
      participants: [
        { participantType: 'user', participantId: userId },
        { participantType: 'session_agent', participantId: sessionAgentId },
      ],
    });
  }
  private requireOrganizationalConversation(
    id: string,
  ): OrganizationalConversation {
    const conversation = this.db
      .prepare('SELECT * FROM session_conversations WHERE id=?')
      .get(id) as unknown as OrganizationalConversation | undefined;
    if (!conversation)
      throw new Error('Organizational conversation not found.');
    return conversation;
  }
  createOrganizationalConversation(input: {
    masterSessionId: string;
    title: string;
    kind: OrganizationalConversationKind;
    visibility: OrganizationalConversationVisibility;
    createdByType: ConversationParticipantType;
    createdById: string;
    participants: Array<{
      participantType: ConversationParticipantType;
      participantId: string;
      role?: Exclude<ConversationParticipantRole, 'owner'>;
    }>;
  }): OrganizationalConversation {
    if (
      !['direct', 'group', 'plenary', 'agent_only'].includes(input.kind) ||
      !['private', 'restricted', 'team'].includes(input.visibility)
    )
      throw new Error('Invalid conversation kind or visibility.');
    const master = this.requireMasterSession(input.masterSessionId);
    if (master.status !== 'active')
      throw new Error('Conversations require an active Master Session.');
    if (!input.title.trim() || input.title.trim().length > 160)
      throw new Error(
        'Conversation title must be between 1 and 160 characters.',
      );
    if (!Array.isArray(input.participants) || input.participants.length > 100)
      throw new Error('Conversation participant list is invalid.');
    if (
      input.createdByType !== 'user' &&
      input.createdByType !== 'session_agent'
    )
      throw new Error('Invalid conversation creator type.');
    const creatorIsAuthorized =
      input.createdByType === 'user'
        ? input.createdById === this.ownerId
        : !!this.activeSessionAgent(input.createdById, input.masterSessionId);
    if (!creatorIsAuthorized)
      throw new Error('Conversation creator is not authorized.');
    if (input.kind === 'agent_only' && input.createdByType !== 'session_agent')
      throw new Error(
        'Agent-only conversations require an internal agent creator.',
      );
    if (input.createdByType === 'session_agent' && input.kind !== 'agent_only')
      throw new Error(
        'Only agent-only conversations may have an agent creator.',
      );
    this.validateSessionConversation(
      input.masterSessionId,
      input.kind,
      input.visibility,
    );
    const normalized = this.validateConversationParticipants(
      input.participants,
      input.masterSessionId,
      input.createdByType,
      input.createdById,
    );
    if (
      input.createdByType === 'session_agent' &&
      (!input.participants.some(
        (participant) =>
          participant.participantType === 'session_agent' &&
          participant.participantId === input.createdById,
      ) ||
        input.kind !== 'agent_only')
    )
      throw new Error(
        'Agent creators must participate in agent-only conversations.',
      );
    if (
      input.kind === 'direct' &&
      [...normalized.values()].filter(
        (participant) => participant.participantType === 'session_agent',
      ).length !== 1
    )
      throw new Error('Direct conversations require one Session Agent.');
    if (
      input.kind === 'group' &&
      [...normalized.values()].filter(
        (participant) => participant.participantType === 'session_agent',
      ).length < 2
    )
      throw new Error(
        'Group conversations require at least two Session Agents.',
      );
    if (
      input.kind === 'agent_only' &&
      [...normalized.values()].filter(
        (participant) => participant.participantType === 'session_agent',
      ).length < 2
    )
      throw new Error(
        'Agent-only conversations require at least two Session Agents.',
      );
    if (input.kind === 'plenary') {
      const activeAgents = this.sessionAgents(input.masterSessionId).filter(
        (agent) => agent.status === 'active',
      );
      for (const agent of activeAgents)
        if (!normalized.has(`session_agent:${agent.id}`))
          normalized.set(`session_agent:${agent.id}`, {
            participantType: 'session_agent',
            participantId: agent.id,
            role: 'participant',
          });
    }
    this.validateConversationShape(
      input.masterSessionId,
      input.kind,
      input.visibility,
      [...normalized.values()],
    );
    const conversation: OrganizationalConversation = {
      id: randomUUID(),
      masterSessionId: input.masterSessionId,
      title: input.title.trim(),
      kind: input.kind,
      visibility: input.visibility,
      status: 'active',
      createdByType: input.createdByType,
      createdById: input.createdById,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const latestMaster = this.requireMasterSession(input.masterSessionId);
      if (latestMaster.status !== 'active')
        throw new Error('Conversations require an active Master Session.');
      this.db
        .prepare(
          `INSERT INTO session_conversations
           (id, masterSessionId, title, kind, visibility, status, createdByType, createdById, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          conversation.id,
          conversation.masterSessionId,
          conversation.title,
          conversation.kind,
          conversation.visibility,
          conversation.status,
          conversation.createdByType,
          conversation.createdById,
          conversation.createdAt,
          conversation.updatedAt,
        );
      for (const participant of normalized.values()) {
        const isCreator =
          participant.participantType === input.createdByType &&
          participant.participantId === input.createdById;
        this.insertParticipant(
          conversation.id,
          participant.participantType,
          participant.participantId,
          isCreator ? 'owner' : participant.role,
          0,
        );
      }
      this.linkPrimaryThreadsForConversation(conversation.id, normalized);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return conversation;
  }
  private insertParticipant(
    conversationId: string,
    participantType: ConversationParticipantType,
    participantId: string,
    role: ConversationParticipantRole,
    joinedAfterSequence: number,
  ): ConversationParticipant {
    const now = Date.now();
    const participant: ConversationParticipant = {
      id: randomUUID(),
      conversationId,
      participantType,
      participantId,
      role,
      joinedAt: now,
      joinedAfterSequence,
      leftAt: null,
      leftAfterSequence: null,
      status: 'active',
    };
    this.db
      .prepare(
        `INSERT INTO conversation_participants
         (id, conversationId, participantType, participantId, role, joinedAt, joinedAfterSequence, leftAt, leftAfterSequence, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'active')`,
      )
      .run(
        participant.id,
        participant.conversationId,
        participant.participantType,
        participant.participantId,
        participant.role,
        participant.joinedAt,
        participant.joinedAfterSequence,
      );
    return participant;
  }
  conversationParticipants(conversationId: string): ConversationParticipant[] {
    this.requireOrganizationalConversation(conversationId);
    return this.db
      .prepare(
        'SELECT * FROM conversation_participants WHERE conversationId=? ORDER BY joinedAt, id',
      )
      .all(conversationId) as unknown as ConversationParticipant[];
  }
  private activeParticipant(
    conversationId: string,
    participantType: ConversationParticipantType,
    participantId: string,
  ): ConversationParticipant | undefined {
    return this.db
      .prepare(
        `SELECT * FROM conversation_participants
         WHERE conversationId=? AND participantType=? AND participantId=? AND status='active'
         ORDER BY joinedAt DESC LIMIT 1`,
      )
      .get(conversationId, participantType, participantId) as
      ConversationParticipant | undefined;
  }
  private activeAgentMembership(
    conversation: OrganizationalConversation,
    sessionAgentId: string,
  ): ConversationParticipant | undefined {
    const agent = this.sessionAgent(sessionAgentId);
    if (
      !agent ||
      agent.masterSessionId !== conversation.masterSessionId ||
      agent.status !== 'active' ||
      !this.canAccessSpace(
        agent.dotId,
        this.requireMasterSession(conversation.masterSessionId).spaceId,
      )
    )
      return undefined;
    const participant = this.activeParticipant(
      conversation.id,
      'session_agent',
      sessionAgentId,
    );
    return participant?.status === 'active' ? participant : undefined;
  }
  private authorizeConversationParticipant(
    conversationId: string,
    participantType: ConversationParticipantType,
    participantId: string,
    options: { history?: boolean; requireActiveConversation?: boolean } = {},
  ) {
    const conversation = this.requireOrganizationalConversation(conversationId);
    if (options.requireActiveConversation)
      this.requireActiveConversation(conversation);
    const master = this.requireMasterSession(conversation.masterSessionId);
    if (master.status !== 'active')
      throw new Error('Conversation access denied.');
    if (participantType === 'user') {
      if (participantId !== this.ownerId)
        throw new Error('Conversation access denied.');
      const userInterval = this.latestParticipantInterval(
        conversationId,
        participantType,
        participantId,
      );
      if (!userInterval || userInterval.status === 'removed')
        throw new Error('Conversation access denied.');
      return { conversation, participant: userInterval };
    }
    const agent = this.sessionAgent(participantId);
    if (
      !agent ||
      agent.masterSessionId !== conversation.masterSessionId ||
      agent.status !== 'active' ||
      !this.canAccessSpace(agent.dotId, master.spaceId)
    )
      throw new Error('Conversation access denied.');
    const active = this.activeParticipant(
      conversationId,
      participantType,
      participantId,
    );
    if (active) return { conversation, participant: active };
    const previous = this.latestParticipantInterval(
      conversationId,
      participantType,
      participantId,
    );
    if (
      options.history &&
      previous?.status === 'left' &&
      conversation.status !== 'archived' &&
      this.activeSessionAgent(participantId, conversation.masterSessionId)
    )
      return { conversation, participant: previous };
    throw new Error('Conversation access denied.');
  }
  private latestParticipantInterval(
    conversationId: string,
    participantType: ConversationParticipantType,
    participantId: string,
  ): ConversationParticipant | undefined {
    return this.db
      .prepare(
        `SELECT * FROM conversation_participants
         WHERE conversationId=? AND participantType=? AND participantId=?
         ORDER BY joinedAt DESC, id DESC LIMIT 1`,
      )
      .get(conversationId, participantType, participantId) as
      ConversationParticipant | undefined;
  }
  private requireActiveConversation(conversation: OrganizationalConversation) {
    if (conversation.status !== 'active')
      throw new Error('Conversation is not active.');
    const master = this.requireMasterSession(conversation.masterSessionId);
    if (master.status !== 'active')
      throw new Error('Master Session is not active.');
  }
  private ensureConversationNotArchived(
    conversation: OrganizationalConversation,
  ) {
    if (conversation.status === 'archived')
      throw new Error('Archived conversations cannot be changed.');
  }
  private assertNoActiveThreadLeak(
    conversationId: string,
    conversation: OrganizationalConversation,
  ) {
    const participantIds = this.db
      .prepare(
        `SELECT sessionAgentId FROM conversation_threads WHERE conversationId=?`,
      )
      .all(conversationId) as Array<{ sessionAgentId: string }>;
    for (const { sessionAgentId } of participantIds) {
      if (
        !this.activeParticipant(conversationId, 'session_agent', sessionAgentId)
      )
        continue;
      const agent = this.sessionAgent(sessionAgentId);
      if (
        !agent ||
        agent.masterSessionId !== conversation.masterSessionId ||
        agent.status !== 'active' ||
        !this.canAccessSpace(
          agent.dotId,
          this.requireMasterSession(conversation.masterSessionId).spaceId,
        )
      )
        throw new Error(
          'Conversation thread visibility is no longer authorized.',
        );
    }
  }
  private sessionAgentsForConversation(conversationId: string) {
    const masterId =
      this.requireOrganizationalConversation(conversationId).masterSessionId;
    return this.sessionAgents(masterId);
  }
  private participantStillAuthorized(participant: ConversationParticipant) {
    if (participant.participantType === 'user')
      return participant.participantId === this.ownerId;
    const agent = this.sessionAgent(participant.participantId);
    return (
      agent?.masterSessionId ===
        this.requireOrganizationalConversation(participant.conversationId)
          .masterSessionId &&
      agent.status === 'active' &&
      this.canAccessSpace(
        agent.dotId,
        this.requireMasterSession(
          this.requireOrganizationalConversation(participant.conversationId)
            .masterSessionId,
        ).spaceId,
      )
    );
  }
  private agentCanSeeConversation(
    conversation: OrganizationalConversation,
    sessionAgentId: string,
  ) {
    const agent = this.sessionAgent(sessionAgentId);
    if (
      !agent ||
      agent.masterSessionId !== conversation.masterSessionId ||
      agent.status !== 'active' ||
      !this.canAccessSpace(
        agent.dotId,
        this.requireMasterSession(conversation.masterSessionId).spaceId,
      )
    )
      return false;
    const participant = this.activeParticipant(
      conversation.id,
      'session_agent',
      sessionAgentId,
    );
    if (
      participant &&
      participant.status === 'active' &&
      (conversation.visibility !== 'private' ||
        participant.participantId === sessionAgentId)
    )
      return true;
    return false;
  }
  listUserConversations(masterSessionId: string, userId: string) {
    const master = this.requireMasterSession(masterSessionId);
    if (userId !== this.ownerId || master.status !== 'active') return [];
    return this.db
      .prepare(
        `SELECT DISTINCT c.* FROM session_conversations c
         JOIN conversation_participants p ON p.conversationId=c.id
         WHERE c.masterSessionId=? AND p.participantType='user'
           AND p.participantId=? AND p.status IN ('active', 'left')
         ORDER BY c.updatedAt DESC`,
      )
      .all(masterSessionId, userId)
      .filter(
        (row) => row.status === 'active',
      ) as unknown as OrganizationalConversation[];
  }
  organizationalConversationForParticipant(
    conversationId: string,
    participantType: ConversationParticipantType,
    participantId: string,
  ): OrganizationalConversation {
    const { conversation } = this.authorizeConversationParticipant(
      conversationId,
      participantType,
      participantId,
      { history: true },
    );
    if (conversation.status !== 'active')
      throw new Error('Conversation access denied.');
    this.assertNoActiveThreadLeak(conversationId, conversation);
    return conversation;
  }
  addConversationParticipant(
    conversationId: string,
    requesterType: 'user',
    requesterId: string,
    participantType: ConversationParticipantType,
    participantId: string,
    role: Exclude<ConversationParticipantRole, 'owner'> = 'participant',
    allowPrivateRejoin = false,
  ): ConversationParticipant {
    const conversation = this.organizationalConversationForParticipant(
      conversationId,
      requesterType,
      requesterId,
    );
    this.ensureConversationNotArchived(conversation);
    this.requireActiveConversation(conversation);
    if (conversation.kind === 'plenary' && participantType === 'session_agent')
      throw new Error(
        'Plenary membership is managed by Master Session membership.',
      );
    const requester = this.activeParticipant(
      conversationId,
      requesterType,
      requesterId,
    )!;
    if (!['owner', 'moderator'].includes(requester.role))
      throw new Error(
        'Only conversation owners or moderators may add participants.',
      );
    const existing = this.activeParticipant(
      conversationId,
      participantType,
      participantId,
    );
    if (existing) return existing;
    const priorInterval = this.latestParticipantInterval(
      conversationId,
      participantType,
      participantId,
    );
    if (
      participantType === 'session_agent' &&
      priorInterval?.status === 'left' &&
      !allowPrivateRejoin
    )
      throw new Error('Left participants must use the rejoin operation.');
    if (
      participantType === 'user'
        ? participantId !== this.ownerId
        : !this.activeSessionAgent(participantId, conversation.masterSessionId)
    )
      throw new Error('Conversation participant is not authorized.');
    if (
      conversation.visibility === 'private' &&
      participantType === 'session_agent' &&
      !this.activeParticipant(conversationId, 'session_agent', participantId) &&
      priorInterval?.status !== 'left' &&
      !allowPrivateRejoin
    )
      throw new Error('Private conversations cannot add new agents.');
    if (participantType === 'session_agent') {
      const targetAgent = this.sessionAgent(participantId);
      if (!targetAgent || targetAgent.status !== 'active')
        throw new Error('Conversation participant is not authorized.');
    }
    if (priorInterval?.status === 'removed')
      throw new Error('Removed participants cannot be re-added.');
    if (conversation.kind === 'agent_only')
      throw new Error(
        'Agent-only participants must be created by an internal context.',
      );
    const currentParticipants = this.conversationParticipants(conversationId)
      .filter((participant) => participant.status === 'active')
      .map((participant) => ({
        participantType: participant.participantType,
        participantId: participant.participantId,
      }));
    currentParticipants.push({ participantType, participantId });
    const checkedParticipants = currentParticipants.filter(
      (participant, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.participantType === participant.participantType &&
            candidate.participantId === participant.participantId,
        ) === index,
    );
    if (
      conversation.visibility === 'private' &&
      participantType === 'session_agent'
    ) {
      if (
        conversation.kind !== 'direct' ||
        currentParticipants.filter(
          (participant) => participant.participantType === 'session_agent',
        ).length !== 1
      )
        throw new Error('Private conversations cannot add new agents.');
    } else
      this.validateConversationShape(
        conversation.masterSessionId,
        conversation.kind,
        conversation.visibility,
        checkedParticipants,
      );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const sequence = this.currentConversationSequence(conversationId);
      const participant = this.insertParticipant(
        conversationId,
        participantType,
        participantId,
        role,
        sequence,
      );
      this.db
        .prepare('UPDATE session_conversations SET updatedAt=? WHERE id=?')
        .run(Date.now(), conversationId);
      if (participantType === 'session_agent') {
        this.db
          .prepare(
            `DELETE FROM conversation_threads
             WHERE conversationId=? AND sessionAgentId=?`,
          )
          .run(conversationId, participantId);
        const activeMemberships = this.db
          .prepare(
            `SELECT p.conversationId, c.kind, c.visibility
             FROM conversation_participants p
             JOIN session_conversations c ON c.id=p.conversationId
             WHERE p.participantType='session_agent' AND p.participantId=?
               AND p.status='active' AND c.status='active'`,
          )
          .all(participantId) as Array<{
          conversationId: string;
          kind: OrganizationalConversationKind;
          visibility: OrganizationalConversationVisibility;
        }>;
        for (const existingConversation of activeMemberships) {
          if (
            existingConversation.kind === 'plenary' &&
            existingConversation.visibility === 'team'
          ) {
            const activePrincipal = this.activeParticipant(
              existingConversation.conversationId,
              'session_agent',
              participantId,
            );
            if (!activePrincipal) {
              const prior = this.latestParticipantInterval(
                existingConversation.conversationId,
                'session_agent',
                participantId,
              );
              this.insertParticipant(
                existingConversation.conversationId,
                'session_agent',
                participantId,
                prior?.role === 'moderator' ? 'moderator' : 'participant',
                this.currentConversationSequence(
                  existingConversation.conversationId,
                ),
              );
            }
          }
        }
      }
      this.linkPrimaryThreadsForConversation(
        conversationId,
        new Map([
          [
            `${participant.participantType}:${participant.participantId}`,
            participant,
          ],
        ]),
      );
      this.db.exec('COMMIT');
      return participant;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  setConversationParticipantRole(
    conversationId: string,
    requesterId: string,
    participantId: string,
    role: Exclude<ConversationParticipantRole, 'owner'>,
  ): ConversationParticipant {
    const conversation = this.organizationalConversationForParticipant(
      conversationId,
      'user',
      requesterId,
    );
    this.ensureConversationNotArchived(conversation);
    this.requireActiveConversation(conversation);
    const requester = this.activeParticipant(
      conversationId,
      'user',
      requesterId,
    )!;
    if (requester.role !== 'owner' || requester.participantType !== 'user')
      throw new Error(
        'Only the conversation owner may change participant roles.',
      );
    const conversationAgent = this.sessionAgent(participantId);
    if (
      !conversationAgent ||
      conversationAgent.masterSessionId !== conversation.masterSessionId ||
      !this.activeParticipant(conversationId, 'session_agent', participantId)
    )
      throw new Error(
        'Only an active conversation participant may be a moderator.',
      );
    const target = this.activeParticipant(
      conversationId,
      'session_agent',
      participantId,
    );
    if (!target) throw new Error('Conversation participant not found.');
    this.db
      .prepare('UPDATE conversation_participants SET role=? WHERE id=?')
      .run(role, target.id);
    return {
      ...target,
      role,
    };
  }
  leaveConversation(
    conversationId: string,
    requesterType: ConversationParticipantType,
    requesterId: string,
  ): void {
    const { conversation, participant } = this.authorizeConversationParticipant(
      conversationId,
      requesterType,
      requesterId,
      { requireActiveConversation: true },
    );
    this.ensureConversationNotArchived(conversation);
    if (participant.status !== 'active')
      throw new Error('Conversation access denied.');
    if (requesterType === 'session_agent' && participant.role === 'owner')
      throw new Error('Transfer conversation ownership before leaving.');
    if (participant.role === 'owner')
      throw new Error('Transfer conversation ownership before leaving.');
    this.closeParticipantInterval(participant);
    // Keep the historical link so the agent can continue reading messages
    // from its authorized interval. Thread listings still expose active links only.
  }
  removeConversationParticipant(
    conversationId: string,
    requesterId: string,
    participantId: string,
  ): void {
    const conversation = this.organizationalConversationForParticipant(
      conversationId,
      'user',
      requesterId,
    );
    this.ensureConversationNotArchived(conversation);
    this.requireActiveConversation(conversation);
    const requester = this.activeParticipant(
      conversationId,
      'user',
      requesterId,
    )!;
    if (!['owner', 'moderator'].includes(requester.role))
      throw new Error(
        'Only conversation owners or moderators may remove participants.',
      );
    const target = this.activeParticipant(
      conversationId,
      'session_agent',
      participantId,
    );
    if (!target) throw new Error('Conversation participant not found.');
    if (target.role === 'owner')
      throw new Error('The conversation owner cannot be removed.');
    this.closeParticipantInterval(target, 'removed');
    this.db
      .prepare(
        'DELETE FROM conversation_threads WHERE conversationId=? AND sessionAgentId=?',
      )
      .run(conversationId, participantId);
  }
  private closeParticipantInterval(
    participant: ConversationParticipant,
    status: 'left' | 'removed' = 'left',
  ) {
    const close = () => {
      const sequence = this.currentConversationSequence(
        participant.conversationId,
      );
      this.db
        .prepare(
          `UPDATE conversation_participants
           SET status=?, leftAt=?, leftAfterSequence=?
           WHERE id=? AND status='active'`,
        )
        .run(status, Date.now(), sequence, participant.id);
    };
    if (this.db.isTransaction) {
      close();
      return;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      close();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  rejoinConversation(
    conversationId: string,
    requesterType: ConversationParticipantType,
    requesterId: string,
  ): ConversationParticipant {
    const conversation = this.requireOrganizationalConversation(conversationId);
    this.requireActiveConversation(conversation);
    if (requesterType === 'user' && requesterId !== this.ownerId)
      throw new Error('Conversation access denied.');
    if (
      requesterType === 'session_agent' &&
      !this.activeSessionAgent(requesterId, conversation.masterSessionId)
    )
      throw new Error('Conversation access denied.');
    if (this.activeParticipant(conversationId, requesterType, requesterId))
      throw new Error('Conversation participant is already active.');
    const previous = this.latestParticipantInterval(
      conversationId,
      requesterType,
      requesterId,
    );
    if (
      requesterType === 'session_agent' &&
      conversation.visibility === 'private' &&
      previous?.status !== 'left'
    )
      throw new Error('Removed agents cannot rejoin private conversations.');
    const role: ConversationParticipantRole =
      previous?.role === 'owner'
        ? 'owner'
        : previous?.role === 'moderator'
          ? 'moderator'
          : previous?.role === 'observer'
            ? 'observer'
            : 'participant';
    if (
      requesterType === 'session_agent' &&
      conversation.visibility === 'private' &&
      previous?.status !== 'left'
    )
      throw new Error('Removed agents cannot rejoin private conversations.');
    return this.addConversationParticipant(
      conversationId,
      'user',
      this.ownerId,
      requesterType,
      requesterId,
      role === 'owner' ? 'participant' : role,
      true,
    );
  }
  closeOrganizationalConversation(
    conversationId: string,
    requesterId: string,
    status: Exclude<OrganizationalConversationStatus, 'active'>,
  ): OrganizationalConversation {
    if (status !== 'archived' && status !== 'closed')
      throw new Error('Invalid conversation status.');
    const conversation = this.organizationalConversationForParticipant(
      conversationId,
      'user',
      requesterId,
    );
    const participant = this.activeParticipant(
      conversationId,
      'user',
      requesterId,
    )!;
    this.requireActiveConversation(conversation);
    if (!['owner', 'moderator'].includes(participant.role))
      throw new Error('Only conversation owners or moderators may close it.');
    if (conversation.status !== 'active')
      throw new Error('Archived conversations cannot be changed.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'UPDATE session_conversations SET status=?, updatedAt=? WHERE id=?',
        )
        .run(status, Date.now(), conversationId);
      if (status === 'archived') {
        const active = this.db
          .prepare(
            `SELECT * FROM conversation_participants
             WHERE conversationId=? AND status='active'`,
          )
          .all(conversationId) as unknown as ConversationParticipant[];
        for (const participant of active)
          this.closeParticipantInterval(participant, 'removed');
      }
      this.db.exec('COMMIT');
      return this.requireOrganizationalConversation(conversationId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  transferConversationOwnership(
    conversationId: string,
    currentOwnerId: string,
    nextOwnerId: string,
  ): ConversationParticipant {
    const conversation = this.organizationalConversationForParticipant(
      conversationId,
      'user',
      currentOwnerId,
    );
    this.requireActiveConversation(conversation);
    const current = this.activeParticipant(
      conversationId,
      'user',
      currentOwnerId,
    )!;
    if (current.role !== 'owner')
      throw new Error('Only the conversation owner may transfer ownership.');
    const next = this.activeParticipant(
      conversationId,
      'session_agent',
      nextOwnerId,
    );
    if (!next) throw new Error('Conversation participant not found.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.db.prepare(
        'UPDATE conversation_participants SET role=? WHERE id=?',
      );
      update.run('participant', current.id);
      update.run('owner', next.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { ...next, role: 'owner' };
  }
  listConversationThreadsForParticipant(
    conversationId: string,
    requesterType: ConversationParticipantType,
    requesterId: string,
  ): ConversationThreadLink[] {
    const { conversation } = this.authorizeConversationParticipant(
      conversationId,
      requesterType,
      requesterId,
      { history: true },
    );
    if (requesterType === 'session_agent' && conversation.status !== 'active')
      throw new Error('Conversation access denied.');
    if (
      requesterType === 'session_agent' &&
      !this.activeAgentMembership(conversation, requesterId)
    )
      throw new Error('Conversation access denied.');
    return this.db
      .prepare(
        `SELECT ct.* FROM conversation_threads ct
         JOIN conversation_participants p
           ON p.conversationId=ct.conversationId
          AND p.participantType='session_agent'
          AND p.participantId=ct.sessionAgentId
         WHERE ct.conversationId=? AND p.status='active'
           AND p.leftAfterSequence IS NULL
         ORDER BY ct.linkedAt`,
      )
      .all(conversationId) as unknown as ConversationThreadLink[];
  }
  private linkPrimaryThreadsForConversation(
    conversationId: string,
    participants: Map<
      string,
      {
        participantType: ConversationParticipantType;
        participantId: string;
      }
    >,
  ) {
    for (const participant of participants.values()) {
      if (participant.participantType !== 'session_agent') continue;
      const primary = this.db
        .prepare(
          'SELECT threadId FROM session_threads WHERE sessionAgentId=? AND isPrimary=1',
        )
        .get(participant.participantId);
      if (!primary) continue;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO conversation_threads
           (conversationId, sessionAgentId, threadId, linkedAt)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          conversationId,
          participant.participantId,
          primary.threadId,
          Date.now(),
        );
    }
  }
  conversationThreads(
    conversationId: string,
    requesterType: ConversationParticipantType,
    requesterId: string,
  ): ConversationThreadLink[] {
    return this.listConversationThreadsForParticipant(
      conversationId,
      requesterType,
      requesterId,
    );
  }
  addConversationThread(
    conversationId: string,
    requesterId: string,
    sessionAgentId: string,
    threadId: string,
  ): ConversationThreadLink {
    const conversation = this.requireOrganizationalConversation(conversationId);
    const requester = this.activeParticipant(
      conversationId,
      'user',
      requesterId,
    );
    if (
      requesterId !== this.ownerId ||
      !requester ||
      requester.status !== 'active' ||
      !this.participantStillAuthorized(requester)
    )
      throw new Error('Conversation access denied.');
    this.requireActiveConversation(conversation);
    if (!requester || !['owner', 'moderator'].includes(requester.role))
      throw new Error(
        'Only conversation owners or moderators may link threads.',
      );
    const agent = this.activeSessionAgent(
      sessionAgentId,
      conversation.masterSessionId,
    );
    if (!agent || !this.activeAgentMembership(conversation, sessionAgentId))
      throw new Error('Session Agent is not authorized for this conversation.');
    const thread = this.requireHumanThread(threadId, agent.dotId);
    const link: ConversationThreadLink = {
      conversationId,
      sessionAgentId,
      threadId: thread.id,
      linkedAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO conversation_threads
         (conversationId, sessionAgentId, threadId, linkedAt) VALUES (?, ?, ?, ?)`,
      )
      .run(
        link.conversationId,
        link.sessionAgentId,
        link.threadId,
        link.linkedAt,
      );
    return link;
  }
  createInternalAgentConversation(input: {
    masterSessionId: string;
    sessionAgentId: string;
    title: string;
    kind: 'agent_only';
    participants: Array<{
      participantType: 'session_agent';
      participantId: string;
      role?: Exclude<ConversationParticipantRole, 'owner'>;
    }>;
    verifiedExecution: { threadId: string; turnId: string };
  }) {
    const creator = this.activeSessionAgent(
      input.sessionAgentId,
      input.masterSessionId,
    );
    if (!creator) throw new Error('Agent execution identity is not active.');
    this.verifyAgentExecutionTurn(
      input.sessionAgentId,
      input.verifiedExecution,
    );
    this.requireThread(input.verifiedExecution.threadId, creator.dotId);
    return this.createOrganizationalConversation({
      masterSessionId: input.masterSessionId,
      title: input.title,
      kind: input.kind,
      visibility: 'restricted',
      createdByType: 'session_agent',
      createdById: input.sessionAgentId,
      participants: [
        ...input.participants,
        ...(input.participants.some(
          (participant) => participant.participantId === input.sessionAgentId,
        )
          ? []
          : [
              {
                participantType: 'session_agent' as const,
                participantId: input.sessionAgentId,
              },
            ]),
      ],
    });
  }
  verifyAgentExecutionTurn(
    sessionAgentId: string,
    execution: { threadId: string; turnId: string },
  ) {
    const agent = this.sessionAgent(sessionAgentId);
    if (!agent || agent.status !== 'active')
      throw new Error('Agent execution identity is not active.');
    this.requireThread(execution.threadId, agent.dotId);
    if (!execution.turnId.trim() || execution.turnId.length > 200)
      throw new Error('Agent execution turn is invalid.');
    if (
      !this.db
        .prepare(
          `SELECT 1 FROM session_threads
           WHERE sessionAgentId=? AND threadId=?`,
        )
        .get(sessionAgentId, execution.threadId)
    )
      throw new Error(
        'Execution thread is not associated with this Session Agent.',
      );
  }
  private assertThreadLinkedToConversation(
    conversationId: string,
    sessionAgentId: string,
    threadId: string,
  ) {
    if (
      !this.db
        .prepare(
          `SELECT 1 FROM conversation_threads
           WHERE conversationId=? AND sessionAgentId=? AND threadId=?`,
        )
        .get(conversationId, sessionAgentId, threadId)
    )
      throw new Error('Execution thread is not linked to this conversation.');
  }
  private authorizeInternalAgent(
    conversationId: string,
    sessionAgentId: string,
  ) {
    const conversation = this.requireOrganizationalConversation(conversationId);
    if (!this.agentCanSeeConversation(conversation, sessionAgentId))
      throw new Error('Conversation access denied.');
    return conversation;
  }
  listConversationParticipants(
    conversationId: string,
    requesterType: ConversationParticipantType,
    requesterId: string,
  ) {
    const { conversation } = this.authorizeConversationParticipant(
      conversationId,
      requesterType,
      requesterId,
      { history: true },
    );
    if (
      requesterType === 'session_agent' &&
      !this.activeAgentMembership(conversation, requesterId)
    )
      throw new Error('Conversation access denied.');
    return this.conversationParticipants(conversationId).filter(
      (participant) => participant.status === 'active',
    );
  }
  listConversationMessagesForAgent(
    conversationId: string,
    sessionAgentId: string,
    execution: { threadId: string; turnId: string },
    beforeSequence?: number,
    limit = 50,
  ) {
    const { conversation } = this.authorizeConversationParticipant(
      conversationId,
      'session_agent',
      sessionAgentId,
      { history: true },
    );
    if (!this.activeSessionAgent(sessionAgentId, conversation.masterSessionId))
      throw new Error('Conversation access denied.');
    this.verifyAgentExecutionTurn(sessionAgentId, execution);
    this.assertThreadLinkedToConversation(
      conversationId,
      sessionAgentId,
      execution.threadId,
    );
    return this.listConversationMessagesAuthorized(
      conversationId,
      'session_agent',
      sessionAgentId,
      beforeSequence,
      limit,
    );
  }
  appendUserConversationMessage(input: {
    conversationId: string;
    userId: string;
    content: string;
    contentType?: 'text' | 'json';
    visibility?: 'conversation' | 'participants';
    idempotencyKey?: string | null;
    sourceThreadId?: string;
  }): OrganizationalMessage {
    if (input.userId !== this.ownerId)
      throw new Error(
        'Only the authenticated workspace owner may send as user.',
      );
    const { conversation } = this.authorizeConversationParticipant(
      input.conversationId,
      'user',
      input.userId,
    );
    if (conversation.status !== 'active')
      throw new Error('Conversation is not active.');
    if (input.sourceThreadId) {
      const thread = this.requireThread(input.sourceThreadId);
      const linked = this.db
        .prepare(
          `SELECT 1 FROM conversation_threads ct
           JOIN conversation_participants p
             ON p.conversationId=ct.conversationId
            AND p.participantType='session_agent'
            AND p.participantId=ct.sessionAgentId
           JOIN session_agents a
             ON a.id=p.participantId
           WHERE ct.conversationId=? AND ct.threadId=? AND p.status='active'
             AND a.status='active'`,
        )
        .get(input.conversationId, thread.id);
      if (!linked)
        throw new Error('Source thread is not linked to this conversation.');
    }
    return this.appendConversationMessage(
      {
        ...input,
        senderType: 'user',
        senderId: input.userId,
      },
      false,
    );
  }
  appendAgentConversationMessage(input: {
    conversationId: string;
    sessionAgentId: string;
    execution: { threadId: string; turnId: string };
    content: string;
    contentType?: 'text' | 'json';
    visibility?: 'conversation' | 'participants';
    idempotencyKey?: string | null;
  }): OrganizationalMessage {
    this.verifyAgentExecutionTurn(input.sessionAgentId, input.execution);
    const { conversation } = this.authorizeConversationParticipant(
      input.conversationId,
      'session_agent',
      input.sessionAgentId,
    );
    this.requireActiveConversation(conversation);
    if (!this.activeAgentMembership(conversation, input.sessionAgentId))
      throw new Error('Conversation access denied.');
    const participant = this.activeAgentMembership(
      conversation,
      input.sessionAgentId,
    );
    if (!participant) throw new Error('Conversation access denied.');
    if (
      participant.joinedAfterSequence >
      this.currentConversationSequence(input.conversationId)
    )
      throw new Error('Conversation access denied.');
    return this.appendConversationMessage(
      {
        conversationId: input.conversationId,
        senderType: 'session_agent',
        senderId: input.sessionAgentId,
        content: input.content,
        contentType: input.contentType,
        visibility: input.visibility,
        sourceThreadId: input.execution.threadId,
        sourceTurnId: input.execution.turnId,
        idempotencyKey: input.idempotencyKey,
      },
      true,
    );
  }
  private appendConversationMessage(
    input: {
      conversationId: string;
      senderType: ConversationParticipantType;
      senderId: string;
      content: string;
      contentType?: 'text' | 'json';
      visibility?: 'conversation' | 'participants';
      sourceThreadId?: string | null;
      sourceTurnId?: string | null;
      idempotencyKey?: string | null;
    },
    internalAgent: boolean,
  ): OrganizationalMessage {
    if (!input.content.trim() || input.content.length > 20000)
      throw new Error(
        'Message content must be between 1 and 20000 characters.',
      );
    if (
      input.idempotencyKey !== undefined &&
      input.idempotencyKey !== null &&
      (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200)
    )
      throw new Error('Invalid message idempotency key.');
    if (internalAgent) {
      const agent = this.sessionAgent(input.senderId);
      if (!agent || !input.sourceThreadId || !input.sourceTurnId)
        throw new Error(
          'Agent messages require verified execution provenance.',
        );
      this.verifyAgentExecutionTurn(input.senderId, {
        threadId: input.sourceThreadId,
        turnId: input.sourceTurnId,
      });
    }
    const conversation = this.requireOrganizationalConversation(
      input.conversationId,
    );
    this.requireActiveConversation(conversation);
    this.assertNoActiveThreadLeak(input.conversationId, conversation);
    const participant = this.activeParticipant(
      input.conversationId,
      input.senderType,
      input.senderId,
    );
    const currentSequence = this.currentConversationSequence(
      input.conversationId,
    );
    if (
      !participant ||
      !this.participantStillAuthorized(participant) ||
      participant.joinedAfterSequence > currentSequence ||
      (participant.participantType === 'user' &&
        participant.role === 'owner' &&
        conversation.createdByType !== 'user')
    )
      throw new Error('Conversation access denied.');
    if (
      input.senderType === 'user' &&
      participant.role === 'owner' &&
      conversation.createdByType !== 'user'
    )
      throw new Error('Conversation access denied.');
    if (input.senderType === 'session_agent' && !internalAgent)
      throw new Error('Agent messages require a verified internal execution.');
    if (
      input.senderType === 'session_agent' &&
      !this.activeSessionAgent(input.senderId, conversation.masterSessionId)
    )
      throw new Error('Agent execution identity is not active.');
    this.validateMessageVisibility(
      conversation,
      participant,
      input.visibility ?? 'conversation',
    );
    if (input.sourceThreadId) {
      const sourceThread = this.requireThread(input.sourceThreadId);
      if (input.senderType === 'session_agent') {
        if (
          sourceThread.dotId !== this.sessionAgent(input.senderId)?.dotId ||
          !this.db
            .prepare(
              `SELECT 1 FROM conversation_threads
               WHERE conversationId=? AND sessionAgentId=? AND threadId=?`,
            )
            .get(input.conversationId, input.senderId, sourceThread.id)
        )
          throw new Error(
            'Source thread is not authorized for this conversation.',
          );
      }
    }
    if (!!input.sourceTurnId !== !!input.sourceThreadId)
      throw new Error('A source turn requires a source thread and vice versa.');
    return this.withConversationWriteLock(input.conversationId, () => {
      const latestParticipant = this.activeParticipant(
        input.conversationId,
        input.senderType,
        input.senderId,
      );
      if (
        !latestParticipant ||
        latestParticipant.id !== participant.id ||
        !this.participantStillAuthorized(latestParticipant)
      )
        throw new Error('Conversation access denied.');
      const existing =
        input.idempotencyKey == null
          ? undefined
          : this.db
              .prepare(
                'SELECT * FROM conversation_messages WHERE conversationId=? AND idempotencyKey=?',
              )
              .get(input.conversationId, input.idempotencyKey);
      if (existing) {
        if (
          existing.senderType !== input.senderType ||
          existing.senderId !== input.senderId
        )
          throw new Error('Idempotency key belongs to a different sender.');
        if (
          input.content !== existing.content ||
          (input.contentType ?? 'text') !== existing.contentType ||
          (input.visibility ??
            (conversation.kind === 'agent_only'
              ? 'participants'
              : 'conversation')) !== existing.visibility ||
          (input.sourceThreadId ?? null) !== existing.sourceThreadId ||
          (input.sourceTurnId ?? null) !== existing.sourceTurnId
        )
          throw new Error(
            'Idempotency key was reused with different message content.',
          );
        return existing as unknown as OrganizationalMessage;
      }
      const sequence =
        this.currentConversationSequence(input.conversationId) + 1;
      const message: OrganizationalMessage = {
        id: randomUUID(),
        conversationId: input.conversationId,
        sequenceNumber: sequence,
        senderType: input.senderType,
        senderId: input.senderId,
        content: input.content,
        contentType: input.contentType ?? 'text',
        createdAt: Date.now(),
        visibility:
          input.visibility ??
          (conversation.kind === 'agent_only'
            ? 'participants'
            : 'conversation'),
        sourceThreadId: input.sourceThreadId ?? null,
        sourceTurnId: input.sourceTurnId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      };
      this.db
        .prepare(
          `INSERT INTO conversation_messages
           (id, conversationId, sequenceNumber, senderType, senderId, content, contentType, createdAt, visibility, sourceThreadId, sourceTurnId, idempotencyKey)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          message.conversationId,
          message.sequenceNumber,
          message.senderType,
          message.senderId,
          message.content,
          message.contentType,
          message.createdAt,
          message.visibility,
          message.sourceThreadId,
          message.sourceTurnId,
          message.idempotencyKey,
        );
      this.db
        .prepare('UPDATE session_conversations SET updatedAt=? WHERE id=?')
        .run(message.createdAt, input.conversationId);
      if (message.senderType === 'session_agent')
        this.db
          .prepare(
            `INSERT OR IGNORE INTO conversation_threads
             (conversationId, sessionAgentId, threadId, linkedAt)
             VALUES (?, ?, ?, ?)`,
          )
          .run(
            input.conversationId,
            message.senderId,
            message.sourceThreadId,
            message.createdAt,
          );
      return message;
    });
  }
  private currentConversationSequence(conversationId: string): number {
    return Number(
      this.db
        .prepare(
          'SELECT COALESCE(MAX(sequenceNumber), 0) AS sequence FROM conversation_messages WHERE conversationId=?',
        )
        .get(conversationId)?.sequence ?? 0,
    );
  }
  private validateMessageVisibility(
    conversation: OrganizationalConversation,
    participant: ConversationParticipant,
    visibility: 'conversation' | 'participants',
  ) {
    if (
      visibility === 'participants' &&
      (conversation.kind !== 'agent_only' ||
        participant.participantType !== 'session_agent')
    )
      throw new Error(
        'Participant-only messages are reserved for agent-only conversations.',
      );
  }
  private withConversationWriteLock<T>(
    conversationId: string,
    operation: () => T,
  ): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  listConversationMessages(
    conversationId: string,
    requesterType: ConversationParticipantType,
    requesterId: string,
    beforeSequence?: number,
    limit = 50,
  ): OrganizationalMessage[] {
    const conversation = this.requireOrganizationalConversation(conversationId);
    if (
      requesterType === 'session_agent' &&
      (conversation.kind === 'agent_only' ||
        !this.activeParticipant(conversationId, requesterType, requesterId))
    )
      throw new Error('Conversation access denied.');
    return this.listConversationMessagesAuthorized(
      conversationId,
      requesterType,
      requesterId,
      beforeSequence,
      limit,
    );
  }
  listConversationMessagesForUser(
    conversationId: string,
    ownerId: string,
    beforeSequence?: number,
    limit = 50,
  ) {
    if (ownerId !== this.ownerId)
      throw new Error('Conversation access denied.');
    return this.listConversationMessages(
      conversationId,
      'user',
      ownerId,
      beforeSequence,
      limit,
    );
  }
  private listConversationMessagesAuthorized(
    conversationId: string,
    requesterType: ConversationParticipantType,
    requesterId: string,
    beforeSequence?: number,
    limit = 50,
  ): OrganizationalMessage[] {
    const { conversation, participant } = this.authorizeConversationParticipant(
      conversationId,
      requesterType,
      requesterId,
      { history: true },
    );
    if (conversation.status === 'archived')
      throw new Error('Conversation is archived.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Message page size must be between 1 and 100.');
    if (
      beforeSequence !== undefined &&
      (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)
    )
      throw new Error('Invalid message cursor.');
    this.assertNoActiveThreadLeak(conversationId, conversation);
    const historyIntervals = this.db
      .prepare(
        `SELECT id, joinedAfterSequence, leftAfterSequence, status FROM conversation_participants
         WHERE conversationId=? AND participantType=? AND participantId=?
         ORDER BY joinedAfterSequence, id`,
      )
      .all(conversationId, requesterType, requesterId) as Array<{
      id: string;
      joinedAfterSequence: number;
      leftAfterSequence: number | null;
      status: string;
    }>;
    const maxSequence = this.currentConversationSequence(conversationId);
    const cutoffExclusive =
      beforeSequence === undefined
        ? maxSequence + 1
        : Math.min(beforeSequence, maxSequence + 1);
    const messages: OrganizationalMessage[] = [];
    for (const interval of historyIntervals) {
      if (interval.status === 'removed') continue;
      if (interval.status === 'active' && interval.id !== participant.id)
        continue;
      const upper =
        interval.leftAfterSequence === null
          ? cutoffExclusive
          : Math.min(cutoffExclusive, interval.leftAfterSequence + 1);
      const lower = interval.joinedAfterSequence + 1;
      if (upper <= lower) continue;
      const rows = this.db
        .prepare(
          `SELECT * FROM conversation_messages
           WHERE conversationId=? AND sequenceNumber>=? AND sequenceNumber<?
             AND visibility=?
           ORDER BY sequenceNumber DESC LIMIT ?`,
        )
        .all(
          conversationId,
          lower,
          upper,
          requesterType === 'session_agent' &&
            conversation.kind === 'agent_only'
            ? 'participants'
            : 'conversation',
          limit,
        ) as unknown as OrganizationalMessage[];
      messages.push(...rows);
    }
    const uniqueMessages = [
      ...new Map(
        messages.map((message) => [message.sequenceNumber, message]),
      ).values(),
    ].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    return uniqueMessages.slice(-limit);
  }
  sessionAgents(masterSessionId: string): SessionAgent[] {
    this.requireMasterSession(masterSessionId);
    return this.db
      .prepare(
        'SELECT * FROM session_agents WHERE masterSessionId=? ORDER BY createdAt',
      )
      .all(masterSessionId) as unknown as SessionAgent[];
  }
  sessionAgent(id: string): SessionAgent | undefined {
    return this.db
      .prepare('SELECT * FROM session_agents WHERE id=?')
      .get(id) as unknown as SessionAgent | undefined;
  }
  private activeSessionAgent(id: string, masterSessionId: string) {
    const agent = this.sessionAgent(id);
    return agent?.masterSessionId === masterSessionId &&
      agent.status === 'active'
      ? agent
      : undefined;
  }
  addSessionAgent(
    masterSessionId: string,
    dotId: string,
    role: string,
    mandate: string,
    displayName: string | null = null,
    soulOverride = '',
  ): SessionAgent {
    const masterSession = this.requireMasterSession(masterSessionId);
    this.ensureMasterSessionNotArchived(masterSession);
    if (!role.trim() || role.trim().length > 80)
      throw new Error(
        'Session Agent role must be between 1 and 80 characters.',
      );
    if (!mandate.trim() || mandate.length > 10000)
      throw new Error(
        'Session Agent mandate must be between 1 and 10000 characters.',
      );
    if (displayName !== null && displayName.trim().length > 80)
      throw new Error('Session Agent display name exceeds 80 characters.');
    if (soulOverride.length > 10000)
      throw new Error('Session Agent soul override exceeds 10000 characters.');
    if (!this.dot(dotId)) throw new Error('Dot not found.');
    if (!this.canAccessSpace(dotId, masterSession.spaceId))
      throw new Error('Dot does not have access to this Space.');
    const now = Date.now();
    const agent: SessionAgent = {
      id: randomUUID(),
      masterSessionId,
      dotId,
      role: role.trim(),
      displayName: displayName?.trim() || null,
      status: 'active',
      mandate,
      soulOverride,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO session_agents (id, masterSessionId, dotId, role, displayName, status, mandate, soulOverride, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        agent.id,
        masterSessionId,
        dotId,
        agent.role,
        agent.displayName,
        agent.status,
        mandate,
        soulOverride,
        now,
        now,
      );
    return agent;
  }
  updateSessionAgent(
    id: string,
    patch: {
      role?: string;
      displayName?: string | null;
      mandate?: string;
      soulOverride?: string;
    },
  ): SessionAgent {
    const current = this.requireSessionAgent(id);
    const masterSession = this.requireMasterSession(current.masterSessionId);
    this.ensureMasterSessionNotArchived(masterSession);
    if (current.status === 'removed')
      throw new Error('Removed Session Agents cannot be changed.');
    if (current.status !== 'active')
      throw new Error(
        'Only active Session Agents can change contextual settings.',
      );
    const role = patch.role === undefined ? current.role : patch.role.trim();
    const mandate =
      patch.mandate === undefined ? current.mandate : patch.mandate;
    if (!role || role.length > 80)
      throw new Error(
        'Session Agent role must be between 1 and 80 characters.',
      );
    if (!mandate.trim() || mandate.length > 10000)
      throw new Error(
        'Session Agent mandate must be between 1 and 10000 characters.',
      );
    const displayName =
      patch.displayName === undefined
        ? current.displayName
        : patch.displayName?.trim() || null;
    const soulOverride = patch.soulOverride ?? current.soulOverride;
    if (displayName && displayName.length > 80)
      throw new Error('Session Agent display name exceeds 80 characters.');
    if (soulOverride.length > 10000)
      throw new Error('Session Agent soul override exceeds 10000 characters.');
    this.db
      .prepare(
        'UPDATE session_agents SET role=?, displayName=?, mandate=?, soulOverride=?, updatedAt=? WHERE id=?',
      )
      .run(role, displayName, mandate, soulOverride, Date.now(), id);
    return this.requireSessionAgent(id);
  }
  setSessionAgentStatus(id: string, status: SessionAgentStatus): SessionAgent {
    const current = this.requireSessionAgent(id);
    const masterSession = this.requireMasterSession(current.masterSessionId);
    this.ensureMasterSessionNotArchived(masterSession);
    if (current.status === 'removed' && status !== 'removed')
      throw new Error('Removed Session Agents cannot be reactivated.');
    if (!['active', 'paused', 'removed'].includes(status))
      throw new Error('Invalid Session Agent status.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('UPDATE session_agents SET status=?, updatedAt=? WHERE id=?')
        .run(status, Date.now(), id);
      if (status === 'paused' || status === 'removed') {
        const memberships = this.db
          .prepare(
            `SELECT * FROM conversation_participants
             WHERE participantType='session_agent' AND participantId=? AND status='active'`,
          )
          .all(id) as unknown as ConversationParticipant[];
        for (const participant of memberships) {
          this.closeParticipantInterval(participant, 'removed');
          this.db
            .prepare(
              'DELETE FROM conversation_threads WHERE conversationId=? AND sessionAgentId=?',
            )
            .run(participant.conversationId, id);
        }
      }
      if (status === 'active' && current.status !== 'active') {
        const prior = this.db
          .prepare(
            `SELECT DISTINCT p.conversationId FROM conversation_participants p
             JOIN session_conversations c ON c.id=p.conversationId
             WHERE p.participantType='session_agent' AND p.participantId=?
               AND p.status='removed' AND c.visibility='team'
               AND c.kind='plenary' AND c.status='active'`,
          )
          .all(id) as Array<{ conversationId: string }>;
        for (const { conversationId } of prior) {
          const conversation =
            this.requireOrganizationalConversation(conversationId);
          if (conversation.status !== 'active') continue;
          const master = this.requireMasterSession(
            conversation.masterSessionId,
          );
          if (master.status !== 'active') continue;
          const interval = this.latestParticipantInterval(
            conversationId,
            'session_agent',
            id,
          );
          if (interval?.status === 'removed')
            this.insertParticipant(
              conversationId,
              'session_agent',
              id,
              'participant',
              this.currentConversationSequence(conversationId),
            );
          this.linkPrimaryThreadsForConversation(
            conversationId,
            new Map([
              [
                `session_agent:${id}`,
                { participantType: 'session_agent', participantId: id },
              ],
            ]),
          );
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.requireSessionAgent(id);
  }
  private requireSessionAgent(id: string): SessionAgent {
    const agent = this.sessionAgent(id);
    if (!agent) throw new Error('Session Agent not found.');
    return agent;
  }
  sessionThreads(sessionAgentId: string): SessionThread[] {
    this.requireSessionAgent(sessionAgentId);
    return this.db
      .prepare(
        'SELECT * FROM session_threads WHERE sessionAgentId=? ORDER BY createdAt',
      )
      .all(sessionAgentId)
      .map((row) => ({
        ...row,
        isPrimary: !!row.isPrimary,
      })) as unknown as SessionThread[];
  }
  associateSessionThread(
    sessionAgentId: string,
    threadId: string,
    isPrimary = false,
    internalCollaboration = false,
  ): SessionThread {
    const agent = this.requireSessionAgent(sessionAgentId);
    const masterSession = this.requireMasterSession(agent.masterSessionId);
    if (masterSession.status !== 'active')
      throw new Error(
        'Threads can only be associated with an active Master Session.',
      );
    if (agent.status !== 'active')
      throw new Error(
        'Threads can only be associated with an active Session Agent.',
      );
    if (!this.canAccessSpace(agent.dotId, masterSession.spaceId))
      throw new Error('Dot does not have access to this Space.');
    if (internalCollaboration) this.requireThread(threadId, agent.dotId);
    else this.requireHumanThread(threadId, agent.dotId);
    const existing = this.db
      .prepare('SELECT * FROM session_threads WHERE threadId=?')
      .get(threadId);
    if (existing && existing.sessionAgentId !== sessionAgentId)
      throw new Error(
        'Thread is already associated with another Session Agent.',
      );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (isPrimary)
        this.db
          .prepare(
            'UPDATE session_threads SET isPrimary=0 WHERE sessionAgentId=?',
          )
          .run(sessionAgentId);
      if (existing) {
        this.db
          .prepare('UPDATE session_threads SET isPrimary=? WHERE id=?')
          .run(+isPrimary, existing.id);
      } else {
        this.db
          .prepare(
            'INSERT INTO session_threads (id, sessionAgentId, threadId, isPrimary, createdAt) VALUES (?, ?, ?, ?, ?)',
          )
          .run(randomUUID(), sessionAgentId, threadId, +isPrimary, Date.now());
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const result = this.db
      .prepare('SELECT * FROM session_threads WHERE threadId=?')
      .get(threadId);
    if (!result)
      throw new Error('Session thread association could not be saved.');
    return {
      ...result,
      isPrimary: !!result.isPrimary,
    } as unknown as SessionThread;
  }
  spaces(): Space[] {
    return this.db
      .prepare('SELECT * FROM spaces ORDER BY createdAt')
      .all() as unknown as Space[];
  }
  createSpace(name: string, description: string): Space {
    const space = {
      id: randomUUID(),
      name,
      description,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO spaces VALUES (?, ?, ?, ?)')
      .run(space.id, name, description, space.createdAt);
    return space;
  }
  dots(): Dot[] {
    const rows = this.db
      .prepare('SELECT * FROM dots ORDER BY createdAt')
      .all()
      .map((row) => ({
        ...row,
        spaceIds: this.db
          .prepare(
            'SELECT spaceId FROM dot_spaces WHERE dotId=? ORDER BY spaceId',
          )
          .all(String(row.id))
          .map((grant) => String(grant.spaceId)),
        researchAllowed: !!row.researchAllowed,
        memoryAllowed: !!row.memoryAllowed,
        appsAllowed: !!row.appsAllowed,
        composioToolkits: JSON.parse(String(row.composioToolkits ?? '[]')),
        skillDeliveryEnabled: !!row.skillDeliveryEnabled,
      })) as unknown as Dot[];
    return rows;
  }
  dot(id: string) {
    return this.dots().find((dot) => dot.id === id);
  }
  createDot(
    spaceId: string,
    name: string,
    instructions: string,
    researchAllowed: boolean,
    memoryAllowed: boolean,
    spaceIds: string[] = [spaceId],
    learningContainerId: string | null = null,
    skillDeliveryEnabled = false,
    appsAllowed = false,
    composioToolkits: string[] = [],
  ): Dot {
    this.validateSpaceAccess(spaceId, spaceIds);
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    const dot: Dot = {
      id: randomUUID(),
      spaceId,
      spaceIds: [...new Set(spaceIds)].sort(),
      name,
      instructions,
      researchAllowed,
      memoryAllowed,
      appsAllowed,
      composioToolkits: [...new Set(composioToolkits)].sort(),
      composioSessionId: null,
      composioPolicyHash: null,
      learningContainerId,
      skillDeliveryEnabled,
      createdAt: Date.now(),
    };
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, learningContainerId, skillDeliveryEnabled, appsAllowed, composioToolkits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          dot.id,
          spaceId,
          name,
          instructions,
          +researchAllowed,
          +memoryAllowed,
          dot.createdAt,
          learningContainerId,
          +skillDeliveryEnabled,
          +appsAllowed,
          JSON.stringify(dot.composioToolkits),
        );
      for (const id of dot.spaceIds)
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(dot.id, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return dot;
  }
  canAccessSpace(dotId: string, spaceId: string) {
    return !!this.db
      .prepare('SELECT 1 FROM dot_spaces WHERE dotId=? AND spaceId=?')
      .get(dotId, spaceId);
  }
  private validateSpaceAccess(defaultSpace: string, spaceIds: string[]) {
    if (
      !spaceIds.includes(defaultSpace) ||
      spaceIds.some((id) => !this.spaces().some((space) => space.id === id))
    )
      throw new Error('Space access must include a valid default destination.');
  }
  updateDot(
    id: string,
    patch: Pick<
      Dot,
      | 'name'
      | 'instructions'
      | 'researchAllowed'
      | 'memoryAllowed'
      | 'appsAllowed'
      | 'composioToolkits'
    > & {
      spaceId?: string;
      spaceIds?: string[];
      learningContainerId?: string | null;
      skillDeliveryEnabled?: boolean;
    },
  ): Dot {
    const current = this.dot(id);
    if (!current) throw new Error('Dot not found.');
    const defaultSpace = patch.spaceId ?? current.spaceId;
    const spaceIds = patch.spaceIds ?? current.spaceIds;
    this.validateSpaceAccess(defaultSpace, spaceIds);
    const learningContainerId =
      patch.learningContainerId === undefined
        ? (current.learningContainerId ?? null)
        : patch.learningContainerId;
    const skillDeliveryEnabled =
      patch.skillDeliveryEnabled ?? current.skillDeliveryEnabled ?? false;
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'UPDATE dots SET name=?, instructions=?, researchAllowed=?, memoryAllowed=?, learningContainerId=?, skillDeliveryEnabled=?, appsAllowed=?, composioToolkits=? WHERE id=?',
        )
        .run(
          patch.name,
          patch.instructions,
          +patch.researchAllowed,
          +patch.memoryAllowed,
          learningContainerId,
          +skillDeliveryEnabled,
          +patch.appsAllowed,
          JSON.stringify([...new Set(patch.composioToolkits)].sort()),
          id,
        );
      this.db
        .prepare('UPDATE dots SET spaceId=? WHERE id=?')
        .run(defaultSpace, id);
      this.db.prepare('DELETE FROM dot_spaces WHERE dotId=?').run(id);
      for (const space of new Set(spaceIds))
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(id, space);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.dot(id)!;
  }
  saveComposioSession(id: string, sessionId: string, policyHash: string) {
    this.db
      .prepare(
        'UPDATE dots SET composioSessionId=?, composioPolicyHash=? WHERE id=?',
      )
      .run(sessionId, policyHash, id);
  }
  conversations(): Conversation[] {
    return this.db
      .prepare(
        'SELECT t.* FROM thread_bindings t WHERE ownerId=? AND NOT EXISTS (SELECT 1 FROM collaboration_executions e WHERE e.threadId=t.id) ORDER BY createdAt DESC',
      )
      .all(this.ownerId) as unknown as Conversation[];
  }
  bindThread(
    id: string,
    dotId: string,
    title: string,
    learningOverride?: null,
  ): Conversation {
    const dot = this.dot(dotId);
    if (!dot) throw new Error('Dot not found.');
    const value: Conversation = {
      id,
      dotId,
      ownerId: this.ownerId,
      title,
      createdAt: Date.now(),
      learningContainerId:
        learningOverride === null ? null : (dot.learningContainerId ?? null),
    };
    this.db
      .prepare(
        'INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, learningContainerId) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        dotId,
        this.ownerId,
        title,
        value.createdAt,
        value.learningContainerId ?? null,
      );
    return value;
  }
  requireThread(id: string, dotId?: string): Conversation {
    const thread = this.db
      .prepare('SELECT * FROM thread_bindings WHERE id=? AND ownerId=?')
      .get(id, this.ownerId) as unknown as Conversation | undefined;
    if (!thread || (dotId && thread.dotId !== dotId))
      throw new Error('Conversation does not belong to this Dot and owner.');
    return thread;
  }
  requireHumanThread(id: string, dotId?: string) {
    if (this.collaboration.forThread(id))
      throw new Error(
        'Project execution threads are internal. Read authorized organizational messages instead.',
      );
    return this.requireThread(id, dotId);
  }
  acquireThreadRun(threadId: string) {
    if (this.runningThreads.has(threadId))
      throw new Error('A turn is already running on this thread.');
    this.runningThreads.add(threadId);
    return () => this.runningThreads.delete(threadId);
  }
  collaborationAccess(
    conversationId: string,
    userId: string,
    sessionAgentId?: string,
  ) {
    const { conversation, participant: user } =
      this.authorizeConversationParticipant(conversationId, 'user', userId, {
        requireActiveConversation: true,
      });
    if (user.status !== 'active' || user.role === 'observer')
      throw new Error('Conversation access denied.');
    if (!sessionAgentId) return { conversation, user };
    const agent = this.activeSessionAgent(
      sessionAgentId,
      conversation.masterSessionId,
    );
    const participant = this.activeAgentMembership(
      conversation,
      sessionAgentId,
    );
    if (!agent || !participant || participant.role === 'observer')
      throw new Error(
        'Session Agent is not authorized to respond in this conversation.',
      );
    return { conversation, user, agent, participant };
  }
  prepareCollaborationThread(executionId: string) {
    const execution = this.collaboration.execution(executionId);
    if (!execution || execution.status !== 'running')
      throw new Error('Execution is not running.');
    this.collaborationAccess(
      execution.conversationId,
      this.ownerId,
      execution.sessionAgentId,
    );
    this.bindThread(
      execution.threadId,
      execution.dotId,
      'Project collaboration turn',
      null,
    );
    this.associateSessionThread(
      execution.sessionAgentId,
      execution.threadId,
      false,
      true,
    );
    this.relinkCollaborationThread(executionId);
  }
  relinkCollaborationThread(executionId: string) {
    const execution = this.collaboration.execution(executionId);
    if (!execution) throw new Error('Execution not found.');
    this.collaborationAccess(
      execution.conversationId,
      this.ownerId,
      execution.sessionAgentId,
    );
    this.db
      .prepare(
        'INSERT INTO conversation_threads(conversationId,sessionAgentId,threadId,linkedAt) VALUES (?,?,?,?) ON CONFLICT(conversationId,sessionAgentId) DO UPDATE SET threadId=excluded.threadId,linkedAt=excluded.linkedAt',
      )
      .run(
        execution.conversationId,
        execution.sessionAgentId,
        execution.threadId,
        Date.now(),
      );
  }
  bindTask(taskId: string, threadId: string) {
    this.requireThread(threadId);
    this.db
      .prepare('INSERT INTO task_threads VALUES (?, ?)')
      .run(taskId, threadId);
  }
  taskThread(taskId: string): string | undefined {
    const row = this.db
      .prepare('SELECT threadId FROM task_threads WHERE taskId=?')
      .get(taskId);
    return typeof row?.threadId === 'string' ? row.threadId : undefined;
  }
  calls(threadId?: string): CallReceipt[] {
    if (threadId) this.requireThread(threadId);
    return this.db
      .prepare(
        `SELECT * FROM calls ${threadId ? 'WHERE threadId=?' : ''} ORDER BY startedAt DESC`,
      )
      .all(...(threadId ? [threadId] : [])) as unknown as CallReceipt[];
  }
  createCall(threadId: string): CallReceipt {
    this.requireThread(threadId);
    const call: CallReceipt = {
      id: randomUUID(),
      threadId,
      startedAt: Date.now(),
      endedAt: null,
      status: 'connecting',
      transcript: '',
      error: null,
    };
    this.db
      .prepare(
        'INSERT INTO calls(id, threadId, startedAt, endedAt, status, transcript, error) VALUES (?, ?, ?, NULL, ?, ?, NULL)',
      )
      .run(call.id, threadId, call.startedAt, call.status, '');
    return call;
  }
  call(id: string): CallReceipt {
    const call = this.calls().find((call) => call.id === id);
    if (!call) throw new Error('Call not found.');
    this.requireThread(call.threadId);
    return call;
  }
  setCall(
    id: string,
    status: CallReceipt['status'],
    transcript: string,
    error: string | null = null,
  ) {
    const call = this.call(id);
    if (call.endedAt) return call;
    this.db
      .prepare(
        'UPDATE calls SET status=?, transcript=?, error=?, endedAt=? WHERE id=?',
      )
      .run(
        status,
        transcript,
        error,
        status === 'ended' || status === 'failed' ? Date.now() : null,
        id,
      );
    return this.call(id);
  }
  saveLateTranscript(id: string, transcript: string) {
    this.call(id);
    return (
      this.db
        .prepare(
          "UPDATE calls SET transcript=? WHERE id=? AND transcript='' AND endedAt IS NOT NULL",
        )
        .run(transcript, id).changes > 0
    );
  }
  anchorCall(id: string, anchor: string | undefined) {
    this.call(id);
    this.db
      .prepare('UPDATE calls SET anchorMessageId=? WHERE id=?')
      .run(anchor ?? null, id);
  }
  setCallError(id: string, error: string | null) {
    this.call(id);
    this.db.prepare('UPDATE calls SET error=? WHERE id=?').run(error, id);
  }
  saveCapture(threadId: string, value: unknown) {
    this.requireThread(threadId);
    this.db
      .prepare(
        'INSERT INTO captures VALUES (?, ?) ON CONFLICT(threadId) DO UPDATE SET value=excluded.value',
      )
      .run(threadId, JSON.stringify(value));
  }
  capture(threadId: string): unknown {
    this.requireThread(threadId);
    const row = this.db
      .prepare('SELECT value FROM captures WHERE threadId=?')
      .get(threadId);
    return typeof row?.value === 'string' ? JSON.parse(row.value) : null;
  }
}
