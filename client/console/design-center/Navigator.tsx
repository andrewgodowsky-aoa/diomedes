/**
 * The navigator: every surface and component the preview can show, grouped.
 *
 * It is the same list the stage lays out, so choosing here and clicking there
 * select the same thing and cannot disagree.
 */
import { PREVIEW_GROUPS, PREVIEW_PIECES } from './Preview';

export function Navigator({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  return (
    <nav className="dc-navigator" aria-label="Surfaces and components">
      {PREVIEW_GROUPS.map((group) => (
        <section key={group}>
          <h3>{group}</h3>
          <ul>
            {PREVIEW_PIECES.filter((piece) => piece.group === group).map((piece) => (
              <li key={piece.id}>
                <button
                  type="button"
                  className={selectedId === piece.id ? 'on' : ''}
                  aria-current={selectedId === piece.id ? 'true' : undefined}
                  onClick={() => onSelect(piece.id)}
                >
                  {piece.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}
