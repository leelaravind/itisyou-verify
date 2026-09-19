/**
 * The rendering primitive.
 *
 * ## Why `hono/html` and not `hono/jsx`
 *
 * The repository's `tsconfig.base.json` sets no `jsx` / `jsxImportSource`, and
 * `tsconfig.json`'s `include` covers only `**\/*.ts`. Introducing `.tsx` would therefore
 * mean editing the lead's shared TypeScript configuration, which is not mine to change.
 * `hono/html` is the same package, renders through the same `c.html()` path, needs no
 * compiler configuration at all — and escapes `& < > " '` in every interpolated value by
 * default, which is exactly the property a page rendering customer-controlled workflow
 * names and CRM values needs. Opting out is explicit and greppable: `raw()`.
 *
 * If the lead would rather have JSX, the change is two lines in `tsconfig.base.json`
 * (`"jsx": "react-jsx"`, `"jsxImportSource": "hono/jsx"`) plus `.tsx` in `include`; say so
 * and I will port the components.
 */
import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

export { html, raw };

/** What every component in this package returns. */
export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/** Anything that may appear in a template hole. */
export type Child = Html | string | number | null | undefined | false | readonly Child[];

/** Resolve a rendered tree to markup. Used by the Worker's response path and by tests. */
export async function render(node: Html): Promise<string> {
  return String(await node);
}

/** Resolve synchronously. Only valid when nothing in the tree is a promise. */
export function renderSync(node: Html): string {
  if (node instanceof Promise) {
    throw new TypeError('renderSync received a promise; use render() instead.');
  }
  return String(node);
}

/**
 * Build an attribute string from a map, escaping every value and dropping anything
 * `null`, `undefined` or `false`. `true` renders the bare attribute.
 *
 * Attribute *names* are restricted to a conservative character set rather than escaped:
 * an attribute name assembled from customer input is a bug, not a feature, so it fails
 * loudly instead of being silently sanitised.
 */
export function attrs(map: Readonly<Record<string, string | number | boolean | null | undefined>>): Html {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(map)) {
    if (value === null || value === undefined || value === false) continue;
    if (!/^[A-Za-z][A-Za-z0-9:_-]*$/.test(name)) {
      throw new TypeError(`unsafe attribute name: ${name}`);
    }
    if (value === true) {
      parts.push(name);
      continue;
    }
    parts.push(`${name}="${escapeAttribute(String(value))}"`);
  }
  return raw(parts.join(' '));
}

/** Escape a value for use inside a double-quoted attribute. */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Join a list of nodes with a separator that is itself markup. */
export function join(nodes: readonly Html[], separator: Html | string = ''): Html {
  const out: Child[] = [];
  nodes.forEach((node, index) => {
    if (index > 0) out.push(separator as Child);
    out.push(node);
  });
  return html`${out as unknown as Child[]}`;
}

/** Conditional render. Returns nothing at all when the condition is false. */
export function when(condition: unknown, node: () => Html): Html | null {
  return condition ? node() : null;
}

/**
 * A class attribute from a list, skipping falsy entries. Kept tiny on purpose: this is the
 * entire "CSS-in-JS layer" and it is eight lines.
 */
export function cx(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter((v): v is string => typeof v === 'string' && v.length > 0).join(' ');
}
