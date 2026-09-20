/**
 * The whole stylesheet, as one string.
 *
 * ## Why this is inlined into `<head>` rather than served from `public/`
 *
 * Every page this Worker serves is rendered per request and is `no-store` or short-lived,
 * so the HTML round trip cannot be avoided. A separate stylesheet would therefore add a
 * second, render-blocking round trip to save re-sending a sheet that measures **16,881
 * bytes raw, 3,928 gzipped and 3,416 brotli** (measured, not estimated — see
 * `tests/unit/ui/tokens.test.ts`, case CUST-004). Cloudflare compresses responses, so the
 * cost of inlining is about 3.4KB on the wire per page, comfortably inside the initial
 * congestion window along with the HTML. For a site whose first job is to be understood in
 * fifteen seconds, one request beats two.
 *
 * The constant is exported rather than hidden so that if the sheet ever grows past roughly
 * 10KB compressed it can be moved to `public/app.<hash>.css` with an immutable cache header
 * without touching a single component. CUST-004 fails if it crosses that line, so the
 * decision stays evidence-based rather than remembered.
 *
 * Nothing here needs JavaScript. There is no client framework, and the only script the
 * site ships is a nine-line theme toggle that is purely additive.
 */
import { DARK, FONT, LAYOUT, LIGHT, RADIUS, SPACE, TYPE, type Palette } from './tokens.js';
import { STORY_BASE } from './story/styles.js';

function vars(p: Palette): string {
  return `
  --c-paper:${p.paper};
  --c-surface:${p.surface};
  --c-sunken:${p.sunken};
  --c-ink:${p.ink};
  --c-muted:${p.muted};
  --c-faint:${p.faint};
  --c-rule:${p.rule};
  --c-rule-strong:${p.ruleStrong};
  --c-field-border:${p.fieldBorder};
  --c-focus:${p.focus};
  --c-verified:${p.verified};
  --c-failed:${p.failed};
  --c-unverified:${p.unverified};
  --c-pending:${p.pending};
  --c-verified-tint:${p.tintVerified};
  --c-failed-tint:${p.tintFailed};
  --c-unverified-tint:${p.tintUnverified};
  --c-pending-tint:${p.tintPending};
  --c-on-ink:${p.onInk};`;
}

/*
 * Dark, because the approved design is a dark design, and an OS preference does not
 * overrule it.
 *
 * The first attempt made dark the default and let a light OS preference switch away from
 * it, which meant a machine set to light -- most of them -- still met the old look, and
 * the deployed page was indistinguishable from the one before the change. A design the
 * owner approved is what the product looks like, in the same way its wording is what the
 * product says.
 *
 * The light palette is NOT deleted. It stays complete, stays measured by the contrast
 * suite, and stays reachable through the explicit `data-theme="light"` toggle. What it no
 * longer does is claim the page automatically.
 *
 * (No backticks below this line inside the template: one closed it and broke every test
 * that imports the stylesheet. That has now happened twice.)
 *
 */
const BASE = `
:root{
  color-scheme:dark;${vars(DARK)}
  --f-sans:${FONT.sans};
  --f-mono:${FONT.mono};
  --t-display:${TYPE.display};
  --t-h1:${TYPE.h1};
  --t-h2:${TYPE.h2};
  --t-h3:${TYPE.h3};
  --t-body:${TYPE.body};
  --t-small:${TYPE.small};
  --t-micro:${TYPE.micro};
  --s1:${SPACE.x1};--s2:${SPACE.x2};--s3:${SPACE.x3};--s4:${SPACE.x4};
  --s6:${SPACE.x6};--s8:${SPACE.x8};--s12:${SPACE.x12};--s16:${SPACE.x16};--s24:${SPACE.x24};
  --r-control:${RADIUS.control};
  --r-container:${RADIUS.container};
  --w-measure:${LAYOUT.measure};
  --w-wide:${LAYOUT.wide};
  --w-margin:${LAYOUT.margin};
  --w-step:${LAYOUT.stepMargin};
}

:root[data-theme="dark"]{color-scheme:dark;${vars(DARK)}}
:root[data-theme="light"]{color-scheme:light;${vars(LIGHT)}}

*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--c-paper);color:var(--c-ink);
  font-family:var(--f-sans);font-size:var(--t-body);line-height:1.6;
  -webkit-font-smoothing:antialiased;overflow-wrap:break-word;
}
h1,h2,h3,h4{font-weight:600;line-height:1.2;letter-spacing:-0.02em;margin:0}
h1{font-size:var(--t-h1)}
h2{font-size:var(--t-h2);line-height:1.333;letter-spacing:-0.015em}
h3{font-size:var(--t-h3);line-height:1.444;letter-spacing:-0.01em}
p,ul,ol,dl,figure,pre,table{margin:0}
ul,ol{padding-left:1.25em}
li+li{margin-top:var(--s2)}
img,svg{max-width:100%}
hr{border:0;border-top:1px solid var(--c-rule);margin:0}
code,kbd,samp{font-family:var(--f-mono);font-size:0.9em}

a{color:var(--c-ink);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:0.18em}
a:hover{text-decoration-thickness:2px}

:focus-visible{outline:2px solid var(--c-focus);outline-offset:2px;border-radius:2px}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}
}

/* ---- layout primitives -------------------------------------------------- */
.wrap{width:100%;max-width:var(--w-wide);margin-inline:auto;padding-inline:var(--s4)}
@media (min-width:52rem){.wrap{padding-inline:var(--s8)}}
.measure{max-width:var(--w-measure)}
.stack>*+*{margin-top:var(--s4)}
.stack-sm>*+*{margin-top:var(--s2)}
.stack-lg>*+*{margin-top:var(--s8)}
.section{padding-block:var(--s12)}
.section-tight{padding-block:var(--s8)}
.row{display:flex;flex-wrap:wrap;gap:var(--s3);align-items:center}
.row-between{display:flex;flex-wrap:wrap;gap:var(--s3);align-items:baseline;justify-content:space-between}
/*
  min-width:0 on every grid child is not cosmetic. A grid track sized auto takes its
  minimum from the child's min-content width, and a long monospace identifier or a table
  header row can push that past the viewport - which is how a "responsive" page ends up
  scrolling sideways on a phone. This one line is what CUST-092/093/094 are really testing.
*/
.grid{display:grid;gap:var(--s4)}
.grid>*{min-width:0}
@media (min-width:46rem){.grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (min-width:60rem){.grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}}
/* Utilities, so no component has to reach for an inline style attribute. */
.grid-center{align-items:center}
.grid-wide-gap{gap:var(--s12)}
.band{background:var(--c-surface);border-block:1px solid var(--c-rule)}
.pad-top{padding-top:var(--s6)}
.inline-form{display:inline}
.gap-top{margin-top:var(--s3)}
.align-start{justify-content:flex-start}
.pad-block{padding:var(--s4)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

/* ---- type ---------------------------------------------------------------- */
.mono{font-family:var(--f-mono);font-variant-numeric:tabular-nums}
.eyebrow{
  font-family:var(--f-mono);font-size:var(--t-micro);text-transform:uppercase;
  letter-spacing:0.1em;color:var(--c-muted);margin:0;font-weight:500;
}
.display{font-size:var(--t-display);font-weight:700;line-height:1.143;letter-spacing:-0.03em;margin:0}
.lede{font-size:1.0625rem;color:var(--c-muted);margin:0}
.small{font-size:var(--t-small)}
.muted{color:var(--c-muted)}
.faint{color:var(--c-faint)}
.micro{font-size:var(--t-micro);color:var(--c-faint)}

/* ---- site chrome --------------------------------------------------------- */
.skip{
  position:absolute;left:var(--s2);top:-4rem;z-index:20;background:var(--c-surface);
  color:var(--c-ink);border:1px solid var(--c-ink);border-radius:var(--r-control);
  padding:var(--s2) var(--s4);text-decoration:none;
}
.skip:focus{top:var(--s2)}
/* The header sticks, and is translucent over what scrolls beneath it.
 *
 * This is the first piece of Stitch COMPOSITION rather than palette, taken from the
 * approved header treatment (fixed, a blurred backdrop, a hairline shadow) and applied to
 * the one element every screen shares. Nineteen designs, one rule, and no page markup
 * touched -- the same reason the colours were done at the token layer.
 *
 * Sticky rather than fixed: fixed removes the header from flow and every page would need
 * compensating top padding, which is nineteen chances to get a scroll position wrong.
 * Sticky keeps the document height honest.
 *
 * The blur is progressive. Where it is unsupported the background stays the flat surface
 * colour, which is exactly what this rule replaced, so nothing depends on it. The colour is
 * given BOTH as an opaque fallback and as a translucent value, in that order, so a browser
 * without colour mixing keeps a readable header rather than a see-through one.
 *
 * (No backticks in this comment. It sits inside the CSS template literal, and one has now
 * closed that template three times in a single day.)
 */
.site{
  position:sticky;top:0;z-index:30;
  border-bottom:1px solid var(--c-rule);
  background:var(--c-surface);
  background:color-mix(in srgb, var(--c-surface) 82%, transparent);
  backdrop-filter:blur(12px);
  -webkit-backdrop-filter:blur(12px);
}
@supports not (backdrop-filter:blur(1px)){
  .site{background:var(--c-surface)}
}
.site__inner{display:flex;flex-wrap:wrap;gap:var(--s3) var(--s6);align-items:center;justify-content:space-between;padding-block:var(--s3)}
.brand{display:inline-flex;align-items:baseline;gap:0.45em;text-decoration:none;font-weight:600}
.brand:hover{text-decoration:none}
.brand__mark{font-family:var(--f-mono);letter-spacing:0.14em;font-size:var(--t-small);text-transform:uppercase}
.brand__name{letter-spacing:-0.02em}
.nav{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s4);align-items:center;font-size:var(--t-small)}
.nav a{text-decoration:none;color:var(--c-muted)}
.nav a:hover,.nav a[aria-current]{color:var(--c-ink);text-decoration:underline;text-decoration-thickness:1px}
.nav a[aria-current]{font-weight:600}
.foot{border-top:1px solid var(--c-rule);margin-top:var(--s16);padding-block:var(--s8);font-size:var(--t-small);color:var(--c-muted)}
.foot a{color:var(--c-muted)}
.foot__cols{display:grid;gap:var(--s6)}
@media (min-width:46rem){.foot__cols{grid-template-columns:repeat(3,minmax(0,1fr))}}
.foot ul{list-style:none;padding:0}

/* ---- the evidence margin ------------------------------------------------- */
/* The signature layout: a fixed gutter carrying the verdict glyph and the origin of a
   finding, beside the plain-language sentence. Stacks rather than squeezes on phones. */
.margin-row{display:grid;gap:var(--s2);padding-block:var(--s4);border-top:1px solid var(--c-rule)}
.margin-row:first-child{border-top:0}
/* In a multi-column grid every cell is a "first child" of its own column, so the
   :first-child rule above would strip the rule from one row and not the other. */
.grid>.margin-row{border-top:1px solid var(--c-rule)}
.margin-row__gutter{display:flex;flex-direction:column;gap:var(--s1);align-items:flex-start}
.margin-row__origin{font-family:var(--f-mono);font-size:var(--t-micro);color:var(--c-faint);letter-spacing:0.04em}
/* Assertion labels run to fifteen characters ("Not as expected"), so a badge in the gutter
   wraps rather than overlapping the sentence it is labelling. Badges everywhere else stay
   on one line. */
.margin-row__gutter .badge{white-space:normal;text-align:left;align-items:flex-start}
.margin-row__gutter .badge__glyph{margin-top:0.1em}
@media (min-width:40rem){
  .margin-row{grid-template-columns:var(--w-margin) minmax(0,1fr);gap:var(--s6);align-items:start}
}

/* ---- the claim rule: this product's whole argument, as one device --------- */
.claimrule{border:1px solid var(--c-rule);border-radius:var(--r-container);background:var(--c-surface);padding:var(--s4)}
.claimrule__caption{font-size:var(--t-small);font-weight:640;margin:0 0 var(--s3);padding-bottom:var(--s3);border-bottom:1px solid var(--c-rule)}
.claimrule__label{font-family:var(--f-mono);font-size:var(--t-micro);text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin:0 0 var(--s1)}
.claimrule__value{font-family:var(--f-mono);font-size:var(--t-small);margin:0;word-break:break-word}
.claimrule__claim{color:var(--c-muted)}
.claimrule__split{display:flex;align-items:center;gap:var(--s3);margin-block:var(--s4)}
.claimrule__split::before,.claimrule__split::after{content:"";flex:1 1 auto;border-top:1px solid var(--c-rule-strong)}
.claimrule__verdict{flex:0 0 auto}

/* ---- the comparator: the claim rule's multi-field, two-column sibling ------- */
/* Specified in design/MAPPING.md §8 and built from that specification, not from any
   generated markup. A real table: the field name is a shared row header, so a reader never
   matches rows by eye, and a screen reader hears one row as one unit with its verdict first.
   No animation anywhere near a verdict; no inline style (style-src-attr 'none'). */
.compare{border:1px solid var(--c-rule);border-radius:var(--r-container);background:var(--c-surface);overflow:hidden}
.compare__table{width:100%;border-collapse:collapse;font-size:var(--t-small)}
.compare__table caption{text-align:left;padding:var(--s3) var(--s4);border-bottom:1px solid var(--c-rule)}
.compare__caption{font-weight:640;margin:0;color:var(--c-ink)}
.compare__detail{font-family:var(--f-mono);font-size:var(--t-micro);color:var(--c-faint);margin:var(--s1) 0 0;letter-spacing:0.02em}
.compare__table th,.compare__table td{text-align:left;vertical-align:top;padding:var(--s3) var(--s4);border-bottom:1px solid var(--c-rule)}
.compare__table thead th{font-family:var(--f-mono);font-size:var(--t-micro);text-transform:uppercase;letter-spacing:0.08em;color:var(--c-muted);font-weight:600;white-space:nowrap}
.compare__table tbody tr:last-child th,.compare__table tbody tr:last-child td{border-bottom:0}
.compare__field{display:flex;flex-direction:column;gap:var(--s1);align-items:flex-start;font-weight:600}
.compare__field .badge{white-space:normal;text-align:left;align-items:flex-start}
/* Machine output is mono and tabular, so two values differing in one digit misalign visibly. */
.compare__value{font-family:var(--f-mono);font-variant-numeric:tabular-nums;overflow-wrap:anywhere;min-width:0;margin:0}
.compare__cell--reported .compare__value{color:var(--c-muted)}
/* A contradiction emphasises BOTH values. We know they disagree, not which side is wrong. */
.compare__cell--emphasis .compare__value{color:var(--c-ink);font-weight:600}
/* UNVERIFIED: the words "no reading" in a dashed box. The check did not close, so neither
   does its outline. Never an empty cell, an em dash or a spinner. */
.compare__cell--unverified .compare__value{display:inline-block;border:1px dashed var(--c-unverified);border-radius:var(--r-control);padding:0.1rem 0.45rem;color:var(--c-unverified)}
.compare__cell--pending .compare__value{color:var(--c-muted)}
.compare__reason{font-size:var(--t-small);font-weight:400;color:var(--c-ink);margin:0}
.compare__foot{border-top:2px solid var(--c-rule-strong);padding:var(--s3) var(--s4)}
.compare__verdict{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s3);align-items:center;margin:0;font-size:var(--t-small)}
.compare__foot .verdict-gap{margin-top:var(--s3)}
/* Below the evidence margin's own breakpoint the table stacks as TRIPLETS — one field, its
   verdict, its two values — never as two sequential lists. The heads are hidden visually
   and repeated per cell from data-label; explicit ARIA roles keep the table a table. */
@media (max-width:39.99rem){
  .compare__table,.compare__table caption,.compare__table tbody,.compare__table tr{display:block}
  .compare__table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .compare__table tr{border-bottom:1px solid var(--c-rule);padding-bottom:var(--s2)}
  .compare__table tbody tr:last-child{border-bottom:0}
  .compare__table th,.compare__table td{display:block;border-bottom:0;padding-top:var(--s2);padding-bottom:var(--s1)}
  .compare__table tbody th{padding-top:var(--s3)}
  .compare__table td::before{content:attr(data-label);display:block;font-family:var(--f-mono);font-size:var(--t-micro);text-transform:uppercase;letter-spacing:0.08em;color:var(--c-muted);margin-bottom:0.15rem}
}

/* ---- buttons ------------------------------------------------------------- */
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:var(--s2);
  font:inherit;font-size:var(--t-small);font-weight:560;line-height:1.2;
  padding:0.6rem var(--s4);min-height:2.75rem;border-radius:var(--r-control);
  border:1px solid var(--c-ink);background:var(--c-surface);color:var(--c-ink);
  text-decoration:none;cursor:pointer;transition:background-color .12s ease,color .12s ease;
}
.btn:hover{background:var(--c-sunken);text-decoration:none}
.btn--primary{background:var(--c-ink);color:var(--c-on-ink);border-color:var(--c-ink)}
.btn--primary:hover{background:var(--c-muted);border-color:var(--c-muted)}
.btn--quiet{border-color:var(--c-field-border);color:var(--c-muted);background:transparent}
.btn--quiet:hover{color:var(--c-ink);background:var(--c-sunken)}
.btn--danger{border-color:var(--c-failed);color:var(--c-failed);background:transparent}
.btn--danger:hover{background:var(--c-failed-tint)}
.btn[aria-disabled="true"],.btn:disabled{opacity:.55;cursor:not-allowed}
.btn-row{display:flex;flex-wrap:wrap;gap:var(--s3);align-items:center}

/* ---- cards --------------------------------------------------------------- */
.card{border:1px solid var(--c-rule);border-radius:var(--r-container);background:var(--c-surface);padding:var(--s4)}
@media (min-width:46rem){.card{padding:var(--s6)}}
.card__head{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s4);align-items:baseline;justify-content:space-between;margin-bottom:var(--s3)}
.card__title{font-size:var(--t-h3);margin:0}

/* ---- status badge -------------------------------------------------------- */
.badge{
  display:inline-flex;align-items:center;gap:0.4em;
  font-family:var(--f-mono);font-size:var(--t-micro);font-weight:600;
  text-transform:uppercase;letter-spacing:0.07em;line-height:1;
  padding:0.32rem 0.5rem;border-radius:var(--r-control);border:1px solid currentColor;
  white-space:nowrap;
}
.badge__glyph{flex:0 0 auto}
/*
  The four statuses are NOT separable by colour. Measured pairwise (design/MAPPING.md §2)
  they sit at 1.03–1.24:1 in light mode and 1.01–1.11:1 in dark: in greyscale, or to a
  reader who cannot tell the hues apart, all four are one mark. So every badge carries
  four signals, any one of which separates the four on its own — a glyph with its own
  silhouette, a text label that is always rendered, a border in the status colour (the
  signal that survives forced-colours mode, where backgrounds are overridden and borders
  are kept), and a border STYLE: solid for the three settled answers, dashed for
  UNVERIFIED. The container's outline is broken because the check is.

  UNVERIFIED is deliberately not quieter than the other three. Same size, weight, type
  and tint strength; only the dash differs. It is a first-class answer — "we do not know"
  — and the whole product is the claim that we say that instead of rounding it up. A
  verdict drawn smaller than a pass teaches the reader to skim past the one that most
  needs reading. No status modifier below may set font-size, font-weight, padding,
  opacity or border-width; CUST-411 fails if one does.

  RESIDUAL RISK, carried forward rather than declared solved: amber carries a
  conventional "warning" association and may still read as a soft failure. It was kept
  because the alternative — a neutral grey — reads as "unimportant", which is the worse
  error for this status, and because the value is already measured (6.42:1 light,
  9.47:1 dark). Separation from FAILED is carried by form (dash vs solid, bar vs cross)
  and by wording, not by hue. If readers are observed treating UNVERIFIED as a failure,
  the fix is the wording and the follow-up line under the verdict, not the hue.
*/
.badge--verified{color:var(--c-verified);background:var(--c-verified-tint)}
.badge--failed{color:var(--c-failed);background:var(--c-failed-tint)}
.badge--unverified{color:var(--c-unverified);background:var(--c-unverified-tint);border-style:dashed}
.badge--pending{color:var(--c-pending);background:var(--c-pending-tint)}
.badge--lg{font-size:var(--t-small);padding:0.42rem 0.7rem}
/* The follow-up line an UNVERIFIED headline verdict must carry: what could not be checked,
   and why. In the flow, at body size, never behind a control. */
.verdict-gap{font-size:var(--t-small);margin:0;padding-left:var(--s3);border-left:2px dashed var(--c-unverified)}
.verdict-gap+.verdict-gap{margin-top:var(--s2)}

/* ---- callout ------------------------------------------------------------- */
.callout{border:1px solid var(--c-rule);border-left-width:3px;border-radius:var(--r-control);background:var(--c-surface);padding:var(--s4)}
.callout__title{font-size:var(--t-small);font-weight:640;margin:0 0 var(--s1);display:flex;gap:0.5em;align-items:center}
.callout__body{font-size:var(--t-small);color:var(--c-muted);margin:0}
.callout__body>*+*{margin-top:var(--s2)}
.callout--limit{border-left-color:var(--c-unverified);background:var(--c-unverified-tint)}
.callout--limit .callout__body{color:var(--c-ink)}
.callout--warn{border-left-color:var(--c-failed);background:var(--c-failed-tint)}
.callout--warn .callout__body{color:var(--c-ink)}
.callout--note{border-left-color:var(--c-rule-strong)}
/* A dashed edge, not a second amber. The limit and todo tones were pixel-identical: same
   border colour, same tint, and only an invisible data-tone between them. They mean
   opposite things — "this product cannot do that, permanently" versus "the owner has not
   written this yet" — so one of them has to be separable without reading the hue. Todo
   takes the dash, matching the story page's precedent for a thing that is not settled. */
.callout--todo{border-left-color:var(--c-unverified);border-left-style:dashed;background:var(--c-unverified-tint)}
.callout--todo .callout__body{color:var(--c-ink)}

/* ---- forms --------------------------------------------------------------- */
.fieldset{border:1px solid var(--c-rule);border-radius:var(--r-container);padding:var(--s4);margin:0}
.fieldset>legend{font-size:var(--t-small);font-weight:640;padding-inline:var(--s2)}
.fieldset__hint{font-size:var(--t-small);color:var(--c-muted);margin:0 0 var(--s4)}
.field+.field,.fieldset__hint+.field{margin-top:var(--s4)}
.field__label{display:block;font-size:var(--t-small);font-weight:600;margin-bottom:var(--s1)}
.field__req{font-family:var(--f-mono);font-size:var(--t-micro);color:var(--c-muted);font-weight:400;letter-spacing:0.04em}
.field__hint{font-size:var(--t-small);color:var(--c-muted);margin:0 0 var(--s2)}
.field__error{
  display:flex;gap:0.4em;align-items:flex-start;font-size:var(--t-small);
  color:var(--c-failed);margin:var(--s2) 0 0;font-weight:560;
}
.input,.select,.textarea{
  display:block;width:100%;font:inherit;font-size:var(--t-body);
  padding:0.6rem var(--s3);min-height:2.75rem;
  color:var(--c-ink);background:var(--c-surface);
  border:1px solid var(--c-field-border);border-radius:var(--r-control);
}
.textarea{min-height:7rem;resize:vertical}
.input--mono{font-family:var(--f-mono)}
.input[aria-invalid="true"],.select[aria-invalid="true"],.textarea[aria-invalid="true"]{border-color:var(--c-failed);border-width:2px}
.input::placeholder,.textarea::placeholder{color:var(--c-faint)}
.check{display:flex;gap:var(--s2);align-items:flex-start;font-size:var(--t-small)}
.check input{margin-top:0.25rem;width:1.1rem;height:1.1rem;accent-color:var(--c-ink);flex:0 0 auto}

/* ---- table --------------------------------------------------------------- */
.tablewrap{
  overflow-x:auto;border:1px solid var(--c-rule);border-radius:var(--r-container);
  background:var(--c-surface);-webkit-overflow-scrolling:touch;
}
.table{width:100%;border-collapse:collapse;font-size:var(--t-small)}
.table caption{text-align:left;padding:var(--s3) var(--s4);font-size:var(--t-small);color:var(--c-muted);border-bottom:1px solid var(--c-rule)}
.table th,.table td{text-align:left;padding:var(--s3) var(--s4);border-bottom:1px solid var(--c-rule);vertical-align:top}
.table thead th{
  font-family:var(--f-mono);font-size:var(--t-micro);text-transform:uppercase;
  letter-spacing:0.08em;color:var(--c-muted);font-weight:600;white-space:nowrap;
}
.table tbody tr:last-child td{border-bottom:0}
.table td.num,.table th.num{font-family:var(--f-mono);font-variant-numeric:tabular-nums;white-space:nowrap}

/* ---- states -------------------------------------------------------------- */
.state{border:1px dashed var(--c-rule-strong);border-radius:var(--r-container);padding:var(--s8) var(--s4);text-align:center;background:var(--c-surface)}
.state__title{font-size:var(--t-h3);margin:0 0 var(--s2)}
.state__body{color:var(--c-muted);margin:0 auto;max-width:34rem;font-size:var(--t-small)}
.state__actions{margin-top:var(--s4);display:flex;gap:var(--s3);justify-content:center;flex-wrap:wrap}
.state--error{border-style:solid;border-color:var(--c-failed);background:var(--c-failed-tint);text-align:left}
.state--error .state__body{margin:0;max-width:none;color:var(--c-ink)}
.state--loading{border-style:solid}
.state--loading .state__title{color:var(--c-muted)}

/* ---- breadcrumb & pagination --------------------------------------------- */
.crumbs{font-size:var(--t-small)}
.crumbs ol{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:var(--s1) var(--s2);align-items:center}
.crumbs li{margin:0;display:flex;gap:var(--s2);align-items:center}
.crumbs li+li::before{content:"/";color:var(--c-faint);font-family:var(--f-mono)}
.crumbs a{color:var(--c-muted)}
.crumbs [aria-current]{color:var(--c-ink);font-weight:600}
.pager{display:flex;flex-wrap:wrap;gap:var(--s3);align-items:center;justify-content:space-between;margin-top:var(--s4)}
.pager__status{font-family:var(--f-mono);font-size:var(--t-micro);color:var(--c-faint);letter-spacing:0.04em}

/* ---- key/value list ------------------------------------------------------ */
.kv{display:grid;gap:var(--s1) var(--s4);margin:0;font-size:var(--t-small)}
@media (min-width:34rem){.kv{grid-template-columns:max-content minmax(0,1fr)}}
.kv dt{font-family:var(--f-mono);font-size:var(--t-micro);text-transform:uppercase;letter-spacing:0.08em;color:var(--c-muted);padding-top:0.15rem}
.kv dd{margin:0;font-family:var(--f-mono);word-break:break-word}

/* ---- health readout ------------------------------------------------------ */
.health{display:grid;gap:var(--s4)}
.health>*{min-width:0}
@media (min-width:46rem){.health{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.score{font-family:var(--f-mono);font-size:2.25rem;font-weight:600;line-height:1;letter-spacing:-0.02em;margin:0}
.score--none{font-family:var(--f-sans);font-size:var(--t-h2);font-weight:640;letter-spacing:-0.015em}
.meter{height:6px;border-radius:3px;background:var(--c-sunken);overflow:hidden;margin-top:var(--s3)}
.meter__fill{height:100%;background:var(--c-verified);width:0}
/*
  Meter widths as classes rather than an inline style attribute.
  The Worker's Content-Security-Policy sets style-src-attr 'none', so a computed
  style="width:33%" is dropped - and a dropped width falls back to the element's full
  width, which would draw a 33% verification rate as a full green bar. On a product whose
  whole claim is that it does not flatter you, that is the worst bug the design could have.
  Five-point granularity is plenty: the exact figure is stated in text directly above.
*/
.meter__fill--0{width:0}
.meter__fill--5{width:5%}
.meter__fill--10{width:10%}
.meter__fill--15{width:15%}
.meter__fill--20{width:20%}
.meter__fill--25{width:25%}
.meter__fill--30{width:30%}
.meter__fill--35{width:35%}
.meter__fill--40{width:40%}
.meter__fill--45{width:45%}
.meter__fill--50{width:50%}
.meter__fill--55{width:55%}
.meter__fill--60{width:60%}
.meter__fill--65{width:65%}
.meter__fill--70{width:70%}
.meter__fill--75{width:75%}
.meter__fill--80{width:80%}
.meter__fill--85{width:85%}
.meter__fill--90{width:90%}
.meter__fill--95{width:95%}
.meter__fill--100{width:100%}

/* ---- a call to action that has been taken down --------------------------- */
/* Looks like a control so the reader sees what is unavailable, but is not one: no anchor,
   no button, nothing focusable, nothing a form could submit. */
.unavailable{border:1px dashed var(--c-rule-strong);border-radius:var(--r-container);padding:var(--s4);background:var(--c-sunken)}
.unavailable__control{
  display:inline-flex;align-items:center;gap:var(--s2);
  font-size:var(--t-small);font-weight:560;line-height:1.2;
  padding:0.6rem var(--s4);min-height:2.75rem;border-radius:var(--r-control);
  border:1px dashed var(--c-field-border);color:var(--c-faint);background:var(--c-surface);
  margin:0 0 var(--s3);text-decoration:line-through;
}
.unavailable__reason{font-size:var(--t-small);color:var(--c-ink);margin:0}
.unavailable__when{font-size:var(--t-small);color:var(--c-muted);margin:var(--s2) 0 0}

/* ---- synthetic banner ---------------------------------------------------- */
.synthetic{
  border:2px solid var(--c-unverified);background:var(--c-unverified-tint);color:var(--c-ink);
  border-radius:var(--r-container);padding:var(--s4);
}
.synthetic__tag{
  display:inline-block;font-family:var(--f-mono);font-size:var(--t-micro);font-weight:700;
  text-transform:uppercase;letter-spacing:0.12em;color:var(--c-unverified);margin:0 0 var(--s1);
}
.synthetic__stripe{
  font-family:var(--f-mono);font-size:var(--t-micro);letter-spacing:0.12em;text-transform:uppercase;
  color:var(--c-unverified);border-block:1px solid var(--c-unverified);padding-block:var(--s1);
  margin-bottom:var(--s6);text-align:center;
}

/* ---- steps (a real sequence, so it is numbered) -------------------------- */
.steps{list-style:none;padding:0;counter-reset:step;display:grid;gap:var(--s6)}
.steps>li{margin:0;display:grid;gap:var(--s2);padding-top:var(--s4);border-top:1px solid var(--c-rule)}
.steps>li::before{
  counter-increment:step;content:counter(step,decimal-leading-zero);
  font-family:var(--f-mono);font-size:var(--t-micro);letter-spacing:0.12em;color:var(--c-faint);
}
@media (min-width:46rem){
  .steps>li{grid-template-columns:var(--w-step) minmax(0,1fr);gap:var(--s6);align-items:start}
  .steps>li::before{grid-row:span 2}
}
/* Terse instruction lists — a provider's numbered setup steps — get a tighter rhythm than
   the marketing three-step section, which carries a heading and a paragraph per item. */
.steps--tight{gap:var(--s2)}
.steps--tight>li{padding-top:var(--s2)}
.steps h3{margin:0}
.steps p{margin:var(--s2) 0 0;color:var(--c-muted);font-size:var(--t-small)}
@media (min-width:46rem){.steps>li>*{grid-column:2}}

/* ---- price --------------------------------------------------------------- */
.price{display:flex;align-items:baseline;gap:var(--s2);flex-wrap:wrap}
.price__amount{font-family:var(--f-mono);font-size:2.5rem;font-weight:600;letter-spacing:-0.03em;line-height:1}
.price__period{color:var(--c-muted);font-size:var(--t-small)}

/* ---- faq ----------------------------------------------------------------- */
.faq{border-top:1px solid var(--c-rule)}
.faq>div{border-bottom:1px solid var(--c-rule);padding-block:var(--s4)}
.faq h3{margin:0 0 var(--s2)}
.faq p{margin:0;color:var(--c-muted);font-size:var(--t-small)}

/* ---- the pre-checkout disclosure ----------------------------------------- */
.disclosure{border:1px solid var(--c-rule);border-radius:var(--r-container);background:var(--c-surface);padding:var(--s4)}
@media (min-width:46rem){.disclosure{padding:var(--s6)}}
.disclosure__must{
  font-size:1.0625rem;font-weight:560;line-height:1.5;margin:0 0 var(--s4);
  padding:var(--s4);border-left:3px solid var(--c-ink);background:var(--c-sunken);
  border-radius:var(--r-control);
}
.disclosure__section{border-top:1px solid var(--c-rule);padding-top:var(--s4);margin-top:var(--s4)}
.disclosure__section h4{font-size:var(--t-h3);margin:0 0 var(--s2)}
.disclosure__section p{font-size:var(--t-small);color:var(--c-muted);margin:0}
.disclosure__section p+p{margin-top:var(--s2)}
.disclosure__section ul{font-size:var(--t-small);color:var(--c-muted);margin:0}

/* ---- progress through onboarding ----------------------------------------- */
.progress{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:var(--s1) var(--s3);font-family:var(--f-mono);font-size:var(--t-micro);letter-spacing:0.06em;text-transform:uppercase}
.progress li{margin:0;color:var(--c-faint);display:flex;gap:var(--s2);align-items:center}
.progress li+li::before{content:"\\203A";color:var(--c-rule-strong)}
.progress li[aria-current]{color:var(--c-ink);font-weight:700}
/* A completed setup step is NOT drawn in the verified green. In this system a status
   colour always means a verdict about evidence, and "you filled in this form" is not one.
   Completed steps are simply links; the current step is bold. */
.progress li[data-done="yes"] a{color:var(--c-muted)}
`;

/**
 * Collapse the authored sheet to one line.
 *
 * Deliberately conservative rather than a real minifier: comments go, and lines are joined
 * with no separator only when the previous line already ends in `;`, `{`, `}` or `,` —
 * anywhere else a single space is kept, so a selector or a multi-word value can never be
 * silently welded together. Nothing inside a declaration is rewritten, so `"Segoe UI"` and
 * `\\203A` survive untouched.
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

/**
 * The complete stylesheet, collapsed.
 *
 * `STORY_BASE` is appended last so the development story's figures are styled by the same
 * single inlined sheet — Fable's page renders unstyled without it. It costs about 1.4KB
 * gzipped, and CUST-004 fails if the total ever passes the size that justified inlining at
 * all, so this cannot quietly grow into a second stylesheet's worth of bytes.
 */
export const CSS: string = collapse(`${BASE}
${STORY_BASE}`);

/** Byte length of the sheet as served. Asserted by a unit test so the inline-vs-file call stays honest. */
export const CSS_BYTES: number = new TextEncoder().encode(CSS).length;

/**
 * The only script the site ships. It reads a stored theme preference and reflects it onto
 * `data-theme` before paint. Everything works with this absent — `prefers-color-scheme`
 * already drives the palette, and the toggle is a progressive enhancement over it.
 */
export const THEME_SCRIPT: string = `(function(){try{var t=localStorage.getItem('verify-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;
