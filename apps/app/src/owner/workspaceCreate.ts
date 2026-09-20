/**
 * The one place the owner-panel "create a customer workspace" form is validated, shared by
 * the in-memory port and the D1 port so the two cannot disagree about what a good address
 * or a good name is.
 *
 * Why this action exists at all: on 20 September 2026 production had zero workspaces, new
 * signup was closed, the automation seed refused production by design, and the owner's own
 * sign-in produced a user with no membership and a page that said so. Every route to a
 * first customer workspace on production was closed, including the owner's. This is the
 * supported one: authenticated, MFA-fresh, audited, and refused to the automation identity.
 */
import type { CreateWorkspaceInput } from './port.js';

export const WORKSPACE_NAME_MIN = 2;
export const WORKSPACE_NAME_MAX = 80;

/** The same normalisation `lib/auth.ts` applies before a sign-in token is redeemed. */
export function normaliseWorkspaceEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * A deliberately narrow shape check. It is not trying to prove deliverability; it is
 * refusing the inputs that would create an account nobody can ever sign into.
 */
export function looksLikeAddress(value: string): boolean {
  if (value.length < 6 || value.length > 254) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const domain = value.slice(at + 1);
  return (
    domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.') && !/\s/.test(value)
  );
}

export type WorkspaceInputCheck =
  | { readonly ok: true; readonly email: string; readonly name: string }
  | {
      readonly ok: false;
      readonly message: string;
      readonly fieldErrors: Readonly<Record<string, string>>;
    };

export function validateWorkspaceInput(input: CreateWorkspaceInput): WorkspaceInputCheck {
  const email = normaliseWorkspaceEmail(input.email);
  const name = input.name.trim().replace(/\s+/g, ' ');
  const fieldErrors: Record<string, string> = {};
  if (!looksLikeAddress(email)) {
    fieldErrors['email'] = 'Enter the address the workspace admin will sign in with.';
  }
  if (name.length < WORKSPACE_NAME_MIN || name.length > WORKSPACE_NAME_MAX) {
    fieldErrors['name'] =
      `Give the workspace a name of ${WORKSPACE_NAME_MIN} to ${WORKSPACE_NAME_MAX} characters.`;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, message: 'Nothing was created. Check the fields marked.', fieldErrors };
  }
  return { ok: true, email, name };
}

/** `a**@example.com`. The full address is never rendered back on an owner page. */
export function maskAddress(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(local.length - 1, 4)))}@${email.slice(at + 1)}`;
}

export function workspaceCreatedMessage(name: string, email: string): string {
  return (
    `Workspace "${name}" is created and ${maskAddress(email)} is its admin. ` +
    'Nothing has been emailed from here: they request their own sign-in link at /app/sign-in with that address, ' +
    'and if they already signed in before the workspace existed, their current session now resolves to it.'
  );
}
