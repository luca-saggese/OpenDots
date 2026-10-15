import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  BriefcaseBusiness,
  Check,
  ChevronRight,
  Plus,
  Search,
  Users,
  X,
} from 'lucide-react';
import type {
  Dot,
  DotProfile,
  MasterSession,
  MemberTemplate,
  SessionAgent,
  TeamTemplate,
  TeamTemplatePosition,
  WorkspaceState,
} from '../shared/types';
import { api } from './api';

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
  included: boolean;
};
type ProjectResult = { masterSession: MasterSession; agents: SessionAgent[] };
const makeSlot = (position?: TeamTemplatePosition): Slot => ({
  id: crypto.randomUUID(),
  role: position?.role ?? '',
  mandate: position?.responsibility ?? '',
  memberTemplateId: position?.memberTemplateId ?? '',
  name: '',
  customization: '',
  included: true,
});

export function Office({
  workspace,
  onRefresh,
}: {
  workspace: WorkspaceState;
  onRefresh: () => Promise<void>;
}) {
  const [roster, setRoster] = useState<RosterItem[]>([]);
  const [members, setMembers] = useState<MemberTemplate[]>([]);
  const [teams, setTeams] = useState<TeamTemplate[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedDot, setSelectedDot] = useState<string>();
  const [profileDraft, setProfileDraft] = useState<{
    summary: string;
    skills: string;
    workStyle: string;
  }>();
  const [project, setProject] = useState<MasterSession>();
  const [projectAgents, setProjectAgents] = useState<SessionAgent[]>([]);
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
  const chosenDot = roster.find((item) => item.dot.id === selectedDot);
  const currentTeam = teams.find((item) => item.id === teamId);
  const projectTeamValid = slots
    .filter((slot) => slot.included)
    .every((slot) => !!slot.role.trim() && !!slot.mandate.trim());
  const hiringValid = slots
    .filter((slot) => slot.included)
    .every((slot) =>
      slot.dotId
        ? roster.some((item) => item.dot.id === slot.dotId)
        : !!slot.memberTemplateId && !!slot.name.trim(),
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
  const openProject = async (id: string) => {
    try {
      const [details, agents] = await Promise.all([
        api<MasterSession & { agents: SessionAgent[] }>(
          `/master-sessions/${id}`,
        ),
        api<SessionAgent[]>(`/master-sessions/${id}/agents`),
      ]);
      setProject(details);
      setProjectAgents(agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open project.');
    }
  };
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
    setSlots(
      (teams.find((team) => team.id === id)?.positions ?? []).map(makeSlot),
    );
  };
  const updateSlot = (id: string, patch: Partial<Slot>) =>
    setSlots((current) =>
      current.map((slot) => (slot.id === id ? { ...slot, ...patch } : slot)),
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
        team: slots
          .filter((slot) => slot.included)
          .map((slot) => ({
            dotId: slot.dotId,
            memberTemplateId: slot.memberTemplateId || undefined,
            name: slot.name || undefined,
            customization: slot.customization,
            role: slot.role,
            mandate: slot.mandate,
          })),
      });
      await onRefresh();
      await refreshOffice();
      setShowWizard(false);
      setProject(result.masterSession);
      setProjectAgents(result.agents);
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
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not add this collaborator.',
      );
    } finally {
      setAddingAgent(false);
    }
  };
  const createSlotFromTemplate = (member: MemberTemplate) =>
    setSlots((current) => [
      ...current,
      {
        ...makeSlot(),
        memberTemplateId: member.id,
        role: member.name,
        mandate: member.description,
      },
    ]);

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
        <div className="office-actions">
          <button
            className="secondary-button"
            onClick={() => {
              setProject(undefined);
              setShowWizard(false);
            }}
          >
            <Users size={16} />
            My Office
          </button>
          <button className="primary" onClick={startWizard}>
            <Plus size={16} />
            Create project
          </button>
        </div>
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      {project ? (
        <section className="office-project">
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
              const person = roster.find((item) => item.dot.id === agent.dotId);
              return (
                <article className="office-card" key={agent.id}>
                  <div className="office-card-title">
                    <span className="office-avatar">
                      {(person?.dot.name ?? agent.displayName ?? 'D')
                        .slice(0, 1)
                        .toUpperCase()}
                    </span>
                    <div>
                      <h3>
                        {person?.dot.name ??
                          agent.displayName ??
                          'Collaborator'}
                      </h3>
                      <small>{agent.role}</small>
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
                  <button
                    className="text-button"
                    onClick={() => {
                      setSelectedDot(agent.dotId);
                      if (person)
                        setProfileDraft({
                          summary: person.profile.summary,
                          skills: person.profile.skills.join(', '),
                          workStyle: person.profile.workStyle,
                        });
                      setProject(undefined);
                    }}
                  >
                    Open collaborator profile <ChevronRight size={14} />
                  </button>
                </article>
              );
            })}
          </div>
          <section className="office-add-member">
            <h3>Add an existing collaborator</h3>
            <p>
              Reuse a permanent Dot with a role and mandate for this project.
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
                    members.find((item) => item.id === e.target.value)?.name ??
                      '',
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
                onChange={(e) => setProjectMemberCustomization(e.target.value)}
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
                    <span className="office-avatar">
                      {dot.name.slice(0, 1).toUpperCase()}
                    </span>
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
              <span className="eyebrow">MASTER SESSIONS</span>
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
              onClick={async () => {
                try {
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
            <span className="eyebrow">PROJECT SETUP · STEP {step} OF 4</span>
            <div className="office-steps">
              {['Project', 'Team', 'Hiring', 'Review'].map((label, index) => (
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
                <p>{currentTeam?.description ?? 'Build your project team.'}</p>
                {!projectTeamValid && (
                  <p className="chat-error" role="alert">
                    Add a role and responsibility for each included position.
                  </p>
                )}
                <div className="office-slot-list">
                  {slots.map((slot) => (
                    <article
                      className={`office-slot ${slot.included ? '' : 'excluded'}`}
                      key={slot.id}
                    >
                      <label className="office-include">
                        <input
                          type="checkbox"
                          checked={slot.included}
                          onChange={(e) =>
                            updateSlot(slot.id, { included: e.target.checked })
                          }
                        />
                        Include position
                      </label>
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
                      <div className="office-slot-buttons">
                        <button
                          className="quiet-button"
                          onClick={() =>
                            setSlots((current) => [
                              ...current,
                              {
                                ...slot,
                                id: crypto.randomUUID(),
                                role: `${slot.role} 2`,
                                name: '',
                              },
                            ])
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
                  ))}
                  <button
                    className="secondary-button"
                    onClick={() =>
                      setSlots((current) => [...current, makeSlot()])
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
                <h2 id="wizard-title">Choose who fills each role</h2>
                <p>
                  Reuse a permanent Dot or create a new one from any
                  professional archetype.
                </p>
                {!hiringValid && (
                  <p className="chat-error" role="alert">
                    Choose an existing Dot, or select a template and name for
                    each included position.
                  </p>
                )}
                <div className="office-slot-list">
                  {slots
                    .filter((slot) => slot.included)
                    .map((slot) => (
                      <article className="office-hire" key={slot.id}>
                        <div>
                          <b>{slot.role || 'Untitled role'}</b>
                          <p>{slot.mandate}</p>
                        </div>
                        <div className="office-hire-choice">
                          <label>
                            <input
                              type="radio"
                              name={`hire-${slot.id}`}
                              checked={!!slot.dotId}
                              onChange={() =>
                                updateSlot(slot.id, {
                                  dotId: roster[0]?.dot.id,
                                  memberTemplateId: '',
                                  name: '',
                                  customization: '',
                                })
                              }
                            />
                            Existing Dot
                          </label>
                          <label>
                            <input
                              type="radio"
                              name={`hire-${slot.id}`}
                              checked={!slot.dotId}
                              onChange={() =>
                                updateSlot(slot.id, {
                                  dotId: undefined,
                                  memberTemplateId:
                                    slot.memberTemplateId || members[0]?.id,
                                  name: '',
                                  customization: '',
                                })
                              }
                            />
                            New Dot
                          </label>
                        </div>
                        {slot.dotId ? (
                          <>
                            <select
                              aria-label={`Choose Dot for ${slot.role}`}
                              value={slot.dotId}
                              onChange={(e) =>
                                updateSlot(slot.id, { dotId: e.target.value })
                              }
                            >
                              <option value="" disabled>
                                Choose an existing collaborator
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
                                    {item.dot.name} ·{' '}
                                    {item.profile.summary ||
                                      'Profile summary not set'}
                                  </option>
                                ))}
                            </select>
                            <small>
                              Global instructions remain unchanged. The role and
                              mandate apply to this project only.
                            </small>
                          </>
                        ) : (
                          <>
                            <select
                              aria-label={`Member archetype for ${slot.role}`}
                              value={slot.memberTemplateId}
                              onChange={(e) =>
                                updateSlot(slot.id, {
                                  memberTemplateId: e.target.value,
                                  name:
                                    members.find((m) => m.id === e.target.value)
                                      ?.name ?? '',
                                })
                              }
                            >
                              <option value="">Choose an archetype</option>
                              {members.map((member) => (
                                <option key={member.id} value={member.id}>
                                  {member.name} · {member.category}
                                </option>
                              ))}
                            </select>
                            <input
                              aria-label={`New Dot name for ${slot.role}`}
                              placeholder="New Dot name"
                              value={slot.name}
                              onChange={(e) =>
                                updateSlot(slot.id, { name: e.target.value })
                              }
                            />
                            <textarea
                              aria-label={`Permanent customization for ${slot.role}`}
                              placeholder="Optional permanent AGENT/SOUL customization"
                              value={slot.customization}
                              onChange={(e) =>
                                updateSlot(slot.id, {
                                  customization: e.target.value,
                                })
                              }
                            />
                          </>
                        )}
                      </article>
                    ))}
                </div>
                <details className="office-catalog-details">
                  <summary>
                    <Search size={15} /> Add any archetype from the global
                    catalog
                  </summary>
                  <input
                    aria-label="Search archetypes"
                    placeholder="Search any category"
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                  />
                  <div className="office-catalog-chips">
                    {filteredMembers.map((member) => (
                      <button
                        key={member.id}
                        onClick={() => createSlotFromTemplate(member)}
                      >
                        {member.name} <small>{member.category}</small>
                      </button>
                    ))}
                  </div>
                </details>
              </>
            )}
            {step === 4 && (
              <>
                <h2 id="wizard-title">Review and create</h2>
                <div className="office-review">
                  <h3>{projectName}</h3>
                  <p>{description || 'No project description.'}</p>
                  <small>Template: {currentTeam?.name ?? 'Custom team'}</small>
                  {slots
                    .filter((slot) => slot.included)
                    .map((slot) => (
                      <article key={slot.id}>
                        <b>{slot.role}</b>
                        <span>
                          {slot.dotId
                            ? `Reuse ${roster.find((item) => item.dot.id === slot.dotId)?.dot.name ?? 'existing Dot'}`
                            : `Create ${slot.name || 'unnamed Dot'} · ${members.find((member) => member.id === slot.memberTemplateId)?.name ?? 'no template'}`}
                        </span>
                        <small>Mandate: {slot.mandate}</small>
                        {slot.customization && (
                          <small>
                            Permanent customization: {slot.customization}
                          </small>
                        )}
                      </article>
                    ))}
                </div>
                <p className="muted">
                  Confirmation creates the Space, Master Session, new Dots,
                  profiles, and assignments together. Retrying uses the same
                  request key.
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
              {step < 4 ? (
                <button
                  className="primary"
                  disabled={
                    (step === 1 && !projectName.trim()) ||
                    (step === 2 && !projectTeamValid) ||
                    (step === 3 &&
                      (!slots.some((slot) => slot.included) || !hiringValid))
                  }
                  onClick={() => setStep(step + 1)}
                >
                  Continue
                  <ChevronRight size={15} />
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={saving || !slots.some((slot) => slot.included)}
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
