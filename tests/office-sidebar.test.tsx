import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { OfficeSidebar } from '../src/client/OfficeSidebar';
import type { OfficeNavigationSummary, Space } from '../src/shared/types';

vi.mock('../src/client/api', () => ({
  api: vi.fn(async () => navigation),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReactTestRenderer | undefined;
const projectSpace: Space = {
  id: 'project-space',
  name: 'A new book',
  description: '',
  createdAt: 1,
};
const otherSpace: Space = {
  id: 'everyday',
  name: 'Everyday',
  description: '',
  createdAt: 1,
};
const navigation = {
  projects: [
    {
      project: {
        id: 'project',
        spaceId: projectSpace.id,
        name: 'A new book',
        description: '',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      },
      space: projectSpace,
      members: [
        {
          agent: {
            id: 'agent-nova',
            masterSessionId: 'project',
            dotId: 'dot-nova',
            role: 'Director',
            displayName: null,
            status: 'active',
            mandate: '',
            soulOverride: '',
            createdAt: 1,
            updatedAt: 1,
          },
          dot: {
            id: 'dot-nova',
            spaceId: projectSpace.id,
            spaceIds: [projectSpace.id],
            name: 'Nova',
            instructions: 'Lead the project.',
            researchAllowed: false,
            memoryAllowed: false,
            appsAllowed: false,
            composioToolkits: [],
            createdAt: 1,
          },
        },
      ],
      conversations: [
        {
          conversation: {
            id: 'kickoff',
            masterSessionId: 'project',
            title: 'Kickoff — A new book',
            kind: 'plenary',
            visibility: 'team',
            status: 'active',
            createdByType: 'user',
            createdById: 'owner',
            createdAt: 1,
            updatedAt: 4,
          },
          participants: [],
          lastMessage: null,
        },
        ...['General', 'Outline', 'Research', 'Draft review'].map(
          (title, index) => ({
            conversation: {
              id: `conversation-${index}`,
              masterSessionId: 'project',
              title,
              kind: 'group',
              visibility: 'restricted',
              status: 'active',
              createdByType: 'user',
              createdById: 'owner',
              createdAt: 1,
              updatedAt: 4 - index,
            },
            participants: [],
            lastMessage: null,
          }),
        ),
      ],
      kickoffConversationId: 'kickoff',
    },
  ],
  projectSpaceIds: [projectSpace.id],
  archivedProjectCount: 0,
  collaborators: [
    {
      dot: {
        id: 'dot-nova',
        spaceId: projectSpace.id,
        spaceIds: [projectSpace.id],
        name: 'Nova',
        instructions: 'Lead the project.',
        researchAllowed: false,
        memoryAllowed: false,
        appsAllowed: false,
        composioToolkits: [],
        createdAt: 1,
      },
      profile: {
        dotId: 'dot-nova',
        summary: 'Project coordinator',
        skills: ['planning'],
        workStyle: '',
        memberTemplateId: null,
        soulInstructions: '',
        updatedAt: 1,
      },
    },
  ],
} as unknown as OfficeNavigationSummary;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.clearAllMocks();
});

it('separates projects from native Spaces, persists foldable state, and opens project conversations and direct chats', async () => {
  const onOpenProject = vi.fn();
  const onOpenConversation = vi.fn();
  const onOpenDirect = vi.fn(async () => {});
  await act(async () => {
    root = create(
      <OfficeSidebar
        spaces={[projectSpace, otherSpace]}
        dots={[]}
        activeProjectId="project"
        activeConversationId="kickoff"
        activeSpaceId={undefined}
        refreshSignal={0}
        officeActive={false}
        onOpenOffice={vi.fn()}
        onCreateProject={vi.fn()}
        onCreateDot={vi.fn()}
        onEditDot={vi.fn()}
        onOpenNativeDot={vi.fn()}
        onCreateSpace={vi.fn()}
        onNewNativeChat={vi.fn()}
        nativeChatEnabled
        onOpenProject={onOpenProject}
        onOpenConversation={onOpenConversation}
        onOpenDotProfile={vi.fn()}
        onOpenDirect={onOpenDirect}
        onOpenSpace={vi.fn()}
      />,
    );
    await Promise.resolve();
  });
  expect(JSON.stringify(root!.toJSON())).toContain('Everyday');
  const rendered = JSON.stringify(root!.toJSON());
  expect(rendered).toContain('PROJECTS');
  expect(rendered).toContain('COLLABORATORS');
  expect(rendered).toContain('A new book');
  expect(rendered).toContain('office-project-branch active');
  expect(rendered).toContain('Kickoff meeting');
  const collapse = root!.root.findByProps({
    'aria-label': 'Collapse A new book',
  });
  await act(async () => collapse.props.onClick());
  expect(JSON.stringify(root!.toJSON())).not.toContain('Kickoff meeting');
  const disclosure = root!.root.findByProps({
    'aria-label': 'Expand A new book',
  });
  await act(async () => disclosure.props.onClick());
  expect(onOpenProject).not.toHaveBeenCalled();
  expect(JSON.stringify(root!.toJSON())).toContain('Kickoff meeting');
  expect(JSON.stringify(root!.toJSON())).toContain('Director');
  expect(JSON.stringify(root!.toJSON())).toContain('Show more');
  const kickoff = root!.root.findByProps({
    title: 'Kickoff — A new book',
  });
  await act(async () => kickoff?.props.onClick());
  expect(onOpenConversation).toHaveBeenCalledWith('project', 'kickoff');
  const member = root!.root.findByProps({ title: 'Nova — Director' });
  await act(async () => member?.props.onClick());
  expect(onOpenDirect).toHaveBeenCalledWith('project', 'agent-nova');
});
