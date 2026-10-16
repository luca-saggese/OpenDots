import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  BriefcaseBusiness,
  Check,
  ChevronRight,
  MessageCircle,
  Plus,
  Search,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import type {
  Dot,
  DotProfile,
  MasterSession,
  MemberTemplate,
  OrganizationalConversation,
  SessionAgent,
  TeamTemplate,
  TeamTemplatePosition,
  WorkspaceState,
} from '../shared/types';
import { api } from './api';
import { Mascot } from './Mascot';
import { ProjectConversations } from './ProjectConversations';

type RosterItem = {
  dot: Dot;
  profile: DotProfile;
  projects: Array<{
    id: string;
    name: string;
    status: string;
    role: string;
    agentStatus: string;
  }>;
};
type Slot = {
  id: string;
  role: string;
  mandate: string;
  memberTemplateId: string;
  dotId?: string;
  name: string;
  customization: string;
  agentInstructions: string;
  soulInstructions: string;
};
type ProjectResult = { masterSession: MasterSession; agents: SessionAgent[] };
type KickoffResult = {
  conversation: OrganizationalConversation;
  agenda: string;
  started: boolean;
};
const suggestedDotNames = [
  'Aster',
  'Milo',
  'Nora',
  'Orion',
  'Cleo',
  'Remy',
  'Iris',
  'Theo',
  'Vega',
  'Luca',
  'Mira',
  'Ezra',
  'Nova',
  'Sage',
  'Atlas',
  'Ada',
];
const makeSlot = (position?: TeamTemplatePosition): Slot => ({
  id: crypto.randomUUID(),
  role: position?.role ?? '',
  mandate: position?.responsibility ?? '',
  memberTemplateId: position?.memberTemplateId ?? '',
  name: '',
  customization: '',
  agentInstructions: '',
  soulInstructions: '',
});

export function Office({
  workspace,
  onRefresh,
  navigationRequest,
  initialCollaboratorId,
  profileSignal,
  homeSignal,
  createProjectSignal,
  createDotSignal,
  onProjectChange,
  onOpenDirect,
  onConversationChange,
  onNavigationRefresh,
}: {
  workspace: WorkspaceState;
  onRefresh: () => Promise<void>;
  navigationRequest?: {
    projectId: string;
    conversationId?: string;
    tab: 'overview' | 'team' | 'conversations';
    requestId: string;
  };
  initialCollaboratorId?: string;
  profileSignal: number;
  homeSignal: number;
  createProjectSignal: number;
  createDotSignal: number;
  onProjectChange: (projectId?: string) => void;
  onOpenDirect: (projectId: string, sessionAgentId: string) => Promise<void>;
  onConversationChange: (conversationId?: string) => void;
  onNavigationRefresh: () => void;
}) {
  const [roster, setRoster] = useState<RosterItem[]>([]);
  const [members, setMembers] = useState<MemberTemplate[]>([]);
  const [teams, setTeams] = useState<TeamTemplate[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedDot, setSelectedDot] = useState<string>();
  const [profileDraft, setProfileDraft] = useState<{
    name?: string;
    summary: string;
    skills: string;
    workStyle: string;
  }>();
  const [project, setProject] = useState<MasterSession>();
  const [projectTab, setProjectTab] = useState<
    'overview' | 'team' | 'conversations' | 'activity'
  >('overview');
  const [projectAgents, setProjectAgents] = useState<SessionAgent[]>([]);
  const [kickoffConversationId, setKickoffConversationId] = useState<string>();
  const [kickoffAgenda, setKickoffAgenda] = useState('');
  const [kickoffStarted, setKickoffStarted] = useState(false);
  const [kickoffTargets, setKickoffTargets] = useState<string[]>([]);
  const [requestedConversationId, setRequestedConversationId] =
    useState<string>();
  const [showWizard, setShowWizard] = useState(false);
  const [step, setStep] = useState(1);
  const [projectName, setProjectName] = useState('');
  const [description, setDescription] = useState('');
  const [teamId, setTeamId] = useState('custom-team');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [saving, setSaving] = useState(false);
  const [creationKey, setCreationKey] = useState('');
  const [newDotTemplate, setNewDotTemplate] = useState('');
  const [newDotName, setNewDotName] = useState('');
  const [newDotCustomization, setNewDotCustomization] = useState('');
  const [addDotDialog, setAddDotDialog] = useState(false);
  const [addingAgent, setAddingAgent] = useState(false);
  const [selectedExisting, setSelectedExisting] = useState('');
  const [newRole, setNewRole] = useState('');
  const [newMandate, setNewMandate] = useState('');
  const [projectMemberTemplate, setProjectMemberTemplate] = useState('');
  const [projectMemberName, setProjectMemberName] = useState('');
  const [projectMemberCustomization, setProjectMemberCustomization] =
    useState('');
  const [catalogSearch, setCatalogSearch] = useState('');

  const refreshOffice = async () => {
    setLoading(true);
    setError('');
    try {
      const [items, memberCatalog, teamCatalog] = await Promise.all([
        api<RosterItem[]>('/office/dots'),
        api<MemberTemplate[]>('/office/member-templates'),
        api<TeamTemplate[]>('/office/team-templates'),
      ]);
      setRoster(items);
      setMembers(memberCatalog);
      setTeams(teamCatalog);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not load My Office.',
      );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refreshOffice();
  }, []);
  useEffect(() => {
    if (createProjectSignal > 0) startWizard();
  }, [createProjectSignal]);
  useEffect(() => {
    if (createDotSignal > 0) setAddDotDialog(true);
  }, [createDotSignal]);
  useEffect(() => {
    if (homeSignal <= 0) return;
    setProject(undefined);
    setRequestedConversationId(undefined);
    setShowWizard(false);
    onProjectChange(undefined);
  }, [homeSignal]);
  useEffect(() => {
    if (!initialCollaboratorId || !roster.length) return;
    const collaborator = roster.find(
      (item) => item.dot.id === initialCollaboratorId,
    );
    if (!collaborator) return;
    setProject(undefined);
    onProjectChange(undefined);
    setShowWizard(false);
    setSelectedDot(initialCollaboratorId);
    setProfileDraft({
      summary: collaborator.profile.summary,
      skills: collaborator.profile.skills.join(', '),
      workStyle: collaborator.profile.workStyle,
    });
  }, [initialCollaboratorId, profileSignal, roster]);
  const chosenDot = roster.find((item) => item.dot.id === selectedDot);
  const currentTeam = teams.find((item) => item.id === teamId);
  const projectTeamValid =
    slots.length > 0 &&
    slots.every(
      (slot) =>
        !!slot.role.trim() &&
        !!slot.mandate.trim() &&
        (slot.dotId
          ? roster.some((item) => item.dot.id === slot.dotId)
          : !!slot.memberTemplateId && !!slot.name.trim()),
    );
  const filteredMembers = useMemo(() => {
    const needle = catalogSearch.trim().toLocaleLowerCase();
    return members.filter(
      (member) =>
        !needle ||
        [member.name, member.category, member.description, ...member.tags].some(
          (item) => item.toLocaleLowerCase().includes(needle),
        ),
    );
  }, [members, catalogSearch]);
  const initializeKickoff = async (masterSessionId: string) => {
    setError('');
    const kickoff = await api<KickoffResult>(
      `/office/projects/${masterSessionId}/kickoff`,
      'PUT',
      {},
    );
    setKickoffConversationId(kickoff.conversation.id);
    setKickoffAgenda(kickoff.agenda);
    setKickoffStarted(kickoff.started);
    setKickoffTargets([]);
    onNavigationRefresh();
    return kickoff;
  };
  const openProject = async (id: string) => {
    setError('');
    try {
      const [details, agents] = await Promise.all([
        api<MasterSession & { agents: SessionAgent[] }>(
          `/master-sessions/${id}`,
        ),
        api<SessionAgent[]>(`/master-sessions/${id}/agents`),
      ]);
      setProject(details);
      onProjectChange(id);
      onConversationChange(undefined);
      setProjectAgents(agents);
      setKickoffConversationId(undefined);
      setKickoffAgenda('');
      setKickoffStarted(false);
      setKickoffTargets([]);
      setProjectTab('overview');
      try {
        await initializeKickoff(id);
      } catch (kickoffError) {
        setError(
          kickoffError instanceof Error
            ? `Project opened, but kickoff setup failed: ${kickoffError.message}`
            : 'Project opened, but kickoff setup failed.',
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open project.');
    }
  };
  useEffect(() => {
    if (!navigationRequest) return;
    let current = true;
    void (async () => {
      await openProject(navigationRequest.projectId);
      if (!current) return;
      setProjectTab(navigationRequest.tab);
      if (navigationRequest.conversationId)
        setRequestedConversationId(navigationRequest.conversationId);
      else setRequestedConversationId(undefined);
    })();
    return () => {
      current = false;
    };
  }, [navigationRequest?.requestId]);
  const startWizard = () => {
    setProject(undefined);
    setShowWizard(true);
    setStep(1);
    setProjectName('');
    setDescription('');
    setTeamId('custom-team');
    setSlots([]);
    setCreationKey(crypto.randomUUID());
    setError('');
  };
  const chooseTeam = (id: string) => {
    setTeamId(id);
    const positions = (teams.find((team) => team.id === id)?.positions ?? [])
      .map(makeSlot)
      .map((slot) => {
        const template = members.find(
          (item) => item.id === slot.memberTemplateId,
        );
        return template
          ? {
              ...slot,
              agentInstructions: template.agentInstructions,
              soulInstructions: template.soulInstructions,
            }
          : slot;
      });
    setSlots(assignSuggestedNames(positions));
  };
  const assignSuggestedNames = (input: Slot[]) => {
    const used = new Set(
      roster.map((item) => item.dot.name.trim().toLowerCase()),
    );
    return input.map((slot) => {
      if (slot.dotId) return { ...slot, name: '' };
      const currentName = slot.name.trim();
      if (currentName && !used.has(currentName.toLowerCase())) {
        used.add(currentName.toLowerCase());
        return slot;
      }
      const availableNames = suggestedDotNames.filter(
        (candidate) => !used.has(candidate.toLowerCase()),
      );
      let name =
        availableNames[Math.floor(Math.random() * availableNames.length)];
      if (!name) {
        let suffix = 1;
        while (used.has(`dot ${suffix}`)) suffix += 1;
        name = `Dot ${suffix}`;
      }
      used.add(name.toLowerCase());
      return { ...slot, name };
    });
  };
  const updateSlot = (id: string, patch: Partial<Slot>) =>
    setSlots((current) =>
      current.map((slot) => {
        if (slot.id !== id) return slot;
        if (
          patch.memberTemplateId &&
          patch.memberTemplateId !== slot.memberTemplateId
        ) {
          const template = members.find(
            (item) => item.id === patch.memberTemplateId,
          );
          return {
            ...slot,
            ...patch,
            agentInstructions: template?.agentInstructions ?? '',
            soulInstructions: template?.soulInstructions ?? '',
          };
        }
        return { ...slot, ...patch };
      }),
    );
  const startNewDot = async () => {
    if (!newDotTemplate || !newDotName.trim()) return;
    setSaving(true);
    setError('');
    try {
      await api('/office/dots/from-template', 'POST', {
        memberTemplateId: newDotTemplate,
        name: newDotName,
        customization: newDotCustomization,
      });
      await Promise.all([refreshOffice(), onRefresh()]);
      onNavigationRefresh();
      setAddDotDialog(false);
      setNewDotTemplate('');
      setNewDotName('');
      setNewDotCustomization('');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not create collaborator.',
      );
    } finally {
      setSaving(false);
    }
  };
  const confirmProject = async () => {
    setSaving(true);
    setError('');
    try {
      const result = await api<ProjectResult>('/office/projects', 'POST', {
        creationKey,
        name: projectName,
        description,
        team: slots.map((slot) => ({
          ...(slot.dotId
            ? { dotId: slot.dotId }
            : {
                id: slot.id,
                memberTemplateId: slot.memberTemplateId,
                name: slot.name,
                customization: slot.customization,
                agentInstructions: slot.agentInstructions,
                soulInstructions: slot.soulInstructions,
              }),
          role: slot.role,
          mandate: slot.mandate,
        })),
      });
      await onRefresh();
      await refreshOffice();
      setShowWizard(false);
      setProject(result.masterSession);
      onProjectChange(result.masterSession.id);
      onConversationChange(undefined);
      onNavigationRefresh();
      setProjectAgents(result.agents);
      setProjectTab('overview');
      try {
        await initializeKickoff(result.masterSession.id);
        setProjectTab('conversations');
      } catch (kickoffError) {
        setError(
          kickoffError instanceof Error
            ? `Project created, but kickoff setup failed: ${kickoffError.message}`
            : 'Project created, but kickoff setup failed.',
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not create project. You can retry safely.',
      );
    } finally {
      setSaving(false);
    }
  };
  const addExistingToProject = async () => {
    if (
      !project ||
      !selectedExisting ||
      !newRole.trim() ||
      !newMandate.trim() ||
      addingAgent
    )
      return;
    setAddingAgent(true);
    setError('');
    try {
      const result = await api<{ agent: SessionAgent }>(
        `/office/projects/${project.id}/team`,
        'POST',
        { dotId: selectedExisting, role: newRole, mandate: newMandate },
      );
      setProjectAgents((current) => [...current, result.agent]);
      setSelectedExisting('');
      setNewRole('');
      setNewMandate('');
      await onRefresh();
      await refreshOffice();
      onNavigationRefresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not assign this collaborator.',
      );
    } finally {
      setAddingAgent(false);
    }
  };
  const addNewToProject = async () => {
    if (
      !project ||
      !projectMemberTemplate ||
      !projectMemberName.trim() ||
      !newRole.trim() ||
      !newMandate.trim() ||
      addingAgent
    )
      return;
    setAddingAgent(true);
    setError('');
    try {
      const result = await api<{ agent: SessionAgent }>(
        `/office/projects/${project.id}/team`,
        'POST',
        {
          memberTemplateId: projectMemberTemplate,
          name: projectMemberName,
          customization: projectMemberCustomization,
          role: newRole,
          mandate: newMandate,
        },
      );
      setProjectAgents((current) => [...current, result.agent]);
      setProjectMemberTemplate('');
      setProjectMemberName('');
      setProjectMemberCustomization('');
      setNewRole('');
      setNewMandate('');
      await onRefresh();
      await refreshOffice();
      onNavigationRefresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not add this collaborator.',
      );
    } finally {
      setAddingAgent(false);
    }
  };
  return (
    <main className="main-content office-page">
      <div className="office-heading">
        <div>
          <span className="eyebrow">COLLABORATIVE DOTS WITH MEMORY</span>
          <h1>{project ? project.name : 'My Office'}</h1>
          <p>
            {project
              ? project.description ||
                'Project overview and assigned collaborators.'
              : 'Your permanent collaborators and the projects they work on.'}
          </p>
        </div>
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      {project ? (
        <section className="office-project">
          <nav className="project-tabs" aria-label="Project sections">
            {(['conversations', 'team', 'overview', 'activity'] as const).map(
              (tab) => (
                <button
                  key={tab}
                  className={projectTab === tab ? 'active' : ''}
                  aria-current={projectTab === tab ? 'page' : undefined}
                  onClick={() => setProjectTab(tab)}
                >
                  {tab}
                </button>
              ),
            )}
          </nav>
          {projectTab === 'overview' && (
            <section className="project-overview">
              <div className="office-section-head">
                <div>
                  <span className="eyebrow">PROJECT OVERVIEW</span>
                  <h2>{project.name}</h2>
                </div>
                <span className={`project-status ${project.status}`}>
                  {project.status}
                </span>
              </div>
              <p>
                {project.description ||
                  'No project description has been added.'}
              </p>
              <div className="project-overview-stats">
                <article>
                  <b>{projectAgents.length}</b>
                  <span>Assigned collaborators</span>
                </article>
                <article>
                  <b>
                    {
                      projectAgents.filter((agent) => agent.status === 'active')
                        .length
                    }
                  </b>
                  <span>Active project members</span>
                </article>
              </div>
              <button
                className="secondary-button"
                onClick={() => setProjectTab('team')}
              >
                Manage team <ChevronRight size={14} />
              </button>
              {!kickoffConversationId ? (
                <button
                  className="primary"
                  onClick={() =>
                    void initializeKickoff(project.id).catch((e) =>
                      setError(
                        e instanceof Error
                          ? `Could not prepare kickoff: ${e.message}`
                          : 'Could not prepare kickoff.',
                      ),
                    )
                  }
                >
                  Retry kickoff setup
                </button>
              ) : (
                <button
                  className="primary"
                  onClick={() => setProjectTab('conversations')}
                >
                  Open kickoff <ChevronRight size={14} />
                </button>
              )}
            </section>
          )}
          {projectTab === 'team' && (
            <>
              <div className="office-section-head">
                <div>
                  <span className="eyebrow">PROJECT TEAM</span>
                  <h2>Assigned collaborators</h2>
                </div>
                <span className={`project-status ${project.status}`}>
                  {project.status}
                </span>
              </div>
              <div className="office-roster-grid">
                {projectAgents.map((agent) => {
                  const person = roster.find(
                    (item) => item.dot.id === agent.dotId,
                  );
                  const name =
                    person?.dot.name ?? agent.displayName ?? 'Collaborator';
                  return (
                    <article className="office-card" key={agent.id}>
                      <div className="office-card-title office-project-member-title">
                        <div className="office-project-member-identity">
                          <Mascot
                            identity={agent.dotId}
                            name={name}
                            small
                            decorative
                          />
                          <div>
                            <h3>{name}</h3>
                            <small>
                              {agent.role} · {agent.status}
                            </small>
                          </div>
                        </div>
                        <div className="office-project-member-actions">
                          <button
                            className="office-member-icon-action"
                            aria-label={`Talk with ${name}`}
                            title={`Talk with ${name}`}
                            onClick={() =>
                              void onOpenDirect(project.id, agent.id)
                            }
                          >
                            <MessageCircle size={16} aria-hidden="true" />
                          </button>
                          <button
                            className="office-member-icon-action"
                            aria-label={`Open ${name}'s collaborator profile`}
                            title="Open collaborator profile"
                            onClick={() => {
                              if (!person) return;
                              setSelectedDot(agent.dotId);
                              setProfileDraft({
                                summary: person.profile.summary,
                                skills: person.profile.skills.join(', '),
                                workStyle: person.profile.workStyle,
                              });
                            }}
                          >
                            <UserRound size={16} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                      <p>
                        {person?.profile.summary ||
                          person?.dot.instructions.slice(0, 180) ||
                          'Profile summary not set.'}
                      </p>
                      <div className="office-skills">
                        {person?.profile.skills.slice(0, 5).map((skill) => (
                          <span key={skill}>{skill}</span>
                        ))}
                      </div>
                      <p className="office-mandate">
                        <b>Project mandate</b>
                        {agent.mandate}
                      </p>
                    </article>
                  );
                })}
              </div>
              <section className="office-add-member">
                <h3>Add an existing collaborator</h3>
                <p>
                  Reuse a permanent Dot with a role and mandate for this
                  project.
                </p>
                <div className="office-add-row">
                  <select
                    aria-label="Choose collaborator"
                    value={selectedExisting}
                    onChange={(e) => setSelectedExisting(e.target.value)}
                  >
                    <option value="">Choose a Dot…</option>
                    {roster
                      .filter(
                        (item) =>
                          !projectAgents.some(
                            (agent) => agent.dotId === item.dot.id,
                          ),
                      )
                      .map((item) => (
                        <option value={item.dot.id} key={item.dot.id}>
                          {item.dot.name}
                        </option>
                      ))}
                  </select>
                  <input
                    aria-label="Project role"
                    placeholder="Project role"
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value)}
                  />
                  <input
                    aria-label="Project mandate"
                    placeholder="Project mandate"
                    value={newMandate}
                    onChange={(e) => setNewMandate(e.target.value)}
                  />
                  <button
                    className="primary"
                    disabled={
                      addingAgent ||
                      !selectedExisting ||
                      !newRole.trim() ||
                      !newMandate.trim()
                    }
                    onClick={() => void addExistingToProject()}
                  >
                    {addingAgent ? 'Adding…' : 'Add to project'}
                  </button>
                </div>
              </section>
              <section className="office-add-member">
                <h3>Hire a new collaborator</h3>
                <p>
                  Choose any archetype from the global catalog. The Dot and
                  assignment are created together.
                </p>
                <div className="office-add-row">
                  <select
                    aria-label="Choose member archetype"
                    value={projectMemberTemplate}
                    onChange={(e) => {
                      setProjectMemberTemplate(e.target.value);
                      setProjectMemberName(
                        members.find((item) => item.id === e.target.value)
                          ?.name ?? '',
                      );
                    }}
                  >
                    <option value="">Choose any archetype…</option>
                    {members.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {item.category}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="New collaborator name"
                    placeholder="Collaborator name"
                    value={projectMemberName}
                    onChange={(e) => setProjectMemberName(e.target.value)}
                  />
                  <input
                    aria-label="Project role for new collaborator"
                    placeholder="Project role"
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value)}
                  />
                  <input
                    aria-label="Project mandate for new collaborator"
                    placeholder="Project mandate"
                    value={newMandate}
                    onChange={(e) => setNewMandate(e.target.value)}
                  />
                  <textarea
                    aria-label="Permanent Dot customization"
                    placeholder="Optional permanent AGENT/SOUL customization"
                    value={projectMemberCustomization}
                    onChange={(e) =>
                      setProjectMemberCustomization(e.target.value)
                    }
                  />
                  <button
                    className="primary"
                    disabled={
                      addingAgent ||
                      !projectMemberTemplate ||
                      !projectMemberName.trim() ||
                      !newRole.trim() ||
                      !newMandate.trim()
                    }
                    onClick={() => void addNewToProject()}
                  >
                    {addingAgent ? 'Adding…' : 'Create and assign'}
                  </button>
                </div>
              </section>
            </>
          )}
          {projectTab === 'conversations' && (
            <ProjectConversations
              masterSessionId={project.id}
              agents={projectAgents}
              roster={roster}
              kickoffConversationId={kickoffConversationId}
              kickoffAgenda={kickoffAgenda}
              kickoffStarted={kickoffStarted}
              onStartKickoff={async () => {
                const result = await api<{
                  targets: string[];
                  started: boolean;
                }>(`/office/projects/${project.id}/kickoff/start`, 'POST', {});
                setKickoffStarted(result.started);
                setKickoffTargets(result.targets);
                return result.targets;
              }}
              kickoffTargets={kickoffTargets}
              requestedConversationId={requestedConversationId}
              onConversationChange={onConversationChange}
              onNavigationRefresh={onNavigationRefresh}
              onOpenDirect={onOpenDirect}
            />
          )}
          {projectTab === 'activity' && (
            <div className="large-empty">
              <h2>Project activity</h2>
              <p>No project activity log is available yet.</p>
            </div>
          )}
        </section>
      ) : (
        <>
          <div className="office-section-head">
            <div>
              <span className="eyebrow">PERMANENT COLLABORATORS</span>
              <h2>Your roster</h2>
            </div>
            <button
              className="secondary-button"
              onClick={() => setAddDotDialog(true)}
            >
              <Plus size={15} />
              New collaborator
            </button>
          </div>
          {loading ? (
            <div className="large-empty">Loading your collaborators…</div>
          ) : roster.length ? (
            <div className="office-roster-grid">
              {roster.map(({ dot, profile, projects }) => (
                <article className="office-card" key={dot.id}>
                  <div className="office-card-title">
                    <Mascot
                      identity={dot.id}
                      name={dot.name}
                      small
                      decorative
                    />
                    <div>
                      <h3>{dot.name}</h3>
                      <small>
                        {profile.memberTemplateId
                          ? (members.find(
                              (item) => item.id === profile.memberTemplateId,
                            )?.name ?? 'Member Template')
                          : 'Permanent collaborator'}
                      </small>
                    </div>
                  </div>
                  <p>{profile.summary || dot.instructions.slice(0, 200)}</p>
                  <div className="office-skills">
                    {profile.skills.map((skill) => (
                      <span key={skill}>{skill}</span>
                    ))}
                  </div>
                  <p className="office-workstyle">
                    {profile.workStyle || 'Work style not set yet.'}
                  </p>
                  <div className="office-project-list">
                    <b>Projects</b>
                    {projects.length ? (
                      projects.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => void openProject(item.id)}
                        >
                          {item.name}
                          <small>
                            {item.role} · {item.status}
                          </small>
                        </button>
                      ))
                    ) : (
                      <span>No project assignments yet.</span>
                    )}
                  </div>
                  <button
                    className="text-button"
                    onClick={() => {
                      setSelectedDot(dot.id);
                      setProfileDraft({
                        summary: profile.summary,
                        skills: profile.skills.join(', '),
                        workStyle: profile.workStyle,
                      });
                    }}
                  >
                    Edit profile <ChevronRight size={14} />
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <div className="large-empty">
              <BriefcaseBusiness size={34} />
              <h2>Your office starts with its people.</h2>
              <p>
                Create a collaborator from a professional archetype, or begin a
                project and hire a team.
              </p>
              <button className="primary" onClick={() => setAddDotDialog(true)}>
                Browse collaborators
              </button>
            </div>
          )}
          <div className="office-section-head projects-head">
            <div>
              <span className="eyebrow">MY PROJECTS</span>
              <h2>Projects</h2>
            </div>
            <button className="primary" onClick={startWizard}>
              <Plus size={16} />
              Create project
            </button>
          </div>
          <div className="office-project-grid">
            {(workspace.masterSessions ?? []).map((item) => (
              <button
                className="office-project-card"
                key={item.id}
                onClick={() => void openProject(item.id)}
              >
                <span className="office-avatar">
                  <BriefcaseBusiness size={18} />
                </span>
                <strong>{item.name}</strong>
                <span>{item.description || 'No project description.'}</span>
                <small>
                  {item.status} <ChevronRight size={13} />
                </small>
              </button>
            ))}
          </div>
        </>
      )}

      {profileDraft && chosenDot && (
        <div
          className="modal-backdrop"
          onClick={() => setProfileDraft(undefined)}
        >
          <section
            className="modal office-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="Close profile editor"
              onClick={() => setProfileDraft(undefined)}
            >
              <X size={18} />
            </button>
            <span className="eyebrow">PERMANENT PROFILE</span>
            <h2 id="profile-title">{chosenDot.dot.name}</h2>
            <label className="field-label" htmlFor="profile-name">
              Permanent collaborator name
            </label>
            <input
              id="profile-name"
              maxLength={40}
              value={profileDraft.name ?? chosenDot.dot.name}
              onChange={(event) =>
                setProfileDraft({ ...profileDraft, name: event.target.value })
              }
            />
            <label className="field-label" htmlFor="profile-summary">
              Professional summary
            </label>
            <textarea
              id="profile-summary"
              value={profileDraft.summary}
              maxLength={2000}
              onChange={(e) =>
                setProfileDraft({ ...profileDraft, summary: e.target.value })
              }
            />
            <label className="field-label" htmlFor="profile-skills">
              Skills, separated by commas
            </label>
            <input
              id="profile-skills"
              value={profileDraft.skills}
              onChange={(e) =>
                setProfileDraft({ ...profileDraft, skills: e.target.value })
              }
            />
            <label className="field-label" htmlFor="profile-style">
              Working style
            </label>
            <textarea
              id="profile-style"
              value={profileDraft.workStyle}
              maxLength={2000}
              onChange={(e) =>
                setProfileDraft({ ...profileDraft, workStyle: e.target.value })
              }
            />
            <button
              className="primary"
              disabled={!(profileDraft.name ?? chosenDot.dot.name).trim()}
              onClick={async () => {
                try {
                  await api(`/office/dots/${chosenDot.dot.id}/name`, 'PUT', {
                    name: profileDraft.name ?? chosenDot.dot.name,
                  });
                  await api(`/office/dots/${chosenDot.dot.id}/profile`, 'PUT', {
                    summary: profileDraft.summary,
                    skills: profileDraft.skills
                      .split(',')
                      .map((x) => x.trim())
                      .filter(Boolean),
                    workStyle: profileDraft.workStyle,
                  });
                  setProfileDraft(undefined);
                  await refreshOffice();
                  await onRefresh();
                } catch (err) {
                  setError(
                    err instanceof Error
                      ? err.message
                      : 'Could not save profile.',
                  );
                }
              }}
            >
              Save profile
            </button>
          </section>
        </div>
      )}
      {addDotDialog && (
        <div className="modal-backdrop" onClick={() => setAddDotDialog(false)}>
          <section
            className="modal office-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-dot-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="Close"
              onClick={() => setAddDotDialog(false)}
            >
              <X size={18} />
            </button>
            <span className="eyebrow">GLOBAL MEMBER CATALOG</span>
            <h2 id="new-dot-title">Create a collaborator</h2>
            <label className="field-label" htmlFor="catalog-search">
              Find an archetype
            </label>
            <div className="office-search">
              <Search size={16} />
              <input
                id="catalog-search"
                value={catalogSearch}
                onChange={(e) => setCatalogSearch(e.target.value)}
                placeholder="Search all categories"
              />
            </div>
            <div className="office-template-list">
              {filteredMembers.map((member) => (
                <button
                  className={`office-template-option ${newDotTemplate === member.id ? 'selected' : ''}`}
                  key={member.id}
                  onClick={() => {
                    setNewDotTemplate(member.id);
                    setNewDotName(member.name);
                  }}
                >
                  <b>{member.name}</b>
                  <small>
                    {member.category} · {member.skills.slice(0, 3).join(', ')}
                  </small>
                  <span>{member.description}</span>
                </button>
              ))}
            </div>
            {newDotTemplate && (
              <>
                <label className="field-label" htmlFor="new-dot-name">
                  Collaborator name
                </label>
                <input
                  id="new-dot-name"
                  value={newDotName}
                  onChange={(e) => setNewDotName(e.target.value)}
                />
                <label className="field-label" htmlFor="new-dot-custom">
                  Permanent instruction customization
                </label>
                <textarea
                  id="new-dot-custom"
                  value={newDotCustomization}
                  onChange={(e) => setNewDotCustomization(e.target.value)}
                  placeholder="This text is saved as an explicit AGENT/SOUL instruction override."
                />
                <button
                  className="primary"
                  disabled={saving}
                  onClick={() => void startNewDot()}
                >
                  {saving ? 'Creating…' : 'Create collaborator'}
                </button>
              </>
            )}
          </section>
        </div>
      )}

      {showWizard && (
        <div className="modal-backdrop office-wizard-backdrop">
          <section
            className="modal office-wizard"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wizard-title"
          >
            <button
              className="modal-close icon-button"
              aria-label="Close project wizard"
              onClick={() => !saving && setShowWizard(false)}
            >
              <X size={18} />
            </button>
            <span className="eyebrow">PROJECT SETUP · STEP {step} OF 3</span>
            <div className="office-steps">
              {['Project', 'Team', 'Review'].map((label, index) => (
                <span
                  className={
                    step === index + 1
                      ? 'active'
                      : step > index + 1
                        ? 'done'
                        : ''
                  }
                  key={label}
                >
                  {step > index + 1 ? <Check size={13} /> : index + 1} {label}
                </span>
              ))}
            </div>
            {step === 1 && (
              <>
                <h2 id="wizard-title">What are you working on?</h2>
                <label className="field-label" htmlFor="project-name">
                  Project name
                </label>
                <input
                  id="project-name"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="A new book, product, or idea"
                />
                <label className="field-label" htmlFor="project-description">
                  Description and goal
                </label>
                <textarea
                  id="project-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe what success looks like."
                />
                <label className="field-label" htmlFor="team-template">
                  Start with a team template
                </label>
                <select
                  id="team-template"
                  value={teamId}
                  onChange={(e) => chooseTeam(e.target.value)}
                >
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
                <p className="muted">
                  The team is only a suggestion. You can change every position.
                </p>
              </>
            )}
            {step === 2 && (
              <>
                <h2 id="wizard-title">Shape your suggested team</h2>
                <p>
                  {currentTeam?.description ??
                    'Set up each project role and choose who fills it.'}
                </p>
                {!projectTeamValid && (
                  <p className="chat-error" role="alert">
                    Add a role, responsibility, and archetype for each position.
                  </p>
                )}
                <div className="office-slot-list">
                  {slots.map((slot) => {
                    const existing = roster.find(
                      (item) => item.dot.id === slot.dotId,
                    );
                    const dot = existing?.dot;
                    const archetype = members.find(
                      (member) => member.id === slot.memberTemplateId,
                    );
                    const displayName =
                      dot?.name ||
                      slot.name.trim() ||
                      archetype?.name ||
                      'Dot to choose';
                    return (
                      <article className="office-slot" key={slot.id}>
                        <div className="office-slot-heading">
                          <div className="office-slot-person">
                            <Mascot
                              identity={dot?.id ?? slot.id}
                              name={displayName}
                              small
                              decorative
                            />
                            <span>
                              <b>{displayName}</b>
                              <small>
                                {dot
                                  ? 'Assigned to this project'
                                  : 'New project Dot'}
                              </small>
                            </span>
                          </div>
                        </div>
                        <div className="office-slot-fields">
                          <label>
                            Role
                            <input
                              aria-label="Role name"
                              value={slot.role}
                              onChange={(e) =>
                                updateSlot(slot.id, { role: e.target.value })
                              }
                            />
                          </label>
                          <label>
                            Responsibility / mandate
                            <input
                              aria-label="Role responsibility"
                              value={slot.mandate}
                              onChange={(e) =>
                                updateSlot(slot.id, { mandate: e.target.value })
                              }
                            />
                          </label>
                          <label>
                            Suggested archetype
                            <select
                              value={slot.memberTemplateId}
                              onChange={(e) =>
                                updateSlot(slot.id, {
                                  memberTemplateId: e.target.value,
                                  dotId: undefined,
                                })
                              }
                            >
                              <option value="">Choose later</option>
                              {members.map((member) => (
                                <option key={member.id} value={member.id}>
                                  {member.name} · {member.category}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <div className="office-slot-assignment">
                          <label>
                            <span>Dot for this role</span>
                            <select
                              aria-label={`Dot for ${slot.role || 'this role'}`}
                              value={slot.dotId ?? ''}
                              onChange={(e) => {
                                const dotId = e.target.value || undefined;
                                setSlots((current) =>
                                  assignSuggestedNames(
                                    current.map((item) =>
                                      item.id === slot.id
                                        ? {
                                            ...item,
                                            dotId,
                                            name: '',
                                            memberTemplateId: dotId
                                              ? ''
                                              : item.memberTemplateId,
                                          }
                                        : item,
                                    ),
                                  ),
                                );
                              }}
                            >
                              <option value="">
                                Create new Dot · {slot.name}
                              </option>
                              {roster
                                .filter(
                                  (item) =>
                                    !slots.some(
                                      (other) =>
                                        other.id !== slot.id &&
                                        other.dotId === item.dot.id,
                                    ),
                                )
                                .map((item) => (
                                  <option key={item.dot.id} value={item.dot.id}>
                                    {item.dot.name}
                                  </option>
                                ))}
                            </select>
                          </label>
                          {dot && existing && (
                            <div className="office-slot-profile">
                              <b>{existing.profile.summary || dot.name}</b>
                              <div className="office-skills">
                                {existing.profile.skills.map((skill) => (
                                  <span key={skill}>{skill}</span>
                                ))}
                              </div>
                            </div>
                          )}
                          {!slot.dotId && archetype && (
                            <div className="office-slot-template-profile">
                              <div>
                                <b>{archetype.name}</b>
                                <span>{archetype.category}</span>
                              </div>
                              <p>{archetype.description}</p>
                              <div className="office-skills">
                                {archetype.skills.map((skill) => (
                                  <span key={skill}>{skill}</span>
                                ))}
                              </div>
                              <details className="office-instruction-editor">
                                <summary>Review and edit AGENT / SOUL</summary>
                                <label>
                                  AGENT · skills, responsibilities, methods,
                                  quality criteria
                                  <textarea
                                    value={
                                      slot.agentInstructions ||
                                      archetype.agentInstructions
                                    }
                                    onChange={(e) =>
                                      updateSlot(slot.id, {
                                        agentInstructions: e.target.value,
                                      })
                                    }
                                  />
                                </label>
                                <label>
                                  SOUL · personality and collaboration style
                                  <textarea
                                    value={
                                      slot.soulInstructions ||
                                      archetype.soulInstructions
                                    }
                                    onChange={(e) =>
                                      updateSlot(slot.id, {
                                        soulInstructions: e.target.value,
                                      })
                                    }
                                  />
                                </label>
                                <div className="office-effective-config">
                                  <b>Effective permanent configuration</b>
                                  <p>
                                    {slot.agentInstructions ||
                                      archetype.agentInstructions}
                                  </p>
                                  {slot.customization.trim() && (
                                    <p>
                                      Owner customization: {slot.customization}
                                    </p>
                                  )}
                                  <p>
                                    <b>SOUL:</b>{' '}
                                    {slot.soulInstructions ||
                                      archetype.soulInstructions}
                                  </p>
                                </div>
                              </details>
                            </div>
                          )}
                          {!slot.dotId && archetype && (
                            <label>
                              <span>Permanent customization (optional)</span>
                              <textarea
                                aria-label={`Personalization for ${slot.name}`}
                                placeholder="Add enduring professional context for this Dot"
                                value={slot.customization}
                                onChange={(e) =>
                                  updateSlot(slot.id, {
                                    customization: e.target.value,
                                  })
                                }
                              />
                            </label>
                          )}
                        </div>
                        <div className="office-slot-buttons">
                          <button
                            className="quiet-button"
                            onClick={() =>
                              setSlots((current) =>
                                assignSuggestedNames([
                                  ...current,
                                  {
                                    ...slot,
                                    id: crypto.randomUUID(),
                                    role: `${slot.role} 2`,
                                    name: '',
                                    dotId: undefined,
                                  },
                                ]),
                              )
                            }
                          >
                            Duplicate
                          </button>
                          <button
                            className="quiet-button"
                            onClick={() =>
                              setSlots((current) =>
                                current.filter((item) => item.id !== slot.id),
                              )
                            }
                          >
                            Remove
                          </button>
                        </div>
                      </article>
                    );
                  })}
                  <button
                    className="secondary-button"
                    onClick={() =>
                      setSlots((current) =>
                        assignSuggestedNames([...current, makeSlot()]),
                      )
                    }
                  >
                    <Plus size={15} />
                    Add a position
                  </button>
                </div>
              </>
            )}
            {step === 3 && (
              <>
                <h2 id="wizard-title">Review and create</h2>
                <div className="office-review">
                  <h3>{projectName}</h3>
                  <p>{description || 'No project description.'}</p>
                  <small>Template: {currentTeam?.name ?? 'Custom team'}</small>
                  {slots.map((slot) => {
                    const template = members.find(
                      (member) => member.id === slot.memberTemplateId,
                    );
                    const existing = roster.find(
                      (item) => item.dot.id === slot.dotId,
                    );
                    return (
                      <article key={slot.id}>
                        <b>{slot.role}</b>
                        <span>
                          {slot.dotId
                            ? `Reuse ${existing?.dot.name ?? 'existing Dot'}`
                            : `Create ${slot.name} · ${template?.name ?? 'no template'}`}
                        </span>
                        {template && (
                          <small>
                            {template.description} ·{' '}
                            {template.skills.join(', ')}
                          </small>
                        )}
                        <small>Project mandate: {slot.mandate}</small>
                        {!slot.dotId && template && (
                          <details>
                            <summary>Instructions that will be saved</summary>
                            <small>
                              AGENT:{' '}
                              {slot.agentInstructions ||
                                template.agentInstructions}
                            </small>
                            {slot.customization.trim() && (
                              <small>
                                Permanent customization: {slot.customization}
                              </small>
                            )}
                            <small>
                              SOUL:{' '}
                              {slot.soulInstructions ||
                                template.soulInstructions}
                            </small>
                          </details>
                        )}
                        {existing && (
                          <small>
                            Existing permanent identity will be reused; mandate
                            remains specific to this project.
                          </small>
                        )}
                      </article>
                    );
                  })}
                </div>
                <p className="muted">
                  Confirmation creates the project workspace, any new
                  collaborators, and their project assignments together.
                  Retrying uses the same request key.
                </p>
              </>
            )}
            <div className="office-wizard-footer">
              {step > 1 && (
                <button
                  className="secondary-button"
                  disabled={saving}
                  onClick={() => setStep(step - 1)}
                >
                  <ArrowLeft size={15} />
                  Back
                </button>
              )}
              <span />
              {step < 3 ? (
                <button
                  className="primary"
                  disabled={
                    (step === 1 && !projectName.trim()) ||
                    (step === 2 && !projectTeamValid)
                  }
                  onClick={() => setStep(step + 1)}
                >
                  Continue
                  <ChevronRight size={15} />
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={saving || slots.length === 0}
                  onClick={() => void confirmProject()}
                >
                  {saving ? 'Creating…' : 'Create project'}
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
