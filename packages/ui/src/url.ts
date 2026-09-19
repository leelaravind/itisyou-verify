/**
 * The link-target guard — SEC-1214.
 *
 * HTML escaping does not make an `href` safe. `javascript:alert(1)` contains no character
 * that escaping touches, so an escaped attribute value is still a live script URL the
 * moment someone clicks it. The same holds for `data:text/html,…` and `vbscript:`.
 *
 * ## This adopts A10's reviewed reference
 *
 * The accept/reject decision and the normalised target are taken directly from
 * `safeHref` in `tests/security/helpers/html.ts` — the same scheme allowlist
 * (`http:`, `https:`, `mailto:`), the same control-character stripping before parsing, the
 * same "leading `/` but not `//` is a same-origin path" rule, the same resolution of
 * everything else against a base origin. This is not a third variant; it is the reference's
 * semantics, and `tests/unit/ui/url.test.ts` (CUST-098) runs both implementations over one
 * corpus and fails on any disagreement, so they cannot drift.
 *
 * Two deliberate, enumerated differences from the reference, both asserted by CUST-098:
 *
 *  1. **This returns the target unescaped.** The reference returns it already run through
 *     `escapeHtml`. Here the value is handed to `attrs()`, which escapes exactly once; if
 *     the guard escaped too, every query string would come out double-encoded
 *     (`?a=1` → `?a&amp;#61;1`). Same decision, same target, escaping applied once at the
 *     one place that writes the attribute.
 *  2. **A same-document fragment (`#main`) is returned unchanged.** The reference resolves
 *     it against the base origin, which would rewrite the demo page's in-page anchors to
 *     `https://verify.itisyou.app/#run_demo_verified` and break them on every environment
 *     that is not production. A fragment carries no scheme and cannot be a script URL, so
 *     accepting it is not a widening of the allowlist — only of the *relative* forms
 *     preserved. Both implementations accept these values; only the rendered target
 *     differs. Flagged to A10 to fold back into the reference.
 *
 * ## What this refuses
 *
 *   `javascript:alert(1)` · `JaVaScRiPt:alert(1)` (scheme comparison is on the parsed
 *   protocol, which is already lower-cased) · `\njavascript:alert(1)` and
 *   `java\tscript:alert(1)` (whitespace and control characters are stripped *before*
 *   parsing, which is what browsers effectively do and naive checks do not) ·
 *   `data:text/html,…` · `vbscript:msgbox(1)` · `file:` · anything `new URL` cannot parse.
 *
 * A protocol-relative `//evil.example/x` is **not** refused: it resolves to
 * `https://evil.example/x`, an ordinary external link with a safe scheme. The guard's job
 * is to stop script execution, not to police destinations — but note that the rendered
 * target becomes explicitly absolute, so a reviewer reading the HTML sees where it goes
 * rather than something that looks same-origin. If off-site links should be refused
 * outright that is a different policy and belongs in one place; say so and I will add it
 * here and tell A10.
 */

/** Exactly the reference's `SAFE_LINK_SCHEMES`. */
export const SAFE_LINK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

/**
 * The origin relative URLs resolve against. Only used to parse; a value that resolves to
 * this origin is still rendered as the relative path the caller gave.
 */
export const SAFE_HREF_BASE = 'https://verify.itisyou.app';


/**
 * Remove every character a browser ignores before a scheme: C0 controls, space, and DEL.
 * Written as an explicit codepoint filter rather than a character class so the source stays
 * readable ASCII — an escape in a regex literal is exactly the kind of thing that gets
 * "tidied" into something subtly different. Semantics match the reference's
 * U+0000-U+0020 plus U+007F character class exactly; CUST-098 proves that by running both
 * implementations over one adversarial corpus and failing on any disagreement.
 */
function stripBlanks(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

/**
 * A validated link target, or `null` when the value must not be linked at all.
 *
 * Callers must treat `null` as "do not render a link" — never as "render it anyway". The
 * components in this package render an inert element instead, so a target we cannot vouch
 * for is not offered rather than silently degraded into something clickable.
 */
export function safeHref(value: string | null | undefined, baseOrigin: string = SAFE_HREF_BASE): string | null {
  if (typeof value !== 'string') return null;
  // Strip everything up to and including the space, plus DEL. A browser tolerates
  // `java\tscript:` and `\njavascript:`; a check that does not strip first will not.
  const cleaned = stripBlanks(value);
  if (cleaned === '') return null;

  // Same-document reference. No scheme, nothing to execute. (Difference 2 above.)
  if (cleaned.startsWith('#')) return cleaned;

  // Same-origin absolute path. `//` is excluded: it is protocol-relative, not a path.
  if (cleaned.startsWith('/') && !cleaned.startsWith('//')) return cleaned;

  let parsed: URL;
  try {
    parsed = new URL(cleaned, baseOrigin);
  } catch {
    return null;
  }
  if (!SAFE_LINK_SCHEMES.has(parsed.protocol)) return null;
  return parsed.href;
}

/** Whether a value would be rendered as a link at all. */
export function isSafeHref(value: string | null | undefined): boolean {
  return safeHref(value) !== null;
}

/**
 * Whether a validated target leaves this site, so a component can add
 * `rel="noopener noreferrer"` without the caller having to remember.
 */
export function isExternalHref(value: string | null | undefined, baseOrigin: string = SAFE_HREF_BASE): boolean {
  const target = safeHref(value, baseOrigin);
  if (target === null) return false;
  if (target.startsWith('/') || target.startsWith('#')) return false;
  try {
    return new URL(target, baseOrigin).origin !== new URL(baseOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * Attributes whose value is a URL the browser will fetch or navigate to. Any attribute
 * named here is scheme-guarded by `attrs()` before it is written.
 *
 * Exact names only: `data` is `<object data>`, and must not be confused with `data-*`,
 * which carries no navigation.
 */
export const URL_BEARING_ATTRIBUTES: ReadonlySet<string> = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'cite',
  'data',
  'ping',
  'xlink:href',
]);
