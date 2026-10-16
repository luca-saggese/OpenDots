import { useState } from 'react';
import type {
  CollaborationMention,
  CollaborationSnapshot,
} from '../shared/types';

export type MentionCandidate = {
  sessionAgentId: string;
  dotId: string;
  name: string;
  role: string;
};
export function MentionComposer({
  conversationId,
  candidates,
  value,
  onChange,
  mentions,
  onMentions,
}: {
  conversationId: string;
  candidates: MentionCandidate[];
  value: string;
  onChange: (value: string) => void;
  mentions: CollaborationMention[];
  onMentions: (mentions: CollaborationMention[]) => void;
}) {
  const query = value.match(/(?:^|\s)@([^\s@]*)$/)?.[1];
  const choose = (candidate?: MentionCandidate) => {
    const mention: CollaborationMention = candidate
      ? {
          type: 'agent',
          conversationId,
          sessionAgentId: candidate.sessionAgentId,
          dotId: candidate.dotId,
          displayName: candidate.name,
        }
      : { type: 'all', conversationId };
    const key = (item: CollaborationMention) =>
      item.type === 'all' ? 'all' : item.sessionAgentId;
    onMentions([
      ...mentions.filter((item) => key(item) !== key(mention)),
      mention,
    ]);
    onChange(value.replace(/@[^\s@]*$/, `@${candidate?.name ?? 'tutti'} `));
  };
  return (
    <div className="mention-composer">
      <label className="sr-only" htmlFor="organizational-message-input">
        Write an organizational message
      </label>
      <textarea
        id="organizational-message-input"
        rows={3}
        value={value}
        maxLength={20000}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="Write a message. Type @ to select collaborators…"
      />
      {query !== undefined && (
        <div
          className="mention-suggestions"
          role="group"
          aria-label="Mention suggestions"
        >
          <button type="button" onClick={() => choose()}>
            @tutti · All authorized participants
          </button>
          {candidates
            .filter((item) =>
              item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
            )
            .map((candidate) => (
              <button
                type="button"
                key={candidate.sessionAgentId}
                onClick={() => choose(candidate)}
              >
                @{candidate.name}
                <small>
                  {candidate.role} · {candidate.dotId.slice(0, 8)}
                </small>
              </button>
            ))}
        </div>
      )}
      {!!mentions.length && (
        <div className="mention-selections" aria-label="Selected recipients">
          {mentions.map((mention, index) => (
            <button
              type="button"
              key={mention.type === 'all' ? 'all' : mention.sessionAgentId}
              onClick={() => onMentions(mentions.filter((_, i) => i !== index))}
            >
              {mention.type === 'all' ? '@tutti' : `@${mention.displayName}`} ×
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function CollaborationControls({
  snapshot,
  name,
  onAction,
  onSettings,
  triggerMessageId,
}: {
  snapshot?: CollaborationSnapshot;
  name: (agentId: string) => string;
  onAction: (path: string, body: unknown) => Promise<void>;
  onSettings: (settings: CollaborationSnapshot['settings']) => Promise<void>;
  triggerMessageId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const act = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  };
  if (!snapshot) return <p className="muted">Loading participation status…</p>;
  const pending = snapshot.handRaises.filter(
    (raise) => raise.status === 'pending',
  );
  return (
    <section
      className="collaboration-controls"
      aria-label="Agent participation"
    >
      <div className="collaboration-settings">
        <label>
          Participation{' '}
          <select
            aria-label="Participation mode"
            value={snapshot.settings.mode}
            disabled={busy}
            onChange={(event) =>
              void act(() =>
                onSettings({
                  ...snapshot.settings,
                  mode: event.target.value as 'manual' | 'hand_raise',
                }),
              )
            }
          >
            <option value="manual">Manual</option>
            <option value="hand_raise">With hand raises</option>
          </select>
        </label>
        <label>
          Reply budget{' '}
          <input
            aria-label="Maximum replies per request"
            type="number"
            min={1}
            max={8}
            value={snapshot.settings.maxActivations}
            disabled={busy}
            onChange={(event) =>
              void act(() =>
                onSettings({
                  ...snapshot.settings,
                  maxActivations: Number(event.target.value),
                }),
              )
            }
          />
        </label>
        <label>
          Evaluation budget{' '}
          <input
            aria-label="Hand raise evaluation budget"
            type="number"
            min={1}
            max={4}
            value={snapshot.settings.evaluationBudget}
            disabled={busy}
            onChange={(event) =>
              void act(() =>
                onSettings({
                  ...snapshot.settings,
                  evaluationBudget: Number(event.target.value),
                }),
              )
            }
          />
        </label>
      </div>
      {snapshot.settings.mode === 'hand_raise' && (
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !triggerMessageId}
          onClick={() =>
            void act(() =>
              onAction('/hand-raises/evaluate', {
                messageId: triggerMessageId,
              }),
            )
          }
        >
          Ask if anyone wants to contribute
        </button>
      )}
      {pending.map((raise) => (
        <article className="hand-raise" key={raise.id}>
          <b>✋ {name(raise.sessionAgentId)} would like to contribute</b>
          <p>{raise.reason}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() =>
              void act(() =>
                onAction(`/hand-raises/${raise.id}/resolve`, {
                  action: 'approved',
                }),
              )
            }
          >
            Give the floor
          </button>
          <button
            type="button"
            className="quiet-button"
            disabled={busy}
            onClick={() =>
              void act(() =>
                onAction(`/hand-raises/${raise.id}/resolve`, {
                  action: 'dismissed',
                }),
              )
            }
          >
            Dismiss
          </button>
        </article>
      ))}
    </section>
  );
}
