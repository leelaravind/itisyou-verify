/**
 * The two page-specific diagrams: the customer journey and the system-and-roles map.
 *
 * Both are laid out by hand in 360 viewBox units so they fit a 390px viewport without a
 * horizontal scroll, and both have an HTML twin rendered beside them by `page.ts`. The
 * labels are short by design; every full sentence lives in the twin.
 */
import { html, type Html } from '@verify/ui';
import {
  SvgFigure,
  svgArrow,
  svgBox,
  svgLine,
  svgText,
} from '../../../../../../packages/ui/src/story/index.js';

/* ------------------------------------------------------------------ *
 * Customer journey
 * ------------------------------------------------------------------ */

/** The four verdict boxes, equal in weight. The absence case is drawn as large as the pass. */
const VERDICT_BOXES = [
  { tone: 'verified', lines: ['Verified', 'every mandatory check has supporting evidence'], h: 44 },
  {
    tone: 'failed',
    lines: [
      'Failed',
      'evidence contradicts a rule, or the provider',
      'confirmed absence at the deadline',
    ],
    h: 58,
  },
  {
    tone: 'unverified',
    lines: ['Unverified', 'we could not check — not a pass, not a failure'],
    h: 44,
  },
  { tone: 'pending', lines: ['Pending', 'still inside the agreed completion window'], h: 44 },
] as const;

export function JourneyDiagram(): Html {
  let body = '';

  // 1. enquiry
  body += svgBox({
    x: 60,
    y: 8,
    w: 240,
    h: 36,
    lines: ['An enquiry arrives', 'a website form, for example'],
  });
  body += svgArrow(180, 44, 180, 68);

  // 2. the customer's automation
  body += svgBox({
    x: 60,
    y: 68,
    w: 240,
    h: 48,
    lines: [
      'The customer’s automation runs',
      'and reports success to us',
      'customer_claim: a trigger, not proof',
    ],
    mono: true,
  });
  body += svgArrow(120, 116, 92, 140);
  body += svgArrow(240, 116, 268, 140);

  // 3. we read both outcomes back, independently
  body += svgBox({
    x: 8,
    y: 140,
    w: 168,
    h: 60,
    lines: ['We read the CRM record', 'back from HubSpot', 'provider_readback'],
    mono: true,
    tone: 'sunken',
  });
  body += svgBox({
    x: 184,
    y: 140,
    w: 168,
    h: 60,
    lines: ['We read the email outcome', 'back from Resend', 'readback / signed webhook'],
    mono: true,
    tone: 'sunken',
  });
  body += svgArrow(92, 200, 120, 224);
  body += svgArrow(268, 200, 240, 224);

  // 4. rules
  body += svgBox({
    x: 60,
    y: 224,
    w: 240,
    h: 52,
    lines: [
      'The customer’s rules are evaluated',
      'a closed set of typed operators',
      'over allowlisted fields',
    ],
  });
  body += svgArrow(180, 276, 180, 296);

  // the absence rules, stated in the picture, not only beside it
  body += svgText(
    180,
    312,
    'Absence is answered honestly:',
    'diag-text diag-text--strong',
    'middle',
  );
  body += svgText(
    180,
    326,
    'provider unreachable → Unverified, always',
    'diag-text diag-text--micro',
    'middle',
  );
  body += svgText(
    180,
    340,
    'only RECORD_NOT_FOUND or EVENT_NOT_OBSERVED',
    'diag-text diag-text--micro',
    'middle',
  );
  body += svgText(
    180,
    354,
    'at the deadline can turn absence into Failed',
    'diag-text diag-text--micro',
    'middle',
  );
  body += svgText(180, 372, 'one of four verdicts', 'diag-text diag-text--mono', 'middle');

  // 5. the four verdicts, one column, equal width
  let y = 382;
  const firstY = y;
  let lastBottom = y;
  for (const box of VERDICT_BOXES) {
    body += svgBox({ x: 30, y, w: 300, h: box.h, lines: [...box.lines], tone: box.tone });
    body += svgArrow(18, y + box.h / 2, 30, y + box.h / 2);
    lastBottom = y + box.h;
    y = lastBottom + 10;
  }
  body = svgLine(18, firstY, 18, lastBottom, 'diag-axis') + body;

  return SvgFigure({
    id: 'journey',
    width: 360,
    height: lastBottom + 8,
    body,
    title: 'The customer journey from enquiry to verdict',
    desc:
      'An enquiry arrives; the customer’s automation runs and reports success, which counts as a trigger and not as proof. ' +
      'We read the CRM record back from HubSpot and the email outcome back from Resend, evaluate the customer’s rules over that evidence, ' +
      'and reach one of four verdicts: Verified, Failed, Unverified or Pending. An unreachable provider always gives Unverified; ' +
      'only an authoritative absence at the deadline gives Failed. The steps are listed in full beside this figure.',
    caption: html`How a run is judged. The Unverified box is drawn the same size as the Verified one
    on purpose: "we could not check" is a first-class answer, not a footnote.`,
  });
}

/* ------------------------------------------------------------------ *
 * System and roles
 * ------------------------------------------------------------------ */

interface Chip {
  readonly name: string;
  readonly role: string;
}

const ROUTE_CHIPS: readonly (readonly Chip[])[] = [
  [
    { name: 'public routes', role: 'A05' },
    { name: '/app', role: 'A05' },
    { name: '/owner', role: 'A07' },
  ],
  [
    { name: '/api', role: 'A02' },
    { name: 'webhooks', role: 'A04 · A06' },
    { name: 'scheduler', role: 'A03' },
  ],
  [
    { name: 'assistant', role: 'A08' },
    { name: 'support', role: 'A09' },
    { name: 'growth', role: 'A12' },
  ],
];

const PACKAGE_CHIPS: readonly (readonly Chip[])[] = [
  [
    { name: 'contracts', role: 'lead · frozen' },
    { name: 'domain', role: 'A03' },
    { name: 'security', role: 'A02' },
  ],
  [
    { name: 'connectors', role: 'A04' },
    { name: 'ui', role: 'A05' },
  ],
];

function chipRow(chips: readonly Chip[], y: number, tone: 'plain' | 'sunken'): string {
  const w = 104;
  const gap = 8;
  const total = chips.length * w + (chips.length - 1) * gap;
  const startX = 176 - total / 2;
  return chips
    .map((chip, index) =>
      svgBox({
        x: startX + index * (w + gap),
        y,
        w,
        h: 30,
        lines: [chip.name, chip.role],
        mono: true,
        tone,
      }),
    )
    .join('');
}

export function SystemDiagram(): Html {
  let body = '';

  // the visitor
  body += svgBox({ x: 96, y: 8, w: 160, h: 32, lines: ['Visitor’s browser'] });
  body += svgArrow(176, 40, 176, 56);

  // the Worker
  body += `<rect x="8" y="56" width="336" height="244" rx="6" class="diag-box"/>`;
  body += svgText(176, 74, 'One Cloudflare Worker (Hono)', 'diag-text diag-text--strong', 'middle');
  body += svgText(
    176,
    88,
    'routers, each owned by one specialist',
    'diag-text diag-text--mono',
    'middle',
  );
  ROUTE_CHIPS.forEach((row, index) => {
    body += chipRow(row, 100 + index * 38, 'sunken');
  });
  body += svgText(
    176,
    226,
    'shared packages the Worker is built from',
    'diag-text diag-text--mono',
    'middle',
  );
  PACKAGE_CHIPS.forEach((row, index) => {
    body += chipRow(row, 232 + index * 34, 'plain');
  });

  // storage and the clock
  body += svgArrow(92, 300, 92, 328);
  body += svgArrow(260, 328, 260, 300);
  body += svgBox({
    x: 8,
    y: 328,
    w: 168,
    h: 56,
    lines: ['Cloudflare D1', 'SQLite · EU-West', 'staging + production'],
    mono: true,
    tone: 'sunken',
  });
  body += svgBox({
    x: 184,
    y: 328,
    w: 168,
    h: 56,
    lines: ['Cron trigger', 'every minute, production', 'only — staging has none'],
    mono: true,
    tone: 'sunken',
  });

  // The outside world. This box said "never run against a live account" until 20 September
  // 2026, when it stopped being true for one of the three: a deployment holds real Resend
  // evidence. It is now said per provider, because one sentence covering three providers
  // goes stale the moment any one of them moves.
  body += svgLine(352, 180, 352, 438, 'diag-line');
  body += svgLine(344, 180, 352, 180, 'diag-line');
  body += svgArrow(352, 438, 338, 438);
  body += svgBox({
    x: 8,
    y: 412,
    w: 328,
    h: 52,
    lines: [
      'HubSpot · Resend · Stripe (external)',
      'Resend: live evidence on a deployment',
      'HubSpot: connected, no evidence yet',
    ],
    mono: true,
    tone: 'external',
  });

  return SvgFigure({
    id: 'system',
    width: 360,
    height: 472,
    body,
    title: 'The system and who owned each part',
    desc:
      'A visitor’s browser talks to one Cloudflare Worker running Hono. Inside it, routers for the public site, the customer app, the owner dashboard, ' +
      'the API, webhooks, the scheduler, the assistant, support and growth, each labelled with the specialist role that owned it. ' +
      'The Worker is built from five shared packages: contracts, domain, security, connectors and ui. It reads and writes Cloudflare D1 in EU-West, ' +
      'a one-minute cron trigger drives it in production only, and a dashed box for HubSpot, Resend and Stripe records what each has actually done: ' +
      'Resend has produced real evidence on a deployment, HubSpot is connected and has produced none, and Stripe has taken one sandbox payment. ' +
      'The full list is beside this figure.',
    caption: html`One Worker, one database, one cron, five packages. The box is dashed because
    what is outside it is the only part this service cannot test by running itself. Stripe has
    taken one sandbox payment; live charges are disabled.`,
  });
}
