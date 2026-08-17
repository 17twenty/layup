import type { Person } from '../../core/people-store';
import { presenceLabel, primaryActionFor, type PrimaryAction } from './primary-action';
import { usePeople } from './usePeople';

/**
 * The People home surface.
 *
 * This is the product's front door: a grid of colleagues, not a "New Meeting"
 * wizard (SPEC.md §2.1, §5.1). Creating an empty layup is deliberately a
 * secondary affordance.
 */
export interface PeopleGridProps {
  /** Wired to invitations/knocks in Phase C. */
  onAction?: (person: Person, action: PrimaryAction) => void;
  selfUserId?: string;
  /** The layup you are in, so the people already in it are not offered again. */
  currentLayupId?: string;
}

export function PeopleGrid({ onAction, selfUserId, currentLayupId }: PeopleGridProps) {
  const { people, loaded } = usePeople();
  const others = people.filter((person) => person.userId !== selfUserId);

  return (
    <section className="people" aria-label="People">
      <header className="people__header">
        <h2>People</h2>
        <p className="people__hint">Click someone to start a layup.</p>
      </header>

      {!loaded && <p className="people__empty">Loading people…</p>}
      {loaded && others.length === 0 && (
        <p className="people__empty">Nobody else is in your organisation yet.</p>
      )}

      <ul className="people__grid">
        {others.map((person) => (
          <PersonTile
            key={person.userId}
            person={person}
            onAction={onAction}
            {...(currentLayupId ? { currentLayupId } : {})}
          />
        ))}
      </ul>
    </section>
  );
}

function PersonTile({
  person,
  onAction,
  currentLayupId,
}: {
  person: Person;
  onAction?: PeopleGridProps['onAction'];
  currentLayupId?: string;
}) {
  const action = primaryActionFor(person, currentLayupId ? { currentLayupId } : {});
  const initials = person.displayName
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <li
      className={`tile tile--${person.personal.toLowerCase()} tile--activity-${person.activity.toLowerCase()}`}
      data-testid={`person-${person.userId}`}
    >
      <div className="tile__avatar" aria-hidden="true">
        {initials}
      </div>
      <div className="tile__body">
        <p className="tile__name">{person.displayName}</p>
        <p className="tile__presence">
          <span className={`dot dot--${person.personal.toLowerCase()}`} aria-hidden="true" />
          <span data-testid={`presence-${person.userId}`}>{presenceLabel(person)}</span>
        </p>
        {person.statusMessage && <p className="tile__status">“{person.statusMessage}”</p>}
        {person.activity === 'IN_OPEN_LAYUP' && person.participantCount ? (
          <p className="tile__status">{person.participantCount} in the layup</p>
        ) : null}
      </div>
      <button
        type="button"
        className={`tile__action tile__action--${action.emphasis}`}
        disabled={action.disabled}
        title={action.hint}
        onClick={() => onAction?.(person, action)}
      >
        {action.label}
      </button>
    </li>
  );
}
