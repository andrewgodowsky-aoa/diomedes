import type { ReleaseEntry } from '../shared/release-notes';
import './release-notes.css';

/** One release's sections, drawn as text. Shared by Settings > What's new and the update card. */
export function ReleaseNotesBody({ release }: { release: ReleaseEntry }) {
  return (
    <div className="release-notes-body">
      <p className="release-headline">{release.headline}</p>
      {release.sections.map((section) => (
        <section className="release-section" key={section.title}>
          <h4>{section.title}</h4>
          <ul>
            {section.items.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
