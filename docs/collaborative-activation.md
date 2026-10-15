# Project collaborator activation

This milestone adds explicit Dot contributions and controlled hand raises to organizational conversations. It uses the existing Intelligence runtime, `DotAgent`, Session Agents, conversation ACLs and message cursors. No alternative agent framework or autonomous meeting loop is involved.

## Identity and context

The permanent identity is `Dot.id`; the editable display name is `Dot.name`. Names are not unique. Session Agent IDs identify project assignments, with the existing `UNIQUE(masterSessionId, dotId)` constraint preserved. The profile editor in My Office can rename the permanent Dot through `PUT /api/office/dots/:id/name`.

`collaboration-context.ts` assembles the current Dot identity/profile, project, assignment role/mandate, active interlocutors and their professional summaries. Authorized conversation messages include stable sender IDs, names and roles. The triggering message must itself be readable through the target's participation intervals. Context includes at most 100 messages through the trigger sequence, with a 24,000 character content budget; colleague summaries are limited to 400 characters each. Earlier messages can be paged internally to locate an older authorized trigger. Responses to a multiple-mention request use the same trigger boundary; a subsequent human message can ask another Dot to review those responses.

Precedence is explicit: runtime safety/tool permissions, permanent Dot instructions and SOUL, project role/mandate, then conversation content/request. Contextual data cannot grant tools or permissions. Each Dot represents its own identity, without impersonating colleagues. Public client system/developer messages and forwarded prompt overrides remain untrusted and excluded by `DotAgent`.

Every execution gets a new Intelligence thread, associated with exactly one Session Agent and one organizational conversation. Fresh threads prevent private transcripts, earlier participation intervals or other projects from leaking into later turns. The latest thread link is retained for each conversation/agent; message provenance and execution records retain previous thread/turn IDs. These managed threads are hidden from the app's normal conversation list, blocked from public runtime transcript/run/edit routes, and unavailable to voice, page-context and scheduled-task entry points. Internal run requests carry an ephemeral server capability. The native runtime's canonical run ID is recorded at `DotAgent` entry.

Learning is frozen to `null` on managed threads. No organizational transcript is sent to Automatic Learning, and no professional biography or cross-project memory is updated automatically. Permanent instructions, SOUL, tool permissions and existing owner preferences continue to apply.

## Persistence and APIs

`collaboration-store.ts` adds four additive SQLite tables:

- `collaboration_settings`: participation mode and request/evaluation budgets.
- `collaboration_commands`: structured mentions and activation choice attached to a human message.
- `collaboration_executions`: request/conversation/Session Agent/Dot/thread/turn identity, trigger, kind, authorization snapshot, timestamps, status, result and error.
- `collaboration_hand_raises`: distinct proposal, reason, source event/execution, resolution state, time and actor.

Existing data keeps its current meaning. Default mode is `manual`. The extensible settings representation accepts only `manual` and `hand_raise`; autonomous participation is unavailable.

All endpoints below require the existing authenticated owner and conversation ACLs. Creating/changing settings or granting/dismissing the floor also requires the appropriate conversation role. Agent identities and outputs cannot be posted through public message routes.

| Endpoint                                                                     | Behavior                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/organizational-conversations/:id/messages`                        | Existing human message API, extended with optional `activation` and `mentions`. Omitted activation remains `none` for compatibility.                               |
| `GET /api/organizational-conversations/:id/messages`                         | Existing ACL-filtered history/cursors, with stored structured mentions.                                                                                            |
| `GET /api/organizational-conversations/:id/collaboration`                    | Verified settings, execution status/errors and hand raises for the current active human membership. Raw execution output and authorization snapshots are excluded. |
| `PUT /api/organizational-conversations/:id/collaboration`                    | `{mode,maxActivations,evaluationBudget}`; replies per request: 1–8, evaluations per event: 1–4.                                                                    |
| `POST /api/organizational-conversations/:id/hand-raises/evaluate`            | `{messageId}`; explicitly evaluate a readable human message when hand raises are enabled.                                                                          |
| `POST /api/organizational-conversations/:id/hand-raises/:raiseId/resolve`    | `{action:"approved"}` or `{action:"dismissed"}`. Approval requests one real response.                                                                              |
| `POST /api/organizational-conversations/:id/executions/:executionId/cancel`  | `{}`; cancel queued or running work.                                                                                                                               |
| `POST /api/organizational-conversations/:id/executions/:executionId/publish` | `{}`; recover a saved completed response without re-running the model, after fresh ACL checks.                                                                     |

An agent mention is `{type:"agent",conversationId,sessionAgentId,dotId,displayName}`. `displayName` is a display snapshot, normalized by the server; routing uses IDs. `@tutti` is `{type:"all",conversationId}`. The server resolves only active, writable conversation participants, never every member of the project. Requests exceeding the reply budget are rejected before recording a human message or starting compute. Observers cannot be activated. Mention chips show selected recipients; removing a chip removes that recipient. Merely typing a name does not select an identity.

Activation is `none`, `mentioned`, or `direct`. The direct option requires a private conversation with exactly one eligible collaborator. The UI requests a reply by default in a private conversation, offers selected mentions in groups, and always provides “Publish without requesting responses”. Group messages without structured recipients cause no execution.

## Execution, errors and hand raises

`CollaborationService` validates active project, owner membership, agent assignment, conversation participation and role before queuing and before publication. It snapshots participation interval IDs and role/mandate; a leave/rejoin or administrative change invalidates old work. Runtime/tool checks continue during compute, and output is never published after cancellation or lost authorization.

The first implementation runs one deterministic, process-local queue. `DotAgent` also locks each thread for the duration of its native turn. Responses come from `runThreadTurn` and the existing Intelligence SDK; only the actual current assistant result is published. Human requests use the existing idempotency key. Each execution has an immutable server request identity, and publication uses an execution-specific idempotency key. Retrying the same message does not run agents again. Starting another attempt after failure requires a new explicit request.

Timeout uses `AGENT_RUN_TIMEOUT_MS` (90 seconds by default). Errors and cancellations are persisted as execution outcomes, not invented agent messages. A completed result is saved before publication. If publication fails, the UI can recover that same result without model compute. Recovery checks current ACLs, refuses stale participation intervals and waits for other work on that conversation/agent to settle. Cancelling or revoking authorization prevents late results from being published.

Hand raise evaluations are opt-in, initiated by “Ask if anyone wants to contribute”. At most the configured evaluation budget of eligible agents is selected in stable ID order. The native Dot returns a structured yes/no proposal; malformed output is recorded as a failure. A proposal is not a conversation message. Evaluation is deduplicated by conversation, participant and triggering message, including after dismissal. Approval performs a distinct real response execution; repeated approval does not create another. Pending proposals expire after 24 hours, when participation becomes invalid or when the mode returns to manual. Evaluation and response executions can both be cancelled. There is no automatic trigger or recursion on agent replies.

## Operational limits

- This is a single-server process implementation. The queue is not a distributed or durable orchestrator. Multi-target command/execution admission and hand raise approvals are committed atomically. On restart, queued/running records become `interrupted`; they are not automatically resumed. A saved completed response can be explicitly recovered, including when a crash occurred after publication, without duplicate messages. New compute after interruption requires a new explicit request.
- Abort is cooperative at the Intelligence/provider boundary. A remote provider may finish work after a timeout, but cancelled/invalid work is never published. No automatic provider retry is issued by the collaboration service.
- Cancellation cannot roll back tool side effects already completed under existing permissions. Approval-gated client tools are unavailable in headless turns.
- Candidate selection uses stable IDs and a per-event budget; there is no fairness scheduler, continuous listener, autonomous mode, delegation or inter-agent meeting loop.
- The UI polls backend status/history every 1.5 seconds. It shows only backend execution state. Controls/hand raises require active human conversation membership; historical messages remain governed by the existing participation intervals.
- The implementation is tested with runtime/provider mocks. No paid LLM call is required by the tests. A configured deployment is required for the manual live-runtime check.

## Manual check

1. Configure the existing Intelligence and model settings. Open My Office, create Laura and Paolo, and assign them different roles/mandates in a project. Renaming Laura in her profile must preserve her Dot ID and other project assignments.
2. Open the project's Conversations tab. In a private conversation with Laura, send a message with the response option enabled. Verify a real backend execution and a message attributed to Laura.
3. Create a group containing both collaborators. Type `@`, select Laura from the suggestions, then send a proposal. Only Laura should respond. Mention Paolo in a later message asking about Laura's answer. Then select `@tutti`; only eligible group participants should respond, within the configured budget.
4. Send a group message without selected recipients, and send a message with “Publish without requesting responses” checked. Neither should start an execution. Use two Dots with the same name and confirm role/ID disambiguation in suggestions.
5. Change participation to “With hand raises”, choose an evaluation budget, and click “Ask if anyone wants to contribute” after a human message. A relevant model decision may produce a proposal; a negative decision produces none. “Give the floor” starts a real response. “Dismiss” must not reproduce the same proposal on reevaluation of that message.
6. Cancel an execution or suspend/remove its Session Agent while it runs. Verify the persisted outcome and absence of a late public response. Restart during work and confirm `interrupted`, without automatic replay. Use recovery only when the backend reports a saved completed response.
7. Check that a private message never appears in another group's context and that managed thread IDs cannot be opened through the public chat/runtime routes.
