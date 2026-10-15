import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  CollaborationExecution,
  CollaborationMention,
  CollaborationMode,
  HandRaise,
} from '../shared/types.js';

export interface CollaborationSettings {
  mode: CollaborationMode;
  maxActivations: number;
  evaluationBudget: number;
}

/** Persistence only; authorization belongs to CollaborationService/WorkspaceStore. */
export class CollaborationStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_settings(conversationId TEXT PRIMARY KEY REFERENCES session_conversations(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_commands(messageId TEXT PRIMARY KEY REFERENCES conversation_messages(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_executions(
        id TEXT PRIMARY KEY, requestId TEXT NOT NULL,
        conversationId TEXT NOT NULL REFERENCES session_conversations(id),
        sessionAgentId TEXT NOT NULL REFERENCES session_agents(id), dotId TEXT NOT NULL REFERENCES dots(id),
        threadId TEXT NOT NULL UNIQUE, turnId TEXT NOT NULL,
        triggerMessageId TEXT NOT NULL REFERENCES conversation_messages(id),
        kind TEXT NOT NULL, status TEXT NOT NULL, authorization TEXT NOT NULL,
        output TEXT, error TEXT, createdAt INTEGER NOT NULL, completedAt INTEGER, handRaiseId TEXT,
        UNIQUE(requestId, sessionAgentId, kind)
      );
      CREATE INDEX IF NOT EXISTS collaboration_execution_conversation_idx ON collaboration_executions(conversationId, createdAt);
      CREATE TABLE IF NOT EXISTS collaboration_hand_raises(
        id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES session_conversations(id),
        sessionAgentId TEXT NOT NULL REFERENCES session_agents(id), triggerMessageId TEXT NOT NULL REFERENCES conversation_messages(id),
        executionId TEXT NOT NULL UNIQUE REFERENCES collaboration_executions(id), reason TEXT NOT NULL,
        status TEXT NOT NULL, createdAt INTEGER NOT NULL, resolvedAt INTEGER, resolvedBy TEXT,
        UNIQUE(conversationId, sessionAgentId, triggerMessageId)
      );
    `);
  }
  recover() {
    this.db
      .prepare(
        `UPDATE collaboration_executions SET status='interrupted', error='Server restarted; this execution was not resumed. No automatic retry.', completedAt=? WHERE status IN ('queued','running')`,
      )
      .run(Date.now());
  }
  admit<T>(operation: () => T): T {
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
  settings(id: string): CollaborationSettings {
    const row = this.db
      .prepare(
        'SELECT value FROM collaboration_settings WHERE conversationId=?',
      )
      .get(id);
    return row
      ? JSON.parse(String(row.value))
      : { mode: 'manual', maxActivations: 3, evaluationBudget: 2 };
  }
  saveSettings(id: string, value: CollaborationSettings) {
    this.db
      .prepare('INSERT OR REPLACE INTO collaboration_settings VALUES (?, ?)')
      .run(id, JSON.stringify(value));
    if (value.mode === 'manual')
      this.db
        .prepare(
          "UPDATE collaboration_hand_raises SET status='expired',resolvedAt=? WHERE conversationId=? AND status='pending'",
        )
        .run(Date.now(), id);
    return value;
  }
  command(
    messageId: string,
  ): { activation: string; mentions: CollaborationMention[] } | undefined {
    const row = this.db
      .prepare('SELECT value FROM collaboration_commands WHERE messageId=?')
      .get(messageId);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  saveCommand(
    messageId: string,
    value: { activation: string; mentions: CollaborationMention[] },
  ) {
    const previous = this.command(messageId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(value))
      throw new Error(
        'Idempotency key was already used with different activation instructions.',
      );
    this.db
      .prepare('INSERT OR IGNORE INTO collaboration_commands VALUES (?, ?)')
      .run(messageId, JSON.stringify(value));
  }
  execution(id: string) {
    return this.db
      .prepare('SELECT * FROM collaboration_executions WHERE id=?')
      .get(id) as unknown as CollaborationExecution | undefined;
  }
  forThread(threadId: string) {
    return this.db
      .prepare('SELECT * FROM collaboration_executions WHERE threadId=?')
      .get(threadId) as unknown as CollaborationExecution | undefined;
  }
  runtimeTurn(id: string, turnId: string) {
    if (!turnId.trim() || turnId.length > 200)
      throw new Error('Invalid runtime turn identity.');
    this.db
      .prepare(
        "UPDATE collaboration_executions SET turnId=? WHERE id=? AND status='running'",
      )
      .run(turnId, id);
  }
  executions(conversationId: string) {
    return this.db
      .prepare(
        'SELECT * FROM collaboration_executions WHERE conversationId=? ORDER BY createdAt,id',
      )
      .all(conversationId) as unknown as CollaborationExecution[];
  }
  createExecution(
    input: Pick<
      CollaborationExecution,
      | 'requestId'
      | 'conversationId'
      | 'sessionAgentId'
      | 'dotId'
      | 'triggerMessageId'
      | 'kind'
      | 'authorization'
    > & { handRaiseId?: string },
  ) {
    const previous = this.db
      .prepare(
        'SELECT * FROM collaboration_executions WHERE requestId=? AND sessionAgentId=? AND kind=?',
      )
      .get(input.requestId, input.sessionAgentId, input.kind) as unknown as
      CollaborationExecution | undefined;
    if (previous) return { execution: previous, fresh: false };
    const execution: CollaborationExecution = {
      ...input,
      id: randomUUID(),
      threadId: randomUUID(),
      turnId: randomUUID(),
      status: 'queued',
      output: null,
      error: null,
      createdAt: Date.now(),
      completedAt: null,
      handRaiseId: input.handRaiseId ?? null,
    };
    const columns = Object.keys(execution);
    this.db
      .prepare(
        `INSERT INTO collaboration_executions (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      )
      .run(...Object.values(execution));
    return { execution, fresh: true };
  }
  update(
    id: string,
    status: CollaborationExecution['status'],
    output: string | null = null,
    error: string | null = null,
  ) {
    this.db
      .prepare(
        'UPDATE collaboration_executions SET status=?,output=COALESCE(?,output),error=?,completedAt=? WHERE id=?',
      )
      .run(
        status,
        output,
        error,
        status === 'running' || status === 'queued' ? null : Date.now(),
        id,
      );
  }
  propose(execution: CollaborationExecution, reason: string) {
    const raise: HandRaise = {
      id: randomUUID(),
      conversationId: execution.conversationId,
      sessionAgentId: execution.sessionAgentId,
      triggerMessageId: execution.triggerMessageId,
      executionId: execution.id,
      reason,
      status: 'pending',
      createdAt: Date.now(),
      resolvedAt: null,
      resolvedBy: null,
    };
    const columns = Object.keys(raise);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO collaboration_hand_raises (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      )
      .run(...Object.values(raise));
  }
  raises(conversationId: string) {
    this.db
      .prepare(
        "UPDATE collaboration_hand_raises SET status='expired',resolvedAt=? WHERE conversationId=? AND status='pending' AND createdAt<?",
      )
      .run(Date.now(), conversationId, Date.now() - 86400000);
    return this.db
      .prepare(
        'SELECT * FROM collaboration_hand_raises WHERE conversationId=? ORDER BY createdAt,id',
      )
      .all(conversationId) as unknown as HandRaise[];
  }
  resolve(id: string, status: HandRaise['status'], userId: string) {
    this.db
      .prepare(
        "UPDATE collaboration_hand_raises SET status=?,resolvedAt=?,resolvedBy=? WHERE id=? AND status='pending'",
      )
      .run(status, Date.now(), userId, id);
  }
}
