export type Status =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled';
export interface Settings {
  name: string;
  paused: boolean;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  appsAllowed: boolean;
}
export interface Task {
  id: string;
  prompt: string;
  status: Status;
  intervalSeconds: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  lease: string | null;
  leaseUntil: number | null;
}
export interface Source {
  title: string;
  url: string;
  excerpt: string;
}
export interface Result {
  text: string;
  sources: Source[];
  sample: boolean;
  screenshot?: string;
}
export interface Run {
  id: string;
  taskId: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  result: Result | null;
  error: string | null;
}
export interface TaskEvent {
  id: number;
  taskId: string;
  runId: string | null;
  text: string;
  createdAt: number;
}
export interface Memory {
  id: string;
  text: string;
  createdAt: number;
}
export interface Detail {
  task: Task;
  runs: Run[];
  events: TaskEvent[];
}
export interface InboxItem {
  id: string;
  kind: 'task_completed' | 'task_failed' | 'watch_triggered';
  title: string;
  body: string;
  taskId: string | null;
  createdAt: number;
  readAt: number | null;
  dismissedAt: number | null;
}
export interface Watcher {
  id: string;
  url: string;
  prompt: string;
  threadId: string;
  intervalSeconds: number;
  lastCheckedAt: number | null;
  lastHash: string | null;
  nextCheckAt: number;
  enabled: boolean;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface State {
  settings: Settings;
  tasks: Task[];
  memories: Memory[];
  inbox: InboxItem[];
  watchers: Watcher[];
  mode: 'sample' | 'live';
  configured: boolean;
}
export type Action = 'run' | 'pause' | 'cancel';
export interface Space {
  id: string;
  name: string;
  description: string;
  createdAt: number;
}
export interface Dot {
  id: string;
  /** Default destination for saved pages, not ownership. */
  spaceId: string;
  spaceIds: string[];
  name: string;
  instructions: string;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  appsAllowed: boolean;
  composioToolkits: string[];
  composioSessionId?: string | null;
  composioPolicyHash?: string | null;
  createdAt: number;
  learningContainerId?: string | null;
  skillDeliveryEnabled?: boolean;
}
export interface Conversation {
  id: string;
  dotId: string;
  ownerId: string;
  title: string;
  createdAt: number;
  /** Frozen at creation; null means this conversation does not participate. */
  learningContainerId?: string | null;
}
export type MasterSessionStatus = 'active' | 'paused' | 'archived';
export interface MasterSession {
  id: string;
  spaceId: string;
  name: string;
  description: string;
  status: MasterSessionStatus;
  createdAt: number;
  updatedAt: number;
}
export type SessionAgentStatus = 'active' | 'paused' | 'removed';
export interface SessionAgent {
  id: string;
  masterSessionId: string;
  dotId: string;
  role: string;
  displayName: string | null;
  status: SessionAgentStatus;
  mandate: string;
  soulOverride: string;
  createdAt: number;
  updatedAt: number;
}
export interface MemberTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  skills: string[];
  agentInstructions: string;
  soulInstructions: string;
  version: number;
}
export interface TeamTemplatePosition {
  id: string;
  role: string;
  responsibility: string;
  memberTemplateId: string;
  count: number;
}
export interface TeamTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  version: number;
  positions: TeamTemplatePosition[];
}
export interface DotProfile {
  dotId: string;
  summary: string;
  skills: string[];
  workStyle: string;
  memberTemplateId: string | null;
  soulInstructions: string;
  updatedAt: number;
}
export interface SessionThread {
  id: string;
  sessionAgentId: string;
  threadId: string;
  isPrimary: boolean;
  createdAt: number;
}
export type OrganizationalConversationKind =
  'direct' | 'group' | 'plenary' | 'agent_only';
export type OrganizationalConversationVisibility =
  'private' | 'restricted' | 'team';
export type OrganizationalConversationStatus = 'active' | 'closed' | 'archived';
export type ConversationParticipantType = 'user' | 'session_agent';
export type ConversationParticipantRole =
  'owner' | 'moderator' | 'participant' | 'observer';
export type ConversationParticipantStatus = 'active' | 'left' | 'removed';
export interface OrganizationalConversation {
  id: string;
  masterSessionId: string;
  title: string;
  kind: OrganizationalConversationKind;
  visibility: OrganizationalConversationVisibility;
  status: OrganizationalConversationStatus;
  createdByType: ConversationParticipantType;
  createdById: string;
  createdAt: number;
  updatedAt: number;
}
export interface ConversationParticipant {
  id: string;
  conversationId: string;
  participantType: ConversationParticipantType;
  participantId: string;
  role: ConversationParticipantRole;
  joinedAt: number;
  joinedAfterSequence: number;
  leftAt: number | null;
  leftAfterSequence: number | null;
  status: ConversationParticipantStatus;
}
export interface OrganizationalMessage {
  id: string;
  conversationId: string;
  sequenceNumber: number;
  senderType: ConversationParticipantType;
  senderId: string;
  content: string;
  contentType: 'text' | 'json';
  createdAt: number;
  visibility: 'conversation' | 'participants';
  sourceThreadId: string | null;
  sourceTurnId: string | null;
  idempotencyKey: string | null;
  mentions?: CollaborationMention[];
}
export interface ConversationThreadLink {
  conversationId: string;
  sessionAgentId: string;
  threadId: string;
  linkedAt: number;
}
export type CollaborationMention =
  | {
      type: 'agent';
      conversationId: string;
      sessionAgentId: string;
      dotId: string;
      displayName: string;
    }
  | { type: 'all'; conversationId: string };
export type CollaborationMode = 'manual' | 'hand_raise' | 'meeting';
export interface CollaborationExecution {
  id: string;
  requestId: string;
  conversationId: string;
  sessionAgentId: string;
  dotId: string;
  threadId: string;
  turnId: string;
  triggerMessageId: string;
  kind: 'response' | 'evaluation';
  status:
    'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  authorization: string;
  output: string | null;
  progress: string | null;
  partialOutput: string | null;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
  handRaiseId: string | null;
  meetingRootId?: string | null;
  meetingDepth?: number;
}
export interface HandRaise {
  id: string;
  conversationId: string;
  sessionAgentId: string;
  triggerMessageId: string;
  executionId: string;
  reason: string;
  status: 'pending' | 'approved' | 'dismissed' | 'expired';
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}
export interface CollaborationSnapshot {
  settings: {
    mode: CollaborationMode;
    maxActivations: number;
    evaluationBudget: number;
  };
  executions: (Omit<CollaborationExecution, 'output' | 'authorization'> & {
    canRecover: boolean;
  })[];
  handRaises: HandRaise[];
}
export interface CallReceipt {
  anchorMessageId?: string | null;
  id: string;
  threadId: string;
  startedAt: number;
  endedAt: number | null;
  status: 'connecting' | 'active' | 'ended' | 'failed';
  transcript: string;
  error: string | null;
}
export interface SetupStatus {
  intelligence: boolean;
  model: boolean;
  browser: boolean;
  voice: boolean;
  composio: boolean;
  slack: string;
  telegram: string;
  missing: string[];
}
export interface WorkspaceState {
  spaces: Space[];
  dots: Dot[];
  conversations: Conversation[];
  masterSessions?: MasterSession[];
  setup: SetupStatus;
  calls: CallReceipt[];
}

export interface OfficeNavigationConversation {
  conversation: OrganizationalConversation;
  participants: Array<{
    participantId: string;
    name: string;
    role: ConversationParticipantRole;
  }>;
  lastMessage: Pick<OrganizationalMessage, 'content' | 'createdAt'> | null;
}
export interface OfficeNavigationProject {
  project: MasterSession;
  space: Space;
  members: Array<{
    agent: SessionAgent;
    dot: Dot;
  }>;
  conversations: OfficeNavigationConversation[];
  kickoffConversationId?: string;
}
export interface OfficeNavigationSummary {
  projects: OfficeNavigationProject[];
  projectSpaceIds: string[];
  archivedProjectCount: number;
  collaborators: Array<{ dot: Dot; profile: DotProfile }>;
}
