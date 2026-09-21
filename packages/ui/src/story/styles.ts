/**
 * Stylesheet additions for the visual development story.
 *
 * This is a separate constant rather than an edit to `styles.ts` because that file is A05's.
 * To ship, A05 (or the lead) appends `STORY_BASE` to `BASE` in `packages/ui/src/styles.ts`
 * before `collapse()` runs — one import and one interpolation. The Worker's CSP hash is
 * computed from the resulting `CSS` constant, so nothing else has to change and no page ever
 * needs an inline `style` attribute or a second `<style>` block (which the hash-only policy
 * would refuse).
 *
 * Rules kept here, deliberately:
 *   - No `animation`, no `transition`, no `@keyframes`. The page is a historical record and
 *     nothing on it moves. `prefers-reduced-motion` therefore has nothing to switch off, but
 *     the guard is present anyway so a future addition cannot slip past it unnoticed.
 *   - Status colour is reserved for evidence verdicts, as everywhere else in the system. The
 *     six *story* statuses (`planned` … `externally_confirmed`) are development facts, not
 *     verdicts about a customer's evidence, so they are drawn neutral.
 *   - The one exception is `unknown`, which wears the UNVERIFIED amber: "we do not have this
 *     number" is the same class of statement as "we could not confirm this check".
 *   - Every SVG diagram is sized by `viewBox` and scaled by CSS, never by an attribute a
 *     policy could drop. 360 viewBox units fit a 390px viewport with the page's own padding.
 */

export const STORY_BASE = `
/* ---- visual development story ------------------------------------------- */
.story-toc ul{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:var(--s2) var(--s4);font-size:var(--t-small)}
.story-toc li{margin:0}
.story-section{scroll-margin-top:var(--s6)}
.story-source{font-family:var(--f-mono);font-size:var(--t-micro);color:var(--c-faint);letter-spacing:0.02em;word-break:break-word;margin:0}
.story-source a{color:var(--c-faint)}

/* figures: an SVG drawn from data, with its HTML equivalent alongside */
.story-figure{margin:0;border:1px solid var(--c-rule);border-radius:var(--r-container);background:var(--c-surface);padding:var(--s4);overflow-x:auto;min-width:0}
.story-figure svg{display:block;width:100%;max-width:24rem;height:auto;margin-inline:auto}
.story-figure figcaption{font-size:var(--t-small);color:var(--c-muted);margin-top:var(--s3)}
.story-alt{min-width:0}

/* SVG parts. Fill and stroke come from the theme, so diagrams follow light and dark. */
.diag-box{fill:var(--c-surface);stroke:var(--c-rule-strong);stroke-width:1}
.diag-box--sunken{fill:var(--c-sunken)}
.diag-box--external{stroke-dasharray:4 3}
.diag-box--verified{fill:var(--c-verified-tint);stroke:var(--c-verified);stroke-width:1.5}
.diag-box--failed{fill:var(--c-failed-tint);stroke:var(--c-failed);stroke-width:1.5}
.diag-box--unverified{fill:var(--c-unverified-tint);stroke:var(--c-unverified);stroke-width:1.5}
.diag-box--pending{fill:var(--c-pending-tint);stroke:var(--c-pending);stroke-width:1.5}
.diag-text{font-family:var(--f-sans);font-size:12px;fill:var(--c-ink)}
.diag-text--strong{font-weight:600}
.diag-text--mono{font-family:var(--f-mono);font-size:11px;fill:var(--c-muted)}
.diag-text--micro{font-family:var(--f-mono);font-size:10px;fill:var(--c-faint);letter-spacing:0.04em}
.diag-text--verified{fill:var(--c-verified);font-weight:600}
.diag-text--failed{fill:var(--c-failed);font-weight:600}
.diag-text--unverified{fill:var(--c-unverified);font-weight:600}
.diag-text--pending{fill:var(--c-pending);font-weight:600}
.diag-line{stroke:var(--c-rule-strong);stroke-width:1.2;fill:none}
.diag-head{fill:var(--c-rule-strong)}
.diag-axis{stroke:var(--c-rule-strong);stroke-width:1}
.diag-dot{fill:var(--c-ink)}

/* the six story statuses: development facts, drawn neutral on purpose */
.story-status{display:inline-block;font-family:var(--f-mono);font-size:var(--t-micro);font-weight:600;text-transform:uppercase;letter-spacing:0.07em;line-height:1;padding:0.32rem 0.5rem;border-radius:var(--r-control);border:1px solid var(--c-field-border);color:var(--c-muted);background:var(--c-sunken);white-space:nowrap}
.story-status--unknown{border-style:dashed;text-transform:none;letter-spacing:0}

/* native disclosure: works with JavaScript off, keyboard operable, visible focus ring */
/* No transition here, deliberately, and this is the one place in the product where that is
   still true after the owner asked for motion on 21 September 2026. A hover transition was
   added to this selector with the rest of the animation work and is removed again: the
   development-story page carries the sentence "nothing is animated" in its own copy and
   labels itself a historical record, and DOC-111 exists to hold the page to what it tells
   the reader. Animating it to match the rest of the product would have made the page's own
   claim false, which is a worse outcome than an unanimated hover. */
/* Opens on grid-template-rows rather than height: it stays off the layout path, and it is
   the same device .callout__detail uses, so a disclosure behaves the same wherever it is. */

/* timeline list — the accessible twin of the timeline figure */
.tl{list-style:none;padding:0;margin:0}
.tl>li{margin:0;display:grid;gap:var(--s1) var(--s4);padding-block:var(--s3);border-top:1px solid var(--c-rule)}
.tl>li:first-child{border-top:0}
@media (min-width:34rem){.tl>li{grid-template-columns:7.5rem minmax(0,1fr);align-items:start}}
.tl__when{font-family:var(--f-mono);font-size:var(--t-micro);color:var(--c-faint);letter-spacing:0.04em}
.tl__body{min-width:0}
.tl__body>*+*{margin-top:var(--s1)}
.tl__meta{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;font-family:var(--f-mono);font-size:var(--t-micro);color:var(--c-faint)}

/* decision cards */
.dcard__meta{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;font-family:var(--f-mono);font-size:var(--t-micro);color:var(--c-faint);margin:0}
.dcard__label{font-family:var(--f-mono);font-size:var(--t-micro);text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin:0 0 var(--s1)}
.dcard__list{margin:0;padding-left:1.1em;font-size:var(--t-small)}
.dcard__artifacts{font-family:var(--f-mono);font-size:var(--t-micro);word-break:break-word}

/* evidence panels */
.stats{display:grid;gap:var(--s3)}
.stats>*{min-width:0}
@media (min-width:34rem){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (min-width:60rem){.stats{grid-template-columns:repeat(3,minmax(0,1fr))}}
.stat{border:1px solid var(--c-rule);border-radius:var(--r-container);background:var(--c-surface);padding:var(--s4)}
.stat__value{font-family:var(--f-mono);font-size:var(--t-figure-xs);font-weight:600;line-height:1;letter-spacing:-0.02em;margin:0;word-break:break-word;font-variant-numeric:tabular-nums}
.stat__value--unknown{font-family:var(--f-sans);font-size:var(--t-h3);font-weight:640;letter-spacing:-0.01em;color:var(--c-unverified)}
.stat__unit{font-family:var(--f-sans);font-size:var(--t-small);font-weight:400;color:var(--c-muted);margin-left:0.2em}
.stat__label{font-size:var(--t-small);font-weight:600;margin:var(--s2) 0 0}
.stat__note{font-size:var(--t-small);color:var(--c-muted);margin:var(--s1) 0 0}

/* what broke */
.fail{border-top:1px solid var(--c-rule);padding-top:var(--s6)}
.fail__grid{display:grid;gap:var(--s4)}
.fail__grid>*{min-width:0}
@media (min-width:46rem){.fail__grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
.fail__grid p{font-size:var(--t-small);color:var(--c-muted);margin:0}

/* Nothing on this page moves. The disclosure is a shared component and animates everywhere
   else, so its stillness here is scoped to this page rather than taken away from everyone. */
.story-section .disc,.story-section .disc__summary,.story-section .disc__body{transition:none;animation:none}
@media (prefers-reduced-motion:reduce){
  .disc,.disc__summary,.story-figure svg *{transition:none!important;animation:none!important}
}
`;

/**
 * The same conservative collapse `styles.ts` applies, duplicated here in nine lines rather
 * than imported, because `styles.ts` does not export it and is not this module's to change.
 */
function collapse(source: string): string {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = withoutComments
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let out = '';
  for (const line of lines) {
    if (out.length === 0) {
      out = line;
      continue;
    }
    const last = out.charAt(out.length - 1);
    out += last === ';' || last === '{' || last === '}' || last === ',' ? line : ` ${line}`;
  }
  return out;
}

/** The story additions, collapsed. Tests assert what it must never contain. */
export const STORY_CSS: string = collapse(STORY_BASE);
