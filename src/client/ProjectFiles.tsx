import { useEffect, useState } from 'react';
import type { Page } from '../server/pages';
import type { Space } from '../shared/types';
import { api } from './api';
import { SpaceLibrary } from './SpaceLibrary';

export function ProjectFiles({
  space,
  onOpenPage,
  onOpenSpace,
}: {
  space: Space;
  onOpenPage: (spaceId: string, pageId: string) => void;
  onOpenSpace: (spaceId: string) => void;
}) {
  const [pages, setPages] = useState<Page[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await api<Page[]>(`/spaces/${space.id}/pages`);
        if (active) {
          setPages(next);
          setError('');
        }
      } catch (err) {
        if (active)
          setError(
            err instanceof Error
              ? err.message
              : 'Could not load project files.',
          );
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [space.id]);

  return (
    <section className="project-files" aria-label={`${space.name} files`}>
      <p className="muted">
        Documents saved by this project’s Dots are stored as pages in its Space.
      </p>
      {error ? (
        <p className="chat-error" role="alert">
          {error}
        </p>
      ) : (
        <SpaceLibrary
          space={space}
          pages={pages}
          onPage={(pageId) => onOpenPage(space.id, pageId)}
          onNew={() => onOpenSpace(space.id)}
        />
      )}
    </section>
  );
}
