/**
 * Output-encoding reference implementation — TEST-ONLY, owned by A10.
 *
 * `hono/jsx` escapes interpolated children by default, which covers most of the surface.
 * It does NOT protect you from:
 *   - `dangerouslySetInnerHTML` / raw(),
 *   - values interpolated into an `href`, `src`, `style` or `on*` attribute,
 *   - anything rendered into a CSV, a JSON-LD block, or an email body,
 *   - Markdown rendered to HTML (support replies, run notes, report commentary).
 *
 * Fields in this system that round-trip customer-controlled text to HTML:
 *   workflows.name, support_cases.subject / body_redacted, assertions.label /
 *   expected_display / observed_display (from workflow_versions.rules_json),
 *   evidence.redacted_summary (CRM property values), visit_sessions.utm_* ,
 *   workspaces.name, invitations.intended_email, campaigns.packet_json.
 *
 * A05 (UI) and A07 (owner dashboard) must use `escapeHtml` for text, `safeAttribute`
 * for attribute values, and `safeHref` for every link whose target is not a literal.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
  '=': '&#61;',
};

/** Escapes text destined for an HTML text node or a quoted attribute value. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`=]/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Attribute values additionally have their control characters removed, so a value
 * cannot terminate the attribute through a stray newline in an unquoted context.
 */
export function safeAttribute(value: string): string {
  return escapeHtml(value.replace(/[\u0000-\u001f\u007f]/g, ''));
}

const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Returns a link target that is safe to place in an `href`, or `null` when the value
 * must not be linked at all. Rejects `javascript:`, `data:`, `vbscript:`, and anything
 * that only looks like a scheme after whitespace/control-character stripping.
 */
export function safeHref(value: string, baseOrigin = 'https://verify.itisyou.app'): string | null {
  const cleaned = value.replace(/[\u0000-\u0020\u007f]/g, '');
  if (cleaned === '') return null;
  // A same-document fragment carries no scheme and cannot execute. Returned unchanged.
  //
  // ADOPTED FROM A05 (2026-09-19). This reference previously resolved `#main` against the
  // base origin, yielding `https://verify.itisyou.app/#main` — which rewrites every
  // in-page anchor and breaks them in local development, staging, and the demo. A05 hit
  // that when wiring `packages/ui/src/url.ts` and was right: accepting a fragment widens
  // the set of *relative forms preserved*, not the scheme allowlist, so it costs nothing.
  if (cleaned.startsWith('#')) return escapeHtml(cleaned);
  if (cleaned.startsWith('/') && !cleaned.startsWith('//')) return escapeHtml(cleaned);
  let parsed: URL;
  try {
    parsed = new URL(cleaned, baseOrigin);
  } catch {
    return null;
  }
  if (!SAFE_LINK_SCHEMES.has(parsed.protocol)) return null;
  return escapeHtml(parsed.href);
}

/**
 * Minimal, allowlist-only inline Markdown renderer for support messages and owner notes.
 * Everything is escaped FIRST; only the constructs below are then re-introduced as tags.
 * There is no raw-HTML passthrough, no image syntax, and no reference links.
 */
export function renderInlineMarkdown(input: string): string {
  let out = escapeHtml(input);
  // The backtick has already been escaped to `&#96;` by escapeHtml, so match that form.
  out = out.replace(/&#96;([\s\S]+?)&#96;/g, '<code>$1</code>');
  // **bold** before *italic* so `**x**` does not become `<em>*x*</em>`
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  // [text](url) — the URL is re-decoded from its escaped form, then scheme-checked.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole: string, text: string, href: string) => {
    const decoded = href
      .replace(/&#61;/g, '=')
      .replace(/&#96;/g, '`')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&');
    const safe = safeHref(decoded);
    if (safe === null) return whole;
    return `<a href="${safe}" rel="nofollow noopener noreferrer">${text}</a>`;
  });
  return out;
}
