import {
  useCallback,
  useEffect,
  useState,
  useRef,
  type FormEvent,
} from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ChevronDown,
  MessageCircle,
  Plus,
  Send,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type {
  ConversationParticipant,
  OrganizationalConversation,
  OrganizationalMessage,
  SessionAgent,
  CollaborationMention,
  CollaborationSnapshot,
} from '../shared/types';
import type { DotProfile } from '../shared/types';
import type { Dot } from '../shared/types';
import { api } from './api';
import { Mascot } from './Mascot';
import {
  MentionComposer,
  CollaborationControls,
} from './CollaborationControls';

type Person = { dot: Dot; profile: DotProfile };
type ParticipantView = ConversationParticipant & {
  name: string;
  summary: string;
};
type Summary = {
  conversation: OrganizationalConversation;
  participants: ParticipantView[];
  lastMessage: OrganizationalMessage | null;
};
type ConversationDetails = {
  conversation: OrganizationalConversation;
  participants: ConversationParticipant[];
};
const PAGE_SIZE = 50;

export function ProjectConversations({
  masterSessionId,
  agents,
  roster,
  kickoffConversationId,
  kickoffAgenda,
  kickoffStarted,
  kickoffTargets,
  onStartKickoff,
  requestedConversationId,
  onConversationChange,
  onNavigationRefresh,
  onOpenDirect,
}: {
  masterSessionId: string;
  agents: SessionAgent[];
  roster: Person[];
  kickoffConversationId?: string;
  kickoffAgenda: string;
  kickoffStarted: boolean;
  kickoffTargets: string[];
  onStartKickoff: () => Promise<string[]>;
  requestedConversationId?: string;
  onConversationChange: (conversationId?: string) => void;
  onNavigationRefresh: () => void;
  onOpenDirect: (projectId: string, sessionAgentId: string) => Promise<void>;
}) {
  const [rows, setRows] = useState<Summary[]>([]);
  const [selected, setSelected] = useState<Summary>();
  const [participants, setParticipants] = useState<ParticipantView[]>([]);
  const [messages, setMessages] = useState<OrganizationalMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [startingKickoff, setStartingKickoff] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [kind, setKind] = useState<'direct' | 'group' | 'plenary'>('group');
  const [title, setTitle] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [showAddParticipant, setShowAddParticipant] = useState(false);
  const [mentions, setMentions] = useState<CollaborationMention[]>([]);
  const [publishOnly, setPublishOnly] = useState(false);
  const [snapshot, setSnapshot] = useState<CollaborationSnapshot>();
  const [sendKey, setSendKey] = useState<string>();
  const selectedId = selected?.conversation.id;
  const activeConversation = useRef<string | undefined>(undefined);
  useEffect(() => {
    activeConversation.current = selectedId;
    setSnapshot(undefined);
    setMentions([]);
    setDraft('');
    setSendKey(undefined);
    setPublishOnly(false);
    if (!selectedId) return;
    let active = true;
    let pending = false;
    const controller = new AbortController();
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const [state, page, detail] = await Promise.all([
          api<CollaborationSnapshot>(
            `/organizational-conversations/${selectedId}/collaboration`,
            'GET',
            undefined,
            controller.signal,
          ),
          api<OrganizationalMessage[]>(
            `/organizational-conversations/${selectedId}/messages?limit=${PAGE_SIZE}`,
            'GET',
            undefined,
            controller.signal,
          ),
          api<ConversationDetails>(
            `/organizational-conversations/${selectedId}`,
            'GET',
            undefined,
            controller.signal,
          ),
        ]);
        if (active) {
          setSnapshot(state);
          setParticipants(
            detail.participants.map((participant) => {
              const agent = agents.find(
                (item) => item.id === participant.participantId,
              );
              const person =
                agent && roster.find((item) => item.dot.id === agent.dotId);
              return {
                ...participant,
                name:
                  participant.participantType === 'user'
                    ? 'You'
                    : (person?.dot.name ??
                      agent?.displayName ??
                      'Collaborator'),
                summary: person?.profile.summary ?? '',
              };
            }),
          );
          setMessages((previous) =>
            [
              ...new Map(
                [...previous, ...page].map((message) => [message.id, message]),
              ).values(),
            ].sort((a, b) => a.sequenceNumber - b.sequenceNumber),
          );
        }
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error
              ? err.message
              : 'Could not refresh participation status.',
          );
          setMessages([]);
          setSnapshot(undefined);
          setParticipants([]);
          setHasOlder(false);
        }
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      active = false;
      clearInterval(timer);
      controller.abort();
    };
  }, [selectedId, kickoffConversationId]);
  const participationAction = async (path: string, body: unknown) => {
    if (!selectedId) return;
    setError('');
    try {
      const state = await api<CollaborationSnapshot>(
        `/organizational-conversations/${selectedId}${path}`,
        path === '/collaboration' ? 'PUT' : 'POST',
        body,
      );
      if ('settings' in state) setSnapshot(state);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Participation request failed.',
      );
    }
  };

  const loadRows = useCallback(async () => {
    setError('');
    try {
      const data = await api<Summary[]>(
        `/master-sessions/${masterSessionId}/conversation-summaries`,
      );
      setRows(data);
      onNavigationRefresh();
      setSelected((current) =>
        current
          ? data.find((row) => row.conversation.id === current.conversation.id)
          : undefined,
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not load project conversations.',
      );
    } finally {
      setLoading(false);
    }
  }, [masterSessionId, onNavigationRefresh]);
  useEffect(() => {
    setLoading(true);
    void loadRows();
  }, [loadRows]);
  const openConversation = async (row: Summary) => {
    activeConversation.current = row.conversation.id;
    onConversationChange(row.conversation.id);
    setError('');
    setNotice('');
    setSelected(row);
    setMessages([]);
    setParticipants([]);
    setLoadingMessages(true);
    try {
      const [detail, page] = await Promise.all([
        api<ConversationDetails>(
          `/organizational-conversations/${row.conversation.id}`,
        ),
        api<OrganizationalMessage[]>(
          `/organizational-conversations/${row.conversation.id}/messages?limit=${PAGE_SIZE}`,
        ),
      ]);
      if (activeConversation.current !== row.conversation.id) return;
      const mapped = detail.participants.map((participant) => {
        const agent = agents.find(
          (item) => item.id === participant.participantId,
        );
        const person =
          agent && roster.find((item) => item.dot.id === agent.dotId);
        return {
          ...participant,
          name:
            participant.participantType === 'user'
              ? 'You'
              : (person?.dot.name ?? agent?.displayName ?? 'Collaborator'),
          summary: person?.profile.summary ?? '',
        };
      });
      setParticipants(mapped);
      setMessages(page);
      setHasOlder(page.length === PAGE_SIZE);
    } catch (err) {
      if (activeConversation.current !== row.conversation.id) return;
      setError(
        err instanceof Error
          ? err.message
          : 'You can no longer access this conversation.',
      );
      setSelected(undefined);
      await loadRows();
    } finally {
      if (activeConversation.current === row.conversation.id)
        setLoadingMessages(false);
    }
  };
  const openDirect = async (sessionAgentId: string) => {
    try {
      await onOpenDirect(masterSessionId, sessionAgentId);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not open this project conversation.',
      );
    }
  };
  const startKickoff = async () => {
    if (!kickoffConversationId || kickoffStarted || startingKickoff) return;
    setStartingKickoff(true);
    setError('');
    setNotice('');
    try {
      const targets = await onStartKickoff();
      setNotice(
        targets.length
          ? `Kickoff started. OpenDots requested contributions from ${targets.join(', ')}. Their execution status appears below.`
          : 'Kickoff started. Execution status appears below.',
      );
      await loadRows();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not start the kickoff.',
      );
    } finally {
      setStartingKickoff(false);
    }
  };
  useEffect(() => {
    if (!kickoffConversationId || !rows.length) return;
    const kickoff = rows.find(
      (row) => row.conversation.id === kickoffConversationId,
    );
    if (kickoff && selectedId !== kickoffConversationId)
      void openConversation(kickoff);
  }, [rows, kickoffConversationId, selectedId, openConversation]);
  useEffect(() => {
    if (!requestedConversationId || !rows.length) return;
    const requested = rows.find(
      (row) => row.conversation.id === requestedConversationId,
    );
    if (requested && selectedId !== requestedConversationId)
      void openConversation(requested);
  }, [rows, requestedConversationId, selectedId, openConversation]);
  const createConversation = async () => {
    setError('');
    setNotice('');
    try {
      let conversation: OrganizationalConversation;
      if (kind === 'direct') {
        if (selectedAgents.length !== 1)
          throw new Error(
            'Choose one collaborator for a private conversation.',
          );
        conversation = await api<OrganizationalConversation>(
          `/master-sessions/${masterSessionId}/conversations/direct`,
          'POST',
          { sessionAgentId: selectedAgents[0] },
        );
      } else {
        conversation = await api<OrganizationalConversation>(
          `/master-sessions/${masterSessionId}/conversations`,
          'POST',
          {
            title:
              title.trim() ||
              (kind === 'plenary' ? 'Project plenary' : 'Team conversation'),
            kind,
            visibility: kind === 'plenary' ? 'team' : 'restricted',
            participantIds: kind === 'plenary' ? [] : selectedAgents,
          },
        );
      }
      setShowCreate(false);
      setSelectedAgents([]);
      setTitle('');
      await loadRows();
      const row = await api<Summary[]>(
        `/master-sessions/${masterSessionId}/conversation-summaries`,
      );
      const created = row.find(
        (item) => item.conversation.id === conversation.id,
      );
      if (created) await openConversation(created);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not create conversation.',
      );
    }
  };
  const loadOlder = async () => {
    if (!selected || !messages.length || loadingMessages) return;
    setLoadingMessages(true);
    setError('');
    try {
      const page = await api<OrganizationalMessage[]>(
        `/organizational-conversations/${selected.conversation.id}/messages?before=${messages[0].sequenceNumber}&limit=${PAGE_SIZE}`,
      );
      if (activeConversation.current !== selected.conversation.id) return;
      setMessages((current) => [...page, ...current]);
      setHasOlder(page.length === PAGE_SIZE);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not load older messages.',
      );
    } finally {
      setLoadingMessages(false);
    }
  };
  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !draft.trim() || sending) return;
    setSending(true);
    setError('');
    setNotice('');
    const requestKey = sendKey ?? crypto.randomUUID();
    setSendKey(requestKey);
    try {
      await api(
        `/organizational-conversations/${selected.conversation.id}/messages`,
        'POST',
        {
          content: draft.trim(),
          idempotencyKey: requestKey,
          mentions,
          activation: publishOnly
            ? 'none'
            : mentions.length
              ? 'mentioned'
              : selected.conversation.kind === 'direct'
                ? 'direct'
                : 'none',
        },
      );
      if (activeConversation.current !== selected.conversation.id) return;
      setDraft('');
      setMentions([]);
      setSendKey(undefined);
      setNotice(
        'Message published. Requested contributions are tracked below.',
      );
      const page = await api<OrganizationalMessage[]>(
        `/organizational-conversations/${selected.conversation.id}/messages?limit=${PAGE_SIZE}`,
      );
      if (activeConversation.current !== selected.conversation.id) return;
      setMessages(page);
      setHasOlder(page.length === PAGE_SIZE);
      await loadRows();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not publish this message.',
      );
    } finally {
      setSending(false);
    }
  };
  const addParticipant = async (agentId: string) => {
    if (!selected) return;
    setError('');
    try {
      await api(
        `/organizational-conversations/${selected.conversation.id}/participants`,
        'POST',
        { participantType: 'session_agent', participantId: agentId },
      );
      setShowAddParticipant(false);
      setNotice(
        'Participant added. Messages from before their join remain hidden.',
      );
      await openConversation(selected);
      await loadRows();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not add participant.',
      );
    }
  };
  const removeParticipant = async (agentId: string) => {
    if (
      !selected ||
      !window.confirm(
        'Remove this participant? Their previous authorized history is retained.',
      )
    )
      return;
    setError('');
    try {
      await api(
        `/organizational-conversations/${selected.conversation.id}/participants/${agentId}`,
        'DELETE',
      );
      setNotice('Participant removed. Their access is revoked.');
      await openConversation(selected);
      await loadRows();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not remove participant.',
      );
    }
  };
  const updateRole = async (agentId: string, role: string) => {
    if (!selected) return;
    setError('');
    try {
      await api(
        `/organizational-conversations/${selected.conversation.id}/participants/${agentId}/role`,
        'PUT',
        { role },
      );
      await openConversation(selected);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not update participant role.',
      );
    }
  };
  const current = selected?.conversation;
  const activationNames = participants
    .filter(
      (participant) =>
        participant.participantType === 'session_agent' &&
        participant.role !== 'observer' &&
        agents.some(
          (agent) =>
            agent.id === participant.participantId && agent.status === 'active',
        ) &&
        (mentions.length
          ? mentions.some(
              (mention) =>
                mention.type === 'all' ||
                mention.sessionAgentId === participant.participantId,
            )
          : current?.kind === 'direct'),
    )
    .map(
      (participant) =>
        `${participant.name} (${agents.find((agent) => agent.id === participant.participantId)?.role ?? participant.role})`,
    )
    .join(', ');
  const selectableAgents = agents.filter((agent) => agent.status === 'active');
  const availableToAdd = selectableAgents.filter(
    (agent) =>
      !participants.some(
        (participant) =>
          participant.participantType === 'session_agent' &&
          participant.participantId === agent.id,
      ),
  );

  if (selected && current)
    return (
      <section className="project-conversation-view">
        <div className="conversation-view-heading">
          <button
            className="secondary-button"
            onClick={() => {
              setSelected(undefined);
              activeConversation.current = undefined;
              void loadRows();
              setParticipants([]);
              setMessages([]);
              setError('');
            }}
          >
            <ArrowLeft size={15} />
            All conversations
          </button>
          <div>
            <span className="eyebrow">
              ORGANIZATIONAL CONVERSATION · {current.kind}
            </span>
            <h2>{current.title}</h2>
            <small>
              {new Date(current.updatedAt).toLocaleString()} · {current.status}
            </small>
          </div>
        </div>
        <div className="conversation-layout">
          <div className="conversation-main">
            {current.id === kickoffConversationId && (
              <section className="project-kickoff-card">
                <div className="project-kickoff-heading">
                  <div>
                    <span className="eyebrow">PROJECT KICKOFF</span>
                    <h3>Ready to begin</h3>
                  </div>
                  <span
                    className={`project-status ${kickoffStarted ? 'active' : 'ready'}`}
                  >
                    {kickoffStarted ? 'Started' : 'Ready'}
                  </span>
                </div>
                <div className="kickoff-participants">
                  <b>Project collaborators</b>
                  <div>
                    {participants
                      .filter(
                        (participant) =>
                          participant.participantType === 'session_agent',
                      )
                      .map((participant) => {
                        const agent = agents.find(
                          (item) => item.id === participant.participantId,
                        );
                        const person =
                          agent &&
                          roster.find((item) => item.dot.id === agent.dotId);
                        return (
                          <span key={participant.id}>
                            {person?.dot.name ?? participant.name} ·{' '}
                            {agent?.role ?? 'Collaborator'}
                          </span>
                        );
                      })}
                  </div>
                </div>
                <details className="kickoff-agenda" open>
                  <summary>Proposed agenda</summary>
                  <pre>{kickoffAgenda}</pre>
                </details>
                {kickoffStarted ? (
                  <p className="kickoff-feedback" role="status">
                    {kickoffTargets.length
                      ? `Requested: ${kickoffTargets.join(', ')}. Follow their execution status below. This conversation stays available to continue or resume the discussion.`
                      : 'Kickoff activation was already requested. Follow execution status below or continue the persistent conversation.'}
                  </p>
                ) : (
                  <button
                    className="primary"
                    disabled={startingKickoff || loadingMessages}
                    onClick={() => void startKickoff()}
                  >
                    {startingKickoff ? 'Starting kickoff…' : 'Avvia kickoff'}
                  </button>
                )}
              </section>
            )}
            {current.status !== 'active' && (
              <p className="notice">
                This conversation is {current.status} and cannot receive new
                messages.
              </p>
            )}
            {error && (
              <p className="chat-error" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="conversation-notice" role="status">
                {notice}
              </p>
            )}
            <div className="organizational-messages" aria-live="polite">
              {hasOlder && (
                <button
                  className="secondary-button load-older"
                  disabled={loadingMessages}
                  onClick={() => void loadOlder()}
                >
                  <ArrowDown size={14} />
                  {loadingMessages ? 'Loading…' : 'Load older messages'}
                </button>
              )}
              {loadingMessages && !messages.length ? (
                <p className="muted">Loading authorized message history…</p>
              ) : (
                messages
                  .filter(
                    (message) =>
                      current.id !== kickoffConversationId ||
                      message.idempotencyKey !==
                        `kickoff-agenda:${masterSessionId}`,
                  )
                  .map((message) => {
                    const participant = participants.find(
                      (person) => person.participantId === message.senderId,
                    );
                    const agent = agents.find(
                      (person) => person.id === message.senderId,
                    );
                    const dot =
                      agent &&
                      roster.find((person) => person.dot.id === agent.dotId)
                        ?.dot;
                    return (
                      <article
                        className={`organizational-message ${message.senderType === 'user' ? 'from-user' : ''}`}
                        key={message.id}
                      >
                        <div>
                          <b>
                            {message.senderType === 'user'
                              ? 'You'
                              : (participant?.name ??
                                dot?.name ??
                                agent?.displayName ??
                                'Collaborator')}
                          </b>
                          <time
                            dateTime={new Date(message.createdAt).toISOString()}
                          >
                            {new Date(message.createdAt).toLocaleString()}
                          </time>
                        </div>
                        <p>{message.content}</p>
                        {agent && (
                          <small>
                            {agent.role} ·{' '}
                            {snapshot?.executions.find(
                              (execution) =>
                                execution.threadId === message.sourceThreadId,
                            )?.status ?? 'published'}
                          </small>
                        )}
                      </article>
                    );
                  })
              )}
              {!loadingMessages && !messages.length && (
                <div className="conversation-empty">
                  <MessageCircle size={26} />
                  <p>No messages yet. Your message will be recorded here.</p>
                </div>
              )}
            </div>
            {current.status === 'active' && (
              <form
                className="organizational-composer"
                onSubmit={(event) => void sendMessage(event)}
              >
                <MentionComposer
                  conversationId={current.id}
                  value={draft}
                  onChange={(value) => {
                    setDraft(value);
                    setSendKey(undefined);
                  }}
                  mentions={mentions}
                  onMentions={(value) => {
                    setMentions(value);
                    setSendKey(undefined);
                  }}
                  candidates={participants.flatMap((participant) => {
                    const agent = agents.find(
                      (item) =>
                        item.id === participant.participantId &&
                        item.status === 'active',
                    );
                    const dot =
                      agent &&
                      roster.find((item) => item.dot.id === agent.dotId)?.dot;
                    return agent && dot && participant.role !== 'observer'
                      ? [
                          {
                            sessionAgentId: agent.id,
                            dotId: dot.id,
                            name: dot.name,
                            role: agent.role,
                          },
                        ]
                      : [];
                  })}
                />
                <label className="publish-only">
                  <input
                    type="checkbox"
                    checked={publishOnly}
                    onChange={(event) => {
                      setPublishOnly(event.target.checked);
                      setSendKey(undefined);
                    }}
                  />
                  Publish without requesting responses
                </label>
                <div>
                  <small>
                    {publishOnly
                      ? 'No collaborator will be activated.'
                      : activationNames
                        ? `Requested: ${activationNames}.`
                        : 'Select recipients from @ suggestions to request a response. Otherwise this message is shared without activation.'}
                  </small>
                  <button
                    className="primary"
                    disabled={!draft.trim() || sending}
                  >
                    <Send size={15} />
                    {sending ? 'Publishing…' : 'Publish message'}
                  </button>
                </div>
              </form>
            )}
            <CollaborationControls
              snapshot={snapshot}
              name={(agentId) => {
                const agent = agents.find((item) => item.id === agentId);
                return (
                  roster.find((item) => item.dot.id === agent?.dotId)?.dot
                    .name ?? 'Collaborator'
                );
              }}
              triggerMessageId={
                messages
                  .filter((message) => message.senderType === 'user')
                  .at(-1)?.id
              }
              onAction={participationAction}
              onSettings={(settings) =>
                participationAction('/collaboration', settings)
              }
            />
          </div>
          <aside className="conversation-participants">
            <div className="conversation-panel-heading">
              <div>
                <span className="eyebrow">PARTICIPANTS</span>
                <h3>{participants.length} active</h3>
              </div>
              <button
                className="icon-button"
                aria-label="Add participant"
                disabled={current.status !== 'active'}
                onClick={() => setShowAddParticipant(true)}
              >
                <Plus size={17} />
              </button>
            </div>
            {participants.map((participant) => {
              const agent =
                participant.participantType === 'session_agent'
                  ? agents.find((item) => item.id === participant.participantId)
                  : undefined;
              return (
                <article
                  className="conversation-participant"
                  key={participant.id}
                >
                  <div className="conversation-participant-identity">
                    {agent ? (
                      <Mascot
                        identity={agent.dotId}
                        name={participant.name}
                        small
                        decorative
                      />
                    ) : (
                      <span
                        className="conversation-participant-avatar"
                        aria-hidden="true"
                      >
                        {participant.name.trim().charAt(0).toUpperCase() || '?'}
                      </span>
                    )}
                    <span className="conversation-participant-details">
                      <b>{participant.name}</b>
                      <small>{participant.status}</small>
                    </span>
                  </div>
                  {agent && (
                    <div className="conversation-participant-actions">
                      <button
                        className="quiet-button conversation-participant-talk"
                        aria-label={`Talk with ${participant.name}`}
                        title={`Talk with ${participant.name}`}
                        onClick={() => void openDirect(agent.id)}
                      >
                        <MessageCircle size={15} aria-hidden="true" />
                      </button>
                      {participant.role !== 'owner' && (
                        <button
                          className="quiet-button danger-text conversation-participant-remove"
                          aria-label={`Remove ${participant.name}`}
                          title={`Remove ${participant.name}`}
                          onClick={() => void removeParticipant(agent.id)}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  )}
                  <div className="conversation-participant-role">
                    <span>Role</span>
                    {agent && participant.role !== 'owner' ? (
                      <span className="conversation-role-select">
                        <select
                          aria-label={`Role for ${participant.name}`}
                          value={participant.role}
                          onChange={(event) =>
                            void updateRole(agent.id, event.target.value)
                          }
                        >
                          <option value="participant">Participant</option>
                          <option value="moderator">Moderator</option>
                          <option value="observer">Observer</option>
                        </select>
                        <ChevronDown size={14} aria-hidden="true" />
                      </span>
                    ) : (
                      <b>
                        {participant.role.charAt(0).toUpperCase() +
                          participant.role.slice(1)}
                      </b>
                    )}
                  </div>
                </article>
              );
            })}
            {showAddParticipant && (
              <div className="participant-picker">
                <div>
                  <b>Add a project participant</b>
                  <button
                    className="icon-button"
                    aria-label="Close"
                    onClick={() => setShowAddParticipant(false)}
                  >
                    <X size={14} />
                  </button>
                </div>
                <p>
                  New participants cannot read messages from before they joined.
                </p>
                {availableToAdd.map((agent) => {
                  const person = roster.find(
                    (item) => item.dot.id === agent.dotId,
                  );
                  return (
                    <button
                      key={agent.id}
                      onClick={() => void addParticipant(agent.id)}
                    >
                      {agent.displayName ?? person?.dot.name ?? 'Collaborator'}
                      <Plus size={14} />
                    </button>
                  );
                })}
                {!availableToAdd.length && (
                  <small>No eligible project collaborators.</small>
                )}
              </div>
            )}
          </aside>
        </div>
      </section>
    );

  return (
    <section className="project-conversations">
      <div className="office-section-head">
        <div>
          <span className="eyebrow">PERSISTENT PROJECT DISCUSSIONS</span>
          <h2>Conversations</h2>
        </div>
        <button
          className="primary"
          onClick={() => {
            setShowCreate(true);
            setKind('group');
            setTitle('');
            setSelectedAgents([]);
          }}
        >
          <Plus size={15} />
          New conversation
        </button>
      </div>
      <p className="muted">
        Project discussions retain each collaborator’s identity. Select @
        recipients to request real contributions, or share a message without
        activation.
      </p>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="muted">Loading conversations…</p>
      ) : rows.length ? (
        <div className="project-conversation-list">
          {rows.map((row) => (
            <button
              className="project-conversation-row"
              key={row.conversation.id}
              onClick={() => void openConversation(row)}
            >
              <span className="conversation-type-icon">
                {row.conversation.kind === 'direct' ? (
                  <MessageCircle size={17} />
                ) : (
                  <Users size={17} />
                )}
              </span>
              <span className="conversation-row-main">
                <b>{row.conversation.title}</b>
                <small>
                  {row.conversation.kind} ·{' '}
                  {row.participants
                    .map((participant) => participant.name)
                    .join(', ')}
                </small>
                <span>{row.lastMessage?.content ?? 'No messages yet.'}</span>
              </span>
              <span className="conversation-row-time">
                {new Date(
                  row.lastMessage?.createdAt ?? row.conversation.updatedAt,
                ).toLocaleDateString()}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="large-empty">
          <MessageCircle size={30} />
          <h3>No conversations yet</h3>
          <p>
            Open a private discussion with one collaborator or create a group.
          </p>
          <button
            className="primary"
            onClick={() => {
              setShowCreate(true);
              setKind('group');
            }}
          >
            Start a conversation
          </button>
        </div>
      )}
      {showCreate && (
        <div className="modal-backdrop" onClick={() => setShowCreate(false)}>
          <section
            className="modal office-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-conversation-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="Close"
              onClick={() => setShowCreate(false)}
            >
              <X size={17} />
            </button>
            <span className="eyebrow">PROJECT CONVERSATION</span>
            <h2 id="create-conversation-title">Start a discussion</h2>
            <label className="field-label" htmlFor="conversation-kind">
              Type
            </label>
            <select
              id="conversation-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as typeof kind)}
            >
              <option value="direct">Private with one collaborator</option>
              <option value="group">Restricted group</option>
              <option value="plenary">Project plenary</option>
            </select>
            {kind !== 'direct' && (
              <>
                <label className="field-label" htmlFor="conversation-title">
                  Title
                </label>
                <input
                  id="conversation-title"
                  value={title}
                  maxLength={160}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Team discussion"
                />
              </>
            )}
            {kind !== 'plenary' && (
              <fieldset className="conversation-agent-picker">
                <legend>
                  {kind === 'direct'
                    ? 'Choose one collaborator'
                    : 'Choose at least two collaborators'}
                </legend>
                {selectableAgents.map((agent) => {
                  const person = roster.find(
                    (item) => item.dot.id === agent.dotId,
                  );
                  const checked = selectedAgents.includes(agent.id);
                  return (
                    <label key={agent.id}>
                      <input
                        type={kind === 'direct' ? 'radio' : 'checkbox'}
                        name="conversation-agent"
                        checked={checked}
                        onChange={() =>
                          setSelectedAgents((current) =>
                            kind === 'direct'
                              ? [agent.id]
                              : checked
                                ? current.filter((id) => id !== agent.id)
                                : [...current, agent.id],
                          )
                        }
                      />
                      <span>
                        <b>
                          {agent.displayName ??
                            person?.dot.name ??
                            'Collaborator'}
                        </b>
                        <small>{agent.role}</small>
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            )}
            {kind === 'plenary' && (
              <p className="muted">
                The project’s active collaborators will be included
                automatically.
              </p>
            )}
            <button
              className="primary"
              disabled={
                kind !== 'plenary' &&
                (kind === 'direct'
                  ? selectedAgents.length !== 1
                  : selectedAgents.length < 2)
              }
              onClick={() => void createConversation()}
            >
              Create conversation
            </button>
          </section>
        </div>
      )}
    </section>
  );
}
