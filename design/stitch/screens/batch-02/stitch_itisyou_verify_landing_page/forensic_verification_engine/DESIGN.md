---
name: Forensic Verification Engine
colors:
  surface: '#0f131c'
  surface-dim: '#0f131c'
  surface-bright: '#353943'
  surface-container-lowest: '#0a0e17'
  surface-container-low: '#181b25'
  surface-container: '#1c1f29'
  surface-container-high: '#262a34'
  surface-container-highest: '#31353f'
  on-surface: '#dfe2ef'
  on-surface-variant: '#bbcabf'
  inverse-surface: '#dfe2ef'
  inverse-on-surface: '#2c303a'
  outline: '#86948a'
  outline-variant: '#3c4a42'
  surface-tint: '#4edea3'
  primary: '#4edea3'
  on-primary: '#003824'
  primary-container: '#10b981'
  on-primary-container: '#00422b'
  inverse-primary: '#006c49'
  secondary: '#4cd7f6'
  on-secondary: '#003640'
  secondary-container: '#03b5d3'
  on-secondary-container: '#00424e'
  tertiary: '#ffb95f'
  on-tertiary: '#472a00'
  tertiary-container: '#e29100'
  on-tertiary-container: '#523200'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#6ffbbe'
  primary-fixed-dim: '#4edea3'
  on-primary-fixed: '#002113'
  on-primary-fixed-variant: '#005236'
  secondary-fixed: '#acedff'
  secondary-fixed-dim: '#4cd7f6'
  on-secondary-fixed: '#001f26'
  on-secondary-fixed-variant: '#004e5c'
  tertiary-fixed: '#ffddb8'
  tertiary-fixed-dim: '#ffb95f'
  on-tertiary-fixed: '#2a1700'
  on-tertiary-fixed-variant: '#653e00'
  background: '#0f131c'
  on-background: '#dfe2ef'
  surface-variant: '#31353f'
  surface-canvas: '#0a0e17'
  surface-panel: '#0f131c'
  surface-subcontainer: '#181b25'
  surface-elevated: '#1c1f29'
  border-hairline: '#262a36'
  border-subtle: rgba(255, 255, 255, 0.08)
  status-verified: '#10b981'
  status-verified-light: '#34d399'
  status-verified-bg: rgba(16, 185, 129, 0.12)
  status-failed: '#ef4444'
  status-failed-light: '#f87171'
  status-failed-bg: rgba(239, 68, 68, 0.12)
  status-unverified: '#d97706'
  status-unverified-light: '#f59e0b'
  status-unverified-bg: rgba(217, 119, 6, 0.14)
  status-unverified-neutral: '#78716c'
  status-pending: '#64748b'
  status-pending-light: '#94a3b8'
  status-pending-bg: rgba(100, 116, 139, 0.14)
  text-primary: '#dfe2ef'
  text-secondary: '#94a3b8'
  text-muted: '#64748b'
typography:
  display-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.025em
  display-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-xl:
    fontFamily: Plus Jakarta Sans
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 22px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.015em
  headline-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 22px
    letterSpacing: -0.005em
  body-md:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0.005em
  code-lg:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 18px
    letterSpacing: -0.01em
  code-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0em
  code-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 14px
    letterSpacing: 0.03em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-sm: 0.75rem
  gutter-lg: 1.5rem
  margin: 1.5rem
  margin-sm: 1rem
  margin-lg: 2.5rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1.25rem
  space-xl: 2rem
---

## Brand & Style

This design system serves technical operators, systems engineers, and compliance auditors who require empirical status reporting. The interface avoids marketing rhetoric, decorative indulgence, and unfounded assertions of absolute certainty. Its purpose is to report confirmed findings concisely and declare when checks could not be executed.

### Core Visual Principles
- **Instrument Precision:** Hairline panel boundaries, high-density telemetry rows, and monospaced diagnostic readouts replace consumer dashboard tropes.
- **Controlled Dark Surfaces:** Layered dark forensic substrates create contrast for status badges without visual fatigue.
- **Empirical Clarity:** Visual markers prioritize information hierarchy over visual flourish.

### Voice and Copy Rules
- **No Absolutisms:** Eliminate all terms such as "VERIFIED REALITY", "PHANTOM 200 DETECTED", "zero-trust certainty", "absolute state consensus", "undeniable", or "deterministic certainty".
- **Disciplined Reporting:** Describe state through observable evidence: target probed, settling window elapsed, payload matched, or endpoint unreachable.
- **Equal Prominence for Gaps:** When downstream endpoints are unprobed, rate-limited, timed out, or return access errors, state "we could not check" with equal visual prominence to positive and negative results.
- **Anti-Hype Mandate:** Never display customer count tickers, founder endorsements, client logos, review stars, or calculated monetary savings. Fictional sample data must reflect standard development environments (e.g., `Acme Logistics`, `test-order-491`). All commercial pricing is defined in single-tier Pounds Sterling (`£ / GBP`).

## Colors

The color system operates on an empirical dark substrate, keeping luminous indicators focused on verification states.

### Surface System
- **Canvas Base (`#0a0e17`):** The lowest canvas substrate for the primary window viewport and document body.
- **Surface (`#0f131c`):** Primary working cards, data tables, and telemetry grids.
- **Container Low (`#181b25`):** Subordinated groupings, nested payload viewports, and table row zebra-striping.
- **Container Medium (`#1c1f29`):** Popovers, dropdown menus, context menus, and docked inspectors.
- **Hairline Borders (`#262a36`):** The structural grid bounding all containers, cards, and data splits at 1px width.

### The Four Verification States
Color alone must never be used to convey state. Each status token corresponds to a matching icon glyph and text descriptor:

1. **VERIFIED (`#10b981` / `#34d399`):** Independent query confirmed target record exists and matches expected payload. Background: `rgba(16, 185, 129, 0.12)`.
2. **FAILED (`#ef4444` / `#f87171`):** Target queried after settling window; record definitively missing or rejected with error. Background: `rgba(239, 68, 68, 0.12)`.
3. **UNVERIFIED (`#d97706` / `#f59e0b` / `#78716c`):** System could not check target (rate limit, downstream timeout, endpoint unprobed, or auth denied). Carries equivalent visual weight to Verified and Failed. Background: `rgba(217, 119, 6, 0.14)`.
4. **PENDING (`#64748b` / `#94a3b8`):** Target remains within the agreed settling/completion window; query execution has not occurred. Background: `rgba(100, 116, 139, 0.14)`.

## Typography

Typography maintains functional separation across three families:
- **Structural Headings (Plus Jakarta Sans):** Applied to view titles, module banners, and primary metric panels. Low-contrast letterforms provide clear reading without marketing exaggeration.
- **Reading Plaintext (Inter):** Applied to narrative telemetry summaries, error descriptions, and operational instructions.
- **Telemetry & Identity Strings (JetBrains Mono):** Applied to verified payloads, request identifiers, UUIDs, ISO timestamps, HTTP verbs, status chips, and diff buffers. Tabular figures ensure horizontal alignment within telemetry rows.

## Layout & Spacing

The layout is built on a 12-column structural grid for rapid data scanning across operational screens:

- **Desktop (>1200px):** 12 columns with `gutter-lg` (1.5rem) and `margin-lg` (2.5rem). The telemetry inspector uses a fixed right panel (400px wide) alongside the primary stream.
- **Tablet (768px – 1199px):** 8 columns with `gutter` (1rem) and `margin` (1.5rem). Split views transition into tabbed telemetry views.
- **Mobile (<768px):** 4 columns with `gutter-sm` (0.75rem) and `margin-sm` (1rem). Multi-tier data rows stack into isolated status cards.
- **Component Rhythms:** Internal card padding utilizes `space-md` for standard telemetry listings and `space-sm` for dense hex/payload inspectors. Form fields and trigger controls align to 4px multiples.

## Elevation & Depth

Visual hierarchy relies on flat tonal layering and precise boundaries rather than diffuse shadows or skeuomorphic depth:

- **Hairline Framing:** Surface tiers are divided by a 1px border (`#262a36`). Depth differences are communicated by surface brightness rather than drop shadows.
- **Layer Stacking:** 
  - Substrate layer: `#0a0e17`
  - Inspection tier: `#0f131c`
  - Hover or elevated drawer tier: `#181b25`
- **Focus Indicators:** Interactive triggers on focus receive a crisp 1px highlight (`#06b6d4` or `#10b981`) with zero blur spread.
- **Modals and Drawers:** Popovers and floating telemetry inspectors use a solid `#1c1f29` container framed by `#262a36`, paired with an ambient perimeter line (`1px solid rgba(255, 255, 255, 0.08)`).

## Shapes

The design system uses a constrained corner radius scale (`roundedness: 1`) to reflect instrument design:

- **Operational Elements (Badges, Buttons, Inputs):** 4px (`0.25rem`) fixed radius.
- **Cards & Data Groups:** 6px (`0.375rem`) to 8px (`0.5rem`) corner radius.
- **Overlays & Dialogs:** 8px (`0.5rem`) maximum radius.
- **Status Markers:** Circular indicators are 6px or 8px geometric circles; hollow half-circles for unverified status utilize precise 50% split vectors.

## Components

### 1. Status Indicator Badges (Mandatory 4-State Standard)
Every status element across the interface must include both its assigned symbol and text label. Never use color alone.
- **VERIFIED:**
  - Indicator: `✓ VERIFIED`
  - Glyphs: Checkmark (`✓` or `U+2713`)
  - Tokens: Text `#34d399`, background `rgba(16, 185, 129, 0.12)`, border `1px solid rgba(16, 185, 129, 0.3)`
  - Meaning: Independent query confirmed target record exists and matches expected payload.
- **FAILED:**
  - Indicator: `✕ FAILED`
  - Glyphs: Cross (`✕` or `U+2715`)
  - Tokens: Text `#f87171`, background `rgba(239, 68, 68, 0.12)`, border `1px solid rgba(239, 68, 68, 0.3)`
  - Meaning: Target queried after settling window; record definitively missing or rejected with error.
- **UNVERIFIED:**
  - Indicator: `◐ UNVERIFIED`
  - Glyphs: Semicircle / half-circle (`◐` or `U+25D0`)
  - Tokens: Text `#f59e0b`, background `rgba(217, 119, 6, 0.14)`, border `1px solid rgba(217, 119, 6, 0.35)`
  - Meaning: Could not check target (rate limit, timeout, downstream endpoint unprobed, or auth denied). Must receive full layout weight and visual parity with verified/failed badges.
- **PENDING:**
  - Indicator: `⏱ PENDING`
  - Glyphs: Clock / stopwatch (`⏱` or `U+23F1`)
  - Tokens: Text `#94a3b8`, background `rgba(100, 116, 139, 0.14)`, border `1px solid rgba(100, 116, 139, 0.3)`
  - Meaning: Within agreed settling window; query not yet executed.

### 2. Buttons & Triggers
- **Primary:** Background `#10b981`, foreground text `#0a0e17`, weight 600, border radius 4px. Hover transitions to `#059669`.
- **Secondary / Inspection:** Background `#181b25`, border `1px solid #262a36`, foreground text `#dfe2ef`. Hover introduces border `#64748b`.
- **Destructive Action:** Background `transparent`, border `1px solid rgba(239, 68, 68, 0.4)`, text `#f87171`.

### 3. Inputs & Query Fields
- **Container:** Background `#0a0e17`, border `1px solid #262a36`, border radius 4px, height 36px.
- **Typography:** Uses `code-md` (`JetBrains Mono`, 12px) for API paths, target URLs, payload fields, and filter strings.
- **Active State:** Focus changes border to `#06b6d4` without drop-shadow blurs.

### 4. Telemetry Cards & Inspection Panels
- **Structure:** Background `#0f131c`, border `1px solid #262a36`, border radius 6px.
- **Header Structure:** Title displayed in `headline-sm` (`Plus Jakarta Sans`), right-aligned execution identifier or timestamp set in `code-sm` (`JetBrains Mono`, muted `#94a3b8`).

### 5. Diff & Payload Comparison Tables
- Split comparison: "Source Payload" alongside "Confirmed Target Response".
- Matching attributes display plain `#dfe2ef` text on `#0f131c`.
- Missing keys or discrepancy values are highlighted with a 1px `#ef4444` border and `rgba(239, 68, 68, 0.08)` fill.
- Unprobed or timed-out fields present an unverified state: `◐ COULD NOT CHECK` with `rgba(217, 119, 6, 0.08)` surface framing.

### 6. Selection Controls
- Checkboxes and radios are 14px boxes with a 2px radius, border `1px solid #262a36`, and background `#0a0e17`. Selected state shows a filled `#10b981` square or inner tick.

### 7. Commercial & Billing Component
- Strictly displays single-tier subscription pricing in British Pounds (`£ / GBP`).
- Avoids ROI calculators, enterprise contact funnels, or volume discounts.