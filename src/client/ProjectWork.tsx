import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionAgent } from '../shared/types';
import type {
  ProjectWorkSnapshot,
  WorkDeliverable,
} from '../shared/project-work';
import { api } from './api';

export function ProjectWork({
  masterSessionId,
  agents,
}: {
  masterSessionId: string;
  agents: SessionAgent[];
}) {
  const [snapshot, setSnapshot] = useState<ProjectWorkSnapshot>();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [outcome, setOutcome] = useState('');
  const [criteria, setCriteria] = useState('');
  const [coordinator, setCoordinator] = useState('');
  const [proposal, setProposal] = useState('');
  const [pageContents, setPageContents] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const proposalId = useRef<string | undefined>(undefined);
  const refresh = useCallback(async () => {
    try {
      const next = await api<ProjectWorkSnapshot>(
        `/master-sessions/${masterSessionId}/work`,
      );
      setSnapshot(next);
      const active = agents.filter((agent) => agent.status === 'active');
      setCoordinator(
        (current) =>
          current ||
          active.find((agent) => /director/i.test(agent.role))?.id ||
          active[0]?.id ||
          '',
      );
      const plan = next.plans.find((item) => item.status === 'proposed');
      if (plan && proposalId.current !== plan.id) {
        proposalId.current = plan.id;
        setProposal(
          JSON.stringify(
            {
              title: plan.title,
              summary: plan.summary,
              definitionOfDone: plan.definitionOfDone,
              tasks: plan.tasks,
            },
            null,
            2,
          ),
        );
      } else if (!plan) {
        proposalId.current = undefined;
        setProposal('');
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Could not load project work.',
      );
    }
  }, [masterSessionId, agents]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setMessage(success);
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Project work action failed.',
      );
    } finally {
      setBusy(false);
    }
  };
  const workflow = snapshot?.workflow;
  const activeAgents = useMemo(
    () => agents.filter((agent) => agent.status === 'active'),
    [agents],
  );
  const createGoal = () =>
    run(async () => {
      await api(`/master-sessions/${masterSessionId}/work/goals`, 'POST', {
        title,
        description,
        expectedOutcome: outcome,
        completionCriteria: criteria
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        priority: 3,
      });
      setTitle('');
      setDescription('');
      setOutcome('');
      setCriteria('');
    }, 'Goal saved.');
  const plan = () =>
    run(
      () =>
        api(`/master-sessions/${masterSessionId}/work/plan`, 'POST', {
          coordinatorSessionAgentId: coordinator,
        }),
      'Planning request sent to the coordinator.',
    );
  const control = (action: 'pause' | 'resume' | 'cancel') =>
    run(
      () =>
        api(`/master-sessions/${masterSessionId}/work/workflow`, 'POST', {
          action,
        }),
      `Workflow ${action} requested.`,
    );
  const loadDeliverable = async (item: WorkDeliverable) => {
    try {
      const result = await api<{ page: { content: string } }>(
        `/master-sessions/${masterSessionId}/work/deliverables/${item.id}`,
      );
      setPageContents((current) => ({
        ...current,
        [item.id]: result.page.content,
      }));
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Could not load page.',
      );
    }
  };
  if (!snapshot)
    return (
      <section className="project-overview">
        <p>Loading project work…</p>
        {message && <p role="alert">{message}</p>}
      </section>
    );
  return (
    <section className="project-overview project-work">
      <div className="office-section-head">
        <div>
          <span className="eyebrow">HUMAN-APPROVED WORKFLOW</span>
          <h2>Project work</h2>
        </div>
        <span className={`project-status ${workflow?.status}`}>
          {workflow?.status}
        </span>
      </div>
      <p>
        Define goals, prepare a proposal, review it, then approve execution.
        Planning starts only when you request it.
      </p>
      {message && <p role="status">{message}</p>}
      {workflow?.error && (
        <p className="chat-error" role="alert">
          {workflow.error}
        </p>
      )}
      {['draft', 'blocked', 'failed'].includes(workflow?.status ?? 'draft') && (
        <>
          <div className="project-work-form">
            <h3>Goals</h3>
            <input
              aria-label="Goal title"
              placeholder="Goal title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <textarea
              aria-label="Goal description"
              placeholder="Context and constraints"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
            <input
              aria-label="Expected outcome"
              placeholder="Expected outcome"
              value={outcome}
              onChange={(event) => setOutcome(event.target.value)}
            />
            <textarea
              aria-label="Completion criteria"
              placeholder="Completion criteria, one per line"
              value={criteria}
              onChange={(event) => setCriteria(event.target.value)}
            />
            <button
              className="secondary-button"
              disabled={
                busy || !title.trim() || !outcome.trim() || !criteria.trim()
              }
              onClick={() => void createGoal()}
            >
              Save goal
            </button>
          </div>
          {snapshot.goals.length > 0 && (
            <div>
              <h3>Coordinator</h3>
              <select
                aria-label="Work coordinator"
                value={coordinator}
                onChange={(event) => setCoordinator(event.target.value)}
              >
                <option value="">Choose coordinator</option>
                {activeAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.displayName || 'Collaborator'} — {agent.role}
                  </option>
                ))}
              </select>{' '}
              <button
                className="primary"
                disabled={busy || !coordinator}
                onClick={() => void plan()}
              >
                Prepare work plan
              </button>
            </div>
          )}
        </>
      )}
      {snapshot.goals.length > 0 && (
        <div>
          <h3>Goals</h3>
          {snapshot.goals.map((goal) => (
            <article key={goal.id}>
              <strong>{goal.title}</strong> <span>{goal.status}</span>
              <p>{goal.expectedOutcome}</p>
              <ul>
                {goal.completionCriteria.map((criterion) => (
                  <li key={criterion}>{criterion}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}
      {snapshot.plans
        .filter((item) => item.status === 'proposed')
        .map((item) => (
          <article key={item.id}>
            <h3>
              Plan proposal v{item.version}: {item.title}
            </h3>
            <p>{item.summary}</p>
            <p>Review or edit the JSON proposal before approving it.</p>
            <textarea
              aria-label="Edit work plan proposal"
              className="work-plan-editor"
              value={proposal}
              onChange={(event) => setProposal(event.target.value)}
            />
            <div className="project-work-actions">
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const parsed = JSON.parse(proposal);
                    await api(
                      `/master-sessions/${masterSessionId}/work/plans/${item.id}`,
                      'PUT',
                      parsed,
                    );
                  }, 'Proposal updated.')
                }
              >
                Save edits
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      api(
                        `/master-sessions/${masterSessionId}/work/plans/${item.id}/approve`,
                        'POST',
                        {},
                      ),
                    'Plan approved; workflow started.',
                  )
                }
              >
                Approve and start
              </button>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      api(
                        `/master-sessions/${masterSessionId}/work/plans/${item.id}/reject`,
                        'POST',
                        {},
                      ),
                    'Proposal rejected.',
                  )
                }
              >
                Reject
              </button>
            </div>
          </article>
        ))}
      {workflow && ['running', 'paused'].includes(workflow.status) && (
        <div className="project-work-actions">
          <button
            className="secondary-button"
            disabled={busy || workflow.status !== 'running'}
            onClick={() => void control('pause')}
          >
            Pause
          </button>
          <button
            className="secondary-button"
            disabled={busy || workflow.status !== 'paused'}
            onClick={() => void control('resume')}
          >
            Resume
          </button>
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => void control('cancel')}
          >
            Cancel workflow
          </button>
        </div>
      )}
      {snapshot.tasks.length > 0 && (
        <div>
          <h3>Tasks</h3>
          {snapshot.tasks.map((task) => (
            <article className="project-work-task" key={task.id}>
              <div>
                <strong>{task.title}</strong> <span>{task.status}</span>
              </div>
              <p>{task.description}</p>
              <p>
                Assigned to{' '}
                {agents.find(
                  (agent) => agent.id === task.assigneeSessionAgentId,
                )?.displayName ?? 'Unavailable agent'}{' '}
                · priority {task.priority} · attempt {task.attempts}/
                {task.maxAttempts}
              </p>
              <p>
                Depends on:{' '}
                {task.dependsOn
                  .map(
                    (id) =>
                      snapshot.tasks.find((candidate) => candidate.id === id)
                        ?.title ?? id,
                  )
                  .join(', ') || 'none'}
              </p>
              {[
                'pending',
                'ready',
                'blocked',
                'failed',
                'interrupted',
              ].includes(task.status) && (
                <div className="project-work-actions">
                  <label>
                    Assignee{' '}
                    <select
                      aria-label={`Assignee for ${task.title}`}
                      value={task.assigneeSessionAgentId}
                      disabled={busy}
                      onChange={(event) =>
                        void run(
                          () =>
                            api(
                              `/master-sessions/${masterSessionId}/work/tasks/${task.id}/assignee`,
                              'PUT',
                              { sessionAgentId: event.target.value },
                            ),
                          'Task reassigned.',
                        )
                      }
                    >
                      {activeAgents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.displayName || 'Collaborator'} — {agent.role}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Priority{' '}
                    <select
                      aria-label={`Priority for ${task.title}`}
                      value={task.priority}
                      disabled={busy}
                      onChange={(event) =>
                        void run(
                          () =>
                            api(
                              `/master-sessions/${masterSessionId}/work/tasks/${task.id}/priority`,
                              'PUT',
                              { priority: Number(event.target.value) },
                            ),
                          'Task priority updated.',
                        )
                      }
                    >
                      {[1, 2, 3, 4, 5].map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              {task.error && <p role="alert">{task.error}</p>}
              {[
                'blocked',
                'failed',
                'interrupted',
                'changes_requested',
              ].includes(task.status) && (
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    window.confirm(
                      'Retry this task? If the previous attempt caused an external effect, retrying may repeat it.',
                    ) &&
                    void run(
                      () =>
                        api(
                          `/master-sessions/${masterSessionId}/work/tasks/${task.id}/retry`,
                          'POST',
                          {},
                        ),
                      'Retry queued. Inspect possible external side effects first.',
                    )
                  }
                >
                  Retry task
                </button>
              )}
            </article>
          ))}
        </div>
      )}
      {snapshot.consultations.length > 0 && (
        <div>
          <h3>Consultations</h3>
          {snapshot.consultations.map((item) => (
            <article key={item.id}>
              <strong>
                {
                  agents.find(
                    (agent) => agent.id === item.requesterSessionAgentId,
                  )?.displayName
                }{' '}
                →{' '}
                {
                  agents.find(
                    (agent) => agent.id === item.recipientSessionAgentId,
                  )?.displayName
                }
              </strong>
              <p>{item.question}</p>
              <p>{item.answer ?? item.status}</p>
            </article>
          ))}
        </div>
      )}
      {snapshot.deliverables.length > 0 && (
        <div>
          <h3>Pages and review</h3>
          {snapshot.deliverables.map((item) => (
            <article key={item.id}>
              <strong>{item.title}</strong> <span>{item.status}</span>
              <p>
                Version {item.version} · {item.type}
              </p>
              <button
                className="secondary-button"
                onClick={() => void loadDeliverable(item)}
              >
                Open page
              </button>
              {pageContents[item.id] !== undefined && (
                <pre className="work-page-content">{pageContents[item.id]}</pre>
              )}
              {item.status === 'in_review' &&
                !snapshot.tasks.find((task) => task.id === item.taskId)
                  ?.reviewerSessionAgentId && (
                  <div className="project-work-actions">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            api(
                              `/master-sessions/${masterSessionId}/work/deliverables/${item.id}/review`,
                              'POST',
                              { decision: 'approved', feedback: '' },
                            ),
                          'Deliverable approved.',
                        )
                      }
                    >
                      Approve page
                    </button>
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => {
                        const feedback = window.prompt(
                          'What should be changed?',
                        );
                        if (feedback?.trim())
                          void run(
                            () =>
                              api(
                                `/master-sessions/${masterSessionId}/work/deliverables/${item.id}/review`,
                                'POST',
                                { decision: 'changes_requested', feedback },
                              ),
                            'Revision requested.',
                          );
                      }}
                    >
                      Request changes
                    </button>
                  </div>
                )}
            </article>
          ))}
        </div>
      )}
      {workflow?.status === 'awaiting_final_acceptance' && (
        <article>
          <h3>Final report</h3>
          <p style={{ whiteSpace: 'pre-wrap' }}>{workflow.finalReport}</p>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(
                () =>
                  api(
                    `/master-sessions/${masterSessionId}/work/final`,
                    'POST',
                    { decision: 'accept', feedback: '' },
                  ),
                'Final delivery accepted.',
              )
            }
          >
            Accept final delivery
          </button>{' '}
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              const feedback = window.prompt('What should be revised?');
              if (feedback?.trim())
                void run(
                  () =>
                    api(
                      `/master-sessions/${masterSessionId}/work/final`,
                      'POST',
                      { decision: 'changes_requested', feedback },
                    ),
                  'Changes requested.',
                );
            }}
          >
            Request changes
          </button>
        </article>
      )}
      <details>
        <summary>Activity log</summary>
        {snapshot.events.map((event) => (
          <p key={event.id}>
            {new Date(event.createdAt).toLocaleString()} · {event.kind} ·{' '}
            {JSON.stringify(event.value)}
          </p>
        ))}
      </details>
    </section>
  );
}
