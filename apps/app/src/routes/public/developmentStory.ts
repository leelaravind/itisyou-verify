/**
 * The development story page.
 *
 * `docs/development-story.md` does not exist in the repository yet, and a Worker has no
 * filesystem, so this page reads the document from the static asset binding at
 * `/development-story.md` if the lead has published it there and renders an honest
 * "not yet published" state if not. It never renders an empty page pretending to be a
 * finished one.
 *
 * The Markdown subset handled is deliberately small — headings, paragraphs, bullet lists,
 * fenced code, inline code and links — because the alternative is either a dependency (the
 * brief forbids new ones) or a hand-rolled parser large enough to be a security surface.
 * Anything outside the subset renders as plain text, which is a legible failure rather
 * than a broken one.
 */
import { Callout, EmptyState, escapeAttribute, html, raw, safeHref, type Html } from '@verify/ui';

/** Escape every character that could break out of text content or an attribute. */
function escapeText(value: string): string {
  return escapeAttribute(value);
}

/**
 * Undo the escaping applied a moment ago, so a link target is scheme-checked in the form the
 * document actually wrote it. Mirrors A10's reference renderer, which does the same.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/** Inline markup: `code`, **bold**, and [text](https://…) with a scheme-guarded href. */
function inline(source: string): string {
  let out = escapeText(source);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // SEC-1214: the scheme decision is `safeHref`'s, not a regex of this file's own. A target
  // it refuses is left as the literal text the document contained, so the reader still sees
  // what was written and nothing becomes clickable that should not be.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole: string, text: string, href: string) => {
    const target = safeHref(decodeEntities(href));
    if (target === null) return whole;
    return `<a href="${escapeText(target)}" rel="nofollow noopener noreferrer">${text}</a>`;
  });
  return out;
}

/**
 * Render the supported Markdown subset. Input is escaped first and markup is only ever
 * added by this function, so a document containing `<script>` renders as visible text.
 */
export function renderMarkdownSubset(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let inCode = false;
  let code: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (listItems.length > 0) {
      out.push(`<ul>${listItems.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`);
      listItems = [];
    }
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        out.push(
          `<pre class="tablewrap pad-block"><code>${escapeText(code.join('\n'))}</code></pre>`,
        );
        code = [];
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      flushList();
      const level = Math.min(4, Math.max(2, (heading[1] ?? '#').length + 1));
      out.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      flushParagraph();
      listItems.push(bullet[1] ?? '');
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  if (inCode && code.length > 0) {
    out.push(`<pre class="tablewrap pad-block"><code>${escapeText(code.join('\n'))}</code></pre>`);
  }
  flushParagraph();
  flushList();
  return out.join('\n');
}

export interface DevelopmentStoryOptions {
  /** The raw Markdown, or null when the document has not been published. */
  readonly markdown: string | null;
}

export function DevelopmentStoryPage(options: DevelopmentStoryOptions): Html {
  if (options.markdown === null) {
    return html`<div class="wrap section stack-lg">
      <div class="stack-sm">
        <p class="eyebrow">Development story</p>
        <h1>How this was built</h1>
      </div>
      ${EmptyState({
        title: 'Not yet published',
        body:
          'The development story has not been written yet. When it is, it will appear here in full, ' +
          'including the parts that did not work. We would rather show an empty page than a placeholder ' +
          'that reads like a finished account.',
        actions: [],
      })}
    </div>`;
  }

  return html`<div class="wrap section stack-lg">
    <div class="stack-sm">
      <p class="eyebrow">Development story</p>
      <h1>How this was built</h1>
    </div>
    ${Callout({
      tone: 'note',
      body: html`<p>
        This is the project's own development document, rendered as written. It is a working record, not
        marketing copy.
      </p>`,
    })}
    <article class="measure stack">${raw(renderMarkdownSubset(options.markdown))}</article>
  </div>`;
}

/**
 * Fetch the published story from the static asset binding. Returns null for anything but a
 * clean 200 — a 404, a 500 or a missing binding all mean "not published", which is a state
 * the page renders honestly.
 */
export async function loadDevelopmentStory(
  assets: Fetcher | undefined,
  baseUrl: string,
): Promise<string | null> {
  if (assets === undefined) return null;
  try {
    const response = await assets.fetch(
      new Request(new URL('/development-story.md', baseUrl).toString()),
    );
    if (response.status !== 200) return null;
    const text = await response.text();
    return text.trim().length === 0 ? null : text;
  } catch {
    return null;
  }
}
