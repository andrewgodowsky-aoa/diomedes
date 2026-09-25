import { useEffect, useRef, useState } from 'react';
import { openAccountSettings, useAccount } from '../AccountGate';

/**
 * Who is signed in, in the top strip: their initials, and a menu with their
 * businesses and roles, Account settings, switching account and signing out.
 * Switching signs out and returns to the account chooser; the account stays
 * on this computer's list.
 */
export function AccountMenu() {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') setOpen(false);
        return;
      }
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  if (!account?.state.person) return null;
  const { person, workspaces, backend } = account.state;
  const initials =
    person.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join('') || '?';
  return (
    <div className="surface-menu account-menu" ref={ref}>
      <button
        type="button"
        className="account-initials"
        aria-label={`Account: ${person.name}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {initials}
      </button>
      {open && (
        <div className="pmenu open" role="menu">
          <p className="account-menu-who">
            <strong>{person.name}</strong>
            <span className="caption">{person.email}</span>
          </p>
          {workspaces.map((workspace) => (
            <p key={workspace.organization.id} className="caption">
              {workspace.organization.name}: {workspace.roleLabel}
            </p>
          ))}
          {workspaces.length === 0 && <p className="caption">Personal only</p>}
          {backend.kind === 'faux' && <p className="caption">Test account service</p>}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              openAccountSettings();
            }}
          >
            Account settings
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void account.signOut();
            }}
          >
            Switch account
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void account.signOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
