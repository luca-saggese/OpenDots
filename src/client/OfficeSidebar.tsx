import { useEffect, useState } from 'react';
import {
  Archive,
  BriefcaseBusiness,
  ChevronDown,
  ChevronRight,
  Folder,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Users,
} from 'lucide-react';
import type {
  Dot,
  OfficeNavigationProject,
  OfficeNavigationSummary,
  Space,
} from '../shared/types';
import { api } from './api';
import { Mascot } from './Mascot';
import { SpaceNav } from './SpaceNav';

const OPEN_PROJECTS_KEY = 'opendots.office-nav.open-projects';
function readExpanded() {
  try {
    const value = JSON.parse(localStorage.getItem(OPEN_PROJECTS_KEY) ?? '[]');
    return new Set<string>(Array.isArray(value) ? value : []);
  } catch {
    return new Set<string>();
  }
}
function persistExpanded(projectIds: Set<string>) {
  try {
    localStorage.setItem(OPEN_PROJECTS_KEY, JSON.stringify([...projectIds]));
  } catch {
    // Storage may be unavailable in restricted browsing contexts.
  }
}

export function OfficeSidebar({
  spaces,
  dots,
  activeProjectId,
  activeConversationId,
  activeSpaceId,
  officeActive,
  refreshSignal,
  onOpenOffice,
  onCreateProject,
  onCreateDot,
  onEditDot,
  onOpenNativeDot,
  onCreateSpace,
  onNewNativeChat,
  nativeChatEnabled,
  onOpenProject,
  onOpenConversation,
  onOpenAllConversations,
  onOpenDotProfile,
  onOpenDirect,
  onOpenSpace,
}: {
  spaces: Space[];
  dots: Dot[];
  activeProjectId?: string;
  activeConversationId?: string;
  activeSpaceId?: string;
  officeActive: boolean;
  refreshSignal: number;
  onOpenOffice: () => void;
  onCreateProject: () => void;
  onCreateDot: () => void;
  onEditDot: (dotId: string) => void;
  onOpenNativeDot: (dotId: string) => void;
  onCreateSpace: () => void;
  onNewNativeChat: () => void;
  nativeChatEnabled: boolean;
  onOpenProject: (
    projectId: string,
    tab?: 'overview' | 'team' | 'conversations',
  ) => void;
  onOpenConversation: (projectId: string, conversationId?: string) => void;
  onOpenAllConversations: (projectId: string) => void;
  onOpenDotProfile: (dotId: string) => void;
  onOpenDirect: (projectId: string, sessionAgentId: string) => Promise<void>;
  onOpenSpace: (spaceId: string) => void;
}) {
  const [summary, setSummary] = useState<OfficeNavigationSummary>();
  const [loadError, setLoadError] = useState('');
  const [expanded, setExpanded] = useState(readExpanded);
  const [showAllByProject, setShowAllByProject] = useState<Set<string>>(
    () => new Set(),
  );
  const [showAllTeams, setShowAllTeams] = useState<Set<string>>(
    () => new Set(),
  );
  const [openingDirect, setOpeningDirect] = useState('');
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const next = await api<OfficeNavigationSummary>('/office/navigation');
        if (current) {
          setSummary(next);
          setLoadError('');
        }
      } catch {
        if (current) setLoadError('Office navigation is unavailable.');
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [refreshSignal]);

  useEffect(() => {
    if (!activeProjectId) return;
    setExpanded((current) => {
      if (current.has(activeProjectId)) return current;
      const next = new Set(current).add(activeProjectId);
      persistExpanded(next);
      return next;
    });
  }, [activeProjectId, activeConversationId]);

  const toggleProject = (projectId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      persistExpanded(next);
      return next;
    });
  };
  const otherSpaces = summary
    ? spaces.filter((space) => !summary.projectSpaceIds.includes(space.id))
    : [];
  const collaborators =
    summary?.collaborators ?? dots.map((dot) => ({ dot, profile: undefined }));
  const openDirect = async (
    project: OfficeNavigationProject,
    sessionAgentId: string,
  ) => {
    const key = `${project.project.id}:${sessionAgentId}`;
    setOpeningDirect(key);
    setActionError('');
    try {
      await onOpenDirect(project.project.id, sessionAgentId);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : 'Could not open this project conversation.',
      );
    } finally {
      setOpeningDirect('');
    }
  };

  return (
    <div className="office-sidebar-nav">
      <section className="office-nav-section office-home-section">
        <button
          className={`nav-item ${officeActive ? 'active' : ''}`}
          aria-current={officeActive ? 'page' : undefined}
          onClick={onOpenOffice}
        >
          <BriefcaseBusiness size={16} />
          <span>My Office</span>
        </button>
        <button className="office-nav-create" onClick={onCreateProject}>
          <Plus size={15} />
          <span>New project</span>
        </button>
      </section>

      <section className="office-nav-section" aria-label="Projects">
        <div className="spaces-heading nav-label">
          <span>PROJECTS</span>
        </div>
        {loadError ? (
          <p className="sidebar-error" role="status">
            {loadError}
          </p>
        ) : !summary ? (
          <p className="sidebar-empty">Loading projects…</p>
        ) : summary.projects.length ? (
          <nav className="office-project-nav" aria-label="Projects">
            {summary.projects.map((item) => (
              <ProjectBranch
                key={item.project.id}
                item={item}
                expanded={expanded.has(item.project.id)}
                active={activeProjectId === item.project.id}
                activeConversationId={activeConversationId}
                showAll={showAllByProject.has(item.project.id)}
                showAllTeam={showAllTeams.has(item.project.id)}
                openingDirect={openingDirect}
                onToggle={() => toggleProject(item.project.id)}
                onOpen={() => onOpenProject(item.project.id)}
                onOpenTeam={() => onOpenProject(item.project.id, 'team')}
                onOpenConversation={(conversationId) =>
                  onOpenConversation(item.project.id, conversationId)
                }
                onOpenAllConversations={() =>
                  onOpenAllConversations(item.project.id)
                }
                onShowAll={() =>
                  setShowAllByProject((current) =>
                    new Set(current).add(item.project.id),
                  )
                }
                onShowLess={() =>
                  setShowAllByProject((current) => {
                    const next = new Set(current);
                    next.delete(item.project.id);
                    return next;
                  })
                }
                onShowAllTeam={() =>
                  setShowAllTeams((current) =>
                    new Set(current).add(item.project.id),
                  )
                }
                onShowLessTeam={() =>
                  setShowAllTeams((current) => {
                    const next = new Set(current);
                    next.delete(item.project.id);
                    return next;
                  })
                }
                onOpenDirect={(id) => void openDirect(item, id)}
              />
            ))}
          </nav>
        ) : (
          <p className="sidebar-empty">No projects yet.</p>
        )}
        {actionError && (
          <p className="sidebar-error" role="status">
            {actionError}
          </p>
        )}
        {!!summary?.archivedProjectCount && (
          <button className="office-nav-subtle" onClick={onOpenOffice}>
            <Archive size={13} /> Archived projects ·{' '}
            {summary.archivedProjectCount}
          </button>
        )}
      </section>

      <section className="office-nav-section" aria-label="Collaborators">
        <div className="spaces-heading nav-label">
          <span>COLLABORATORS</span>
          <button
            className="icon-button"
            aria-label="Create collaborator"
            title="Create collaborator"
            onClick={onCreateDot}
          >
            <Plus size={14} />
          </button>
        </div>
        <nav className="dots-nav" aria-label="Collaborators">
          {collaborators.map(({ dot, profile }) => (
            <div className="office-collaborator-row" key={dot.id}>
              <button
                className="dot-nav office-collaborator-link"
                title={dot.name}
                onClick={() => onOpenDotProfile(dot.id)}
              >
                <Mascot identity={dot.id} name={dot.name} small decorative />
                <span>{dot.name}</span>
                {profile?.skills[0] && (
                  <small className="office-collaborator-skill">
                    {profile.skills[0]}
                  </small>
                )}
              </button>
              <button
                className="icon-button office-collaborator-settings"
                aria-label={`Open native chat with ${dot.name}`}
                title={`Open native chat with ${dot.name}`}
                onClick={() => onOpenNativeDot(dot.id)}
              >
                <MessageCircle size={14} />
              </button>
              <button
                className="icon-button office-collaborator-settings"
                aria-label={`Edit ${dot.name} settings`}
                title={`Edit ${dot.name} settings`}
                onClick={() => onEditDot(dot.id)}
              >
                <MoreHorizontal size={15} />
              </button>
            </div>
          ))}
        </nav>
      </section>

      <section className="office-nav-section" aria-label="Other Spaces">
        <div className="spaces-heading nav-label">
          <span>OTHER SPACES</span>
          <button
            className="icon-button"
            aria-label="Create Space"
            title="Create Space"
            onClick={onCreateSpace}
          >
            <Plus size={14} />
          </button>
        </div>
        <nav className="spaces-nav" aria-label="Other Spaces">
          {otherSpaces.map((space) => (
            <SpaceNav
              key={space.id}
              space={space}
              active={activeSpaceId === space.id}
              onOpen={() => onOpenSpace(space.id)}
            />
          ))}
          {!summary ? (
            <p className="sidebar-empty">Loading Spaces…</p>
          ) : !otherSpaces.length ? (
            <p className="sidebar-empty">No other Spaces.</p>
          ) : null}
        </nav>
      </section>

      <section className="office-nav-section open-dots-section">
        <div className="spaces-heading nav-label">
          <span>OPEN DOTS</span>
          <Users size={14} aria-hidden="true" />
        </div>
        <button
          className="nav-item office-native-new-chat"
          disabled={!nativeChatEnabled}
          onClick={onNewNativeChat}
        >
          <Plus size={15} />
          <span>New chat</span>
        </button>
      </section>
    </div>
  );
}

function ProjectBranch({
  item,
  expanded,
  active,
  activeConversationId,
  showAll,
  showAllTeam,
  openingDirect,
  onToggle,
  onOpen,
  onOpenConversation,
  onOpenTeam,
  onOpenAllConversations,
  onShowAll,
  onShowLess,
  onShowAllTeam,
  onShowLessTeam,
  onOpenDirect,
}: {
  item: OfficeNavigationProject;
  expanded: boolean;
  active: boolean;
  activeConversationId?: string;
  showAll: boolean;
  showAllTeam: boolean;
  openingDirect: string;
  onToggle: () => void;
  onOpen: () => void;
  onOpenConversation: (conversationId: string) => void;
  onOpenTeam: () => void;
  onOpenAllConversations: () => void;
  onShowAll: () => void;
  onShowLess: () => void;
  onShowAllTeam: () => void;
  onShowLessTeam: () => void;
  onOpenDirect: (sessionAgentId: string) => void;
}) {
  const [conversationsOpen, setConversationsOpen] = useState(true);
  const [teamOpen, setTeamOpen] = useState(true);
  const kickoff = item.conversations.find(
    (conversation) =>
      conversation.conversation.id === item.kickoffConversationId,
  );
  const others = item.conversations.filter(
    (conversation) =>
      conversation.conversation.id !== item.kickoffConversationId,
  );
  const visibleConversations = showAll ? others : others.slice(0, 3);
  const team = showAllTeam ? item.members : item.members.slice(0, 5);
  const participantsLabel = (
    participants: OfficeNavigationProject['conversations'][number]['participants'],
  ) => {
    const names = participants.map((participant) => participant.name);
    return names.length > 3
      ? `${names.slice(0, 3).join(', ')} +${names.length - 3}`
      : names.join(', ');
  };
  return (
    <div className={`office-project-branch ${active ? 'active' : ''}`}>
      <div className="office-project-row">
        <button
          className="icon-button office-project-disclosure"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${item.project.name}`}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button
          className={`nav-item office-project-link ${active ? 'active' : ''}`}
          title={item.project.name}
          aria-current={active ? 'page' : undefined}
          onClick={onOpen}
        >
          <Folder size={15} />
          <span>{item.project.name}</span>
        </button>
      </div>
      {expanded && (
        <div className="office-project-children">
          <div className="office-project-child-group">
            <button
              className="office-nav-subheading-toggle"
              aria-expanded={conversationsOpen}
              onClick={() => setConversationsOpen((open) => !open)}
            >
              {conversationsOpen ? (
                <ChevronDown size={12} aria-hidden="true" />
              ) : (
                <ChevronRight size={12} aria-hidden="true" />
              )}
              <span>CONVERSATIONS</span>
            </button>
            {conversationsOpen && (
              <>
                {kickoff && (
                  <button
                    className={`office-project-child ${activeConversationId === kickoff.conversation.id ? 'active' : ''}`}
                    title={kickoff.conversation.title}
                    onClick={() => onOpenConversation(kickoff.conversation.id)}
                  >
                    <MessageCircle size={13} />
                    <span className="office-project-child-label">
                      <span>Kickoff meeting</span>
                      <small>{participantsLabel(kickoff.participants)}</small>
                      {kickoff.lastMessage?.content && (
                        <small className="office-project-last-message">
                          {kickoff.lastMessage.content}
                        </small>
                      )}
                    </span>
                  </button>
                )}
                {visibleConversations.map((item) => (
                  <button
                    className={`office-project-child ${activeConversationId === item.conversation.id ? 'active' : ''}`}
                    key={item.conversation.id}
                    title={item.conversation.title}
                    onClick={() => onOpenConversation(item.conversation.id)}
                  >
                    <MessageCircle size={13} />
                    <span className="office-project-child-label">
                      <span>{item.conversation.title}</span>
                      <small>{participantsLabel(item.participants)}</small>
                      {item.lastMessage?.content && (
                        <small className="office-project-last-message">
                          {item.lastMessage.content}
                        </small>
                      )}
                    </span>
                  </button>
                ))}
                {others.length > 3 && (
                  <button
                    className="office-nav-subtle"
                    onClick={showAll ? onShowLess : onShowAll}
                  >
                    {showAll ? 'Show fewer' : 'Show more'}
                  </button>
                )}
                <button
                  className="office-project-child office-all-conversations"
                  onClick={onOpenAllConversations}
                >
                  <MessageCircle size={13} />
                  <span>All conversations</span>
                </button>
              </>
            )}
          </div>
          <div className="office-project-child-group">
            <button
              className="office-nav-subheading-toggle"
              aria-expanded={teamOpen}
              onClick={() => setTeamOpen((open) => !open)}
            >
              {teamOpen ? (
                <ChevronDown size={12} aria-hidden="true" />
              ) : (
                <ChevronRight size={12} aria-hidden="true" />
              )}
              <span>TEAM</span>
            </button>
            {teamOpen && (
              <>
                {team.map(({ agent, dot }) => (
                  <button
                    className="office-project-member"
                    key={agent.id}
                    title={`${dot.name} — ${agent.role}`}
                    onClick={() => onOpenDirect(agent.id)}
                    disabled={
                      openingDirect === `${item.project.id}:${agent.id}`
                    }
                  >
                    <Mascot
                      identity={dot.id}
                      name={dot.name}
                      small
                      decorative
                    />
                    <span>
                      <b>{dot.name}</b>
                      <small>{agent.role}</small>
                    </span>
                  </button>
                ))}
                {item.members.length > 5 && (
                  <button
                    className="office-nav-subtle"
                    onClick={showAllTeam ? onShowLessTeam : onShowAllTeam}
                  >
                    {showAllTeam ? 'Show fewer members' : 'Show all members'}
                  </button>
                )}
              </>
            )}
          </div>
          <button
            className="office-project-child office-manage-team"
            onClick={onOpenTeam}
          >
            <Users size={13} />
            <span>Manage team</span>
          </button>
        </div>
      )}
    </div>
  );
}
