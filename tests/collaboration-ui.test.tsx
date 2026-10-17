import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CollaborationControls,
  MentionComposer,
  resolveTypedMentions,
} from '../src/client/CollaborationControls';
import type { CollaborationSnapshot } from '../src/shared/types';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReactTestRenderer | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
});
it('lets the user distinguish identical display names by role and persistent identity', async () => {
  const onMentions = vi.fn();
  const onChange = vi.fn();
  await act(async () => {
    root = create(
      <MentionComposer
        conversationId="conversation"
        value="Ask @La"
        onChange={onChange}
        mentions={[]}
        onMentions={onMentions}
        candidates={[
          {
            sessionAgentId: 'research',
            dotId: 'dot-research',
            name: 'Laura',
            role: 'Research Lead',
          },
          {
            sessionAgentId: 'design',
            dotId: 'dot-design',
            name: 'Laura',
            role: 'Designer',
          },
        ]}
      />,
    );
  });
  const buttons = root!.root.findAllByType('button');
  expect(buttons).toHaveLength(3);
  expect(JSON.stringify(root!.toJSON())).toContain('Designer');
  await act(async () => buttons[2].props.onClick());
  expect(onMentions).toHaveBeenCalledWith([
    {
      type: 'agent',
      conversationId: 'conversation',
      sessionAgentId: 'design',
      dotId: 'dot-design',
      displayName: 'Laura',
    },
  ]);
  expect(onChange).toHaveBeenCalledWith('Ask @Laura ');
});
it('selects @tutti as a structured conversation-scoped mention', async () => {
  const onMentions = vi.fn();
  await act(async () => {
    root = create(
      <MentionComposer
        conversationId="conversation"
        value="@"
        onChange={vi.fn()}
        mentions={[]}
        onMentions={onMentions}
        candidates={[]}
      />,
    );
  });
  await act(async () => root!.root.findByType('button').props.onClick());
  expect(onMentions).toHaveBeenCalledWith([
    { type: 'all', conversationId: 'conversation' },
  ]);
});
it('resolves typed @names and @tutti into structured activations', () => {
  const candidates = [
    {
      sessionAgentId: 'nova-session',
      dotId: 'nova-dot',
      name: 'Nova',
      role: 'Director',
    },
  ];
  expect(
    resolveTypedMentions('@nova, partiamo?', 'conversation', candidates, []),
  ).toMatchObject({
    mentions: [
      {
        type: 'agent',
        conversationId: 'conversation',
        sessionAgentId: 'nova-session',
        dotId: 'nova-dot',
      },
    ],
    unresolved: [],
    ambiguous: [],
  });
  expect(
    resolveTypedMentions('@tutti iniziamo', 'conversation', candidates, []),
  ).toMatchObject({
    mentions: [{ type: 'all', conversationId: 'conversation' }],
    unresolved: [],
    ambiguous: [],
  });
});
it('requires a structured choice when a typed @name is ambiguous', () => {
  const candidates = [
    { sessionAgentId: 'a', dotId: 'dot-a', name: 'Nova', role: 'Writer' },
    { sessionAgentId: 'b', dotId: 'dot-b', name: 'Nova', role: 'Editor' },
  ];
  expect(
    resolveTypedMentions('@Nova', 'conversation', candidates, []),
  ).toMatchObject({ mentions: [], ambiguous: ['Nova'], unresolved: [] });
});
it('submits on Enter and leaves Shift+Enter available for a newline', async () => {
  await act(async () => {
    root = create(
      <MentionComposer
        conversationId="conversation"
        value="hello"
        onChange={vi.fn()}
        mentions={[]}
        onMentions={vi.fn()}
        candidates={[]}
      />,
    );
  });
  const textarea = root!.root.findByType('textarea');
  const preventDefault = vi.fn();
  const requestSubmit = vi.fn();
  await act(async () =>
    textarea.props.onKeyDown({
      key: 'Enter',
      shiftKey: false,
      preventDefault,
      currentTarget: { form: { requestSubmit } },
    }),
  );
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(requestSubmit).toHaveBeenCalledOnce();
  const shiftPreventDefault = vi.fn();
  await act(async () =>
    textarea.props.onKeyDown({
      key: 'Enter',
      shiftKey: true,
      preventDefault: shiftPreventDefault,
      currentTarget: { form: { requestSubmit } },
    }),
  );
  expect(shiftPreventDefault).not.toHaveBeenCalled();
  expect(requestSubmit).toHaveBeenCalledOnce();
});
it('sends approval as a control action without inventing a reply', async () => {
  const onAction = vi.fn(async () => {});
  const snapshot: CollaborationSnapshot = {
    settings: { mode: 'hand_raise', maxActivations: 3, evaluationBudget: 1 },
    executions: [],
    handRaises: [
      {
        id: 'raise',
        conversationId: 'conversation',
        sessionAgentId: 'agent',
        triggerMessageId: 'message',
        executionId: 'evaluation',
        reason: 'Clarify a technical constraint',
        status: 'pending',
        createdAt: 1,
        resolvedAt: null,
        resolvedBy: null,
      },
    ],
  };
  await act(async () => {
    root = create(
      <CollaborationControls
        snapshot={snapshot}
        name={() => 'Paolo'}
        onAction={onAction}
        onSettings={vi.fn()}
        triggerMessageId="message"
      />,
    );
  });
  expect(JSON.stringify(root!.toJSON())).toContain(
    'Clarify a technical constraint',
  );
  const approve = root!.root
    .findAllByType('button')
    .find((button) => button.props.children === 'Give the floor')!;
  await act(async () => approve.props.onClick());
  expect(onAction).toHaveBeenCalledWith('/hand-raises/raise/resolve', {
    action: 'approved',
  });
  expect(snapshot.executions).toEqual([]);
});
