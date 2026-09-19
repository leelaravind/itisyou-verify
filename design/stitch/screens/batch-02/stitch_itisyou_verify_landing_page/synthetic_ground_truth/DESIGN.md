---
name: Synthetic Ground Truth
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
typography:
  display-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 56px
    fontWeight: '700'
    lineHeight: 64px
    letterSpacing: -0.03em
  display-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 36px
    fontWeight: '700'
    lineHeight: 44px
    letterSpacing: -0.02em
  display-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 40px
    fontWeight: '600'
    lineHeight: 48px
    letterSpacing: -0.02em
  display-md-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
    letterSpacing: -0.02em
  headline-xl:
    fontFamily: Plus Jakarta Sans
    fontSize: 30px
    fontWeight: '600'
    lineHeight: 38px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.015em
  headline-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 26px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
    letterSpacing: -0.005em
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0.005em
  label-code-lg:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: -0.01em
  label-code-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0em
  label-code-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 14px
    letterSpacing: 0.04em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1.5rem
  gutter-sm: 1rem
  gutter-lg: 2rem
  margin: 2rem
  margin-sm: 1rem
  margin-lg: 4rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2.5rem
---

## Brand & Style
The design system embodies radical clarity, forensic accountability, and zero-trust certainty for enterprise engineering teams and compliance-focused agencies. Under the mandate "Don't trust the log. Verify the reality.", the interface rejects ambiguous abstraction in favor of undeniable, deterministic verification.

The visual tone merges high-precision instrumentation with architectural discipline. It blends:
- **Technical Precision:** Crisp 1px hairline delimiters, hairline telemetry matrices, and monospaced diagnostics that treat interface surfaces as verified instruments rather than decorative screens.
- **Glassmorphic Depth:** Translucent dark obsidian layers with subtle spectral back-glows to isolate deep execution telemetry from standard control flows.
- **Forensic High-Contrast:** Intentional luminous accents set against infinite depth, directing immediate cognitive attention toward system state truth, silent failures, and discrepancies.

Every surface evokes absolute engineering rigor, mathematical stability, and unflinching auditability.

## Colors
The palette leverages deep, low-luminance substrates to make forensic status indicators visually authoritative:

- **Primary (`#10B981` — Emerald Verification):** Represents verified reality, cryptographic confirmation, and absolute state consensus. Reserved strictly for proven assertion states, active authentications, and definitive success milestones.
- **Secondary (`#06B6D4` — Cyber Teal):** Communicates telemetry processing, live tracing, pipe connections, and deterministic execution flow. Used for synthetic probes, data streams, and dynamic graph edges.
- **Tertiary (`#F59E0B` — Stark Amber):** Designates phantom successes, assertion drift, silent API anomalies, and degraded parity. Draws immediate focus to situations where logs state '200 OK' but reality failed.
- **Neutral Core (`#090D16` — Deep Void Void):** Foundational root canvas color. Subordinate surface levels step up through slate hierarchies:
  - Surface Tier 1 (Canvas): `#090D16`
  - Surface Tier 2 (Card Substrate): `#0F172A`
  - Surface Tier 3 (Raised Panels/Popovers): `#1E293B`
  - Border Subdued: `rgba(148, 163, 184, 0.08)`
  - Border Active: `rgba(6, 182, 212, 0.28)`
  - Border Verified: `rgba(16, 185, 129, 0.35)`
  - Border Anomaly: `rgba(245, 158, 11, 0.40)`
- **Text Hierarchy:**
  - Foreground High-Contrast: `#F8FAFC`
  - Foreground Muted: `#94A3B8`
  - Foreground Forensic Subdued: `#475569`

## Typography
The typographic hierarchy implements functional specialization:
- **Headlines (Plus Jakarta Sans):** Balances geometric authority with micro-tuned legibility. Used for structural hierarchy, page orchestrations, and critical telemetry metric headlines.
- **Body (Inter):** Highly neutral, screen-optimized standard that eliminates reading friction across dense data layouts, compliance criteria, and incident descriptions.
- **Code & Telemetry (JetBrains Mono):** Dedicated to ground truth: execution IDs, payload hashes, raw network assertions, response timing, and system-level timestamps. All monospaced numerals feature tabular sizing to ensure grid alignment across updating data points.

## Layout & Spacing
The layout follows a 12-column adaptive fluid grid governed by an absolute 4px/8px baseline rhythm:

- **Grid & Margins:**
  - Desktop (>1280px): 12 columns, `gutter-lg` (2rem), `margin-lg` (4rem), max-width bounded at 1680px for wide telemetry displays.
  - Tablet (768px - 1279px): 8 columns, `gutter` (1.5rem), `margin` (2rem). Side rails compress into flyout panels.
  - Mobile (<768px): 4 columns, `gutter-sm` (1rem), `margin-sm` (1rem). Multi-column metric clusters collapse to full-width stacked verification cards.
- **Telemetry Matrices:** Inspection grids rely on fixed-axis subdivisions using `space-xs` and `space-sm` for dense data density, while analytical summaries utilize `space-lg` and `space-xl` for breathing room around macro verification statuses.
- **Structural Alignment:** Containers enforce strict alignment along structural vertical lines to mirror architectural blueprints.

## Elevation & Depth
Depth is constructed through optical transmission, stacked luminous tiers, and structural ghost borders rather than standard drop shadows:

- **Tonal Layers:**
  - Base: Solid deep slate `#090D16` with an optional 32px radial grid matrix (`rgba(255, 255, 255, 0.025)`).
  - Resting Card: `#0F172A` with an ambient surface rim of `1px solid rgba(148, 163, 184, 0.08)`.
  - Floating Telemetry Overlay: `rgba(15, 23, 42, 0.72)` supported by `backdrop-filter: blur(16px) saturate(180%)` and reinforced with a top hairline highlight (`rgba(255, 255, 255, 0.12)`).
- **Glow & Atmospheric Radiation:**
  - Verified nodes radiate a diffuse spotlight: `0 0 24px -4px rgba(16, 185, 129, 0.15)`.
  - Phantom error anomalies produce a high-alert warning halo: `0 0 32px -4px rgba(245, 158, 11, 0.22)`.
  - Precision elevation never introduces visual blur on edges; all component borders remain sharp and mathematically distinct.

## Shapes
A conservative, structural roundedness level (`1`) sets a sharp 4px (`0.25rem`) standard across operational elements. This reinforces architectural exactness without the abrasive feel of unmitigated 0px brutalism:

- Base Controls (Buttons, Inputs, Badges): `4px` (`0.25rem`).
- Diagnostic Cards & Modules: `8px` (`rounded-lg` / `0.5rem`).
- Floating Drawers & Modals: `12px` (`rounded-xl` / `0.75rem`).
- Geometric Tracing Elements: Nodes, endpoints, and status pips use sharp geometric squares or 50% circle pips for binary state indication.

## Components

### Buttons & Interactive Triggers
- **Primary Verify Action:** High-saturation emerald core (`#10B981`), foreground `#090D16` bold text, with crisp inner glow. On hover, transitions to `#059669` with a focused `0 0 16px rgba(16, 185, 129, 0.35)` telemetry field.
- **Secondary (Trace/Inspect):** Dark slate surface (`#0F172A`) framed with a 1px border (`rgba(6, 182, 212, 0.4)`), foreground `#38BDF8`. Hovering introduces a teal scanline shimmer effect.
- **Tertiary/Destructive Override:** Translucent slate with sharp warning amber border (`rgba(245, 158, 11, 0.4)`), active only during verified incident remediation.

### Verification Chips & Telemetry Badges
- Constructed using `label-code-sm` font in all-caps.
- **Verified Ground Truth:** Dark green pill (`rgba(16, 185, 129, 0.1)`) with hairline border (`rgba(16, 185, 129, 0.4)`), centered 6px pulsating green verification pip, copy: `VERIFIED REALITY`.
- **Silent Failure Warning:** Amber pill (`rgba(245, 158, 11, 0.12)`) with high-contrast amber border (`#F59E0B`), copy: `PHANTOM 200 DETECTED`.

### Telemetry Cards & Verification Panels
- Background: `#0F172A` at 90% opacity over structural dark canvas.
- Perimeter: 1px hairline border (`rgba(148, 163, 184, 0.1)`), elevated dynamically on mouse hover to `rgba(6, 182, 212, 0.35)`.
- Header: Split into title (`headline-sm`) and monospaced cryptographic hash/timestamp (`label-code-sm`) anchored to the top-right margin.

### Inputs & Verification Query Fields
- Background: Deep void `#05080F`, 1px border `rgba(148, 163, 184, 0.15)`.
- Font: `label-code-md` for query syntax and target API endpoints.
- Focus State: Border transitions instantaneously to Secondary Cyber Teal (`#06B6D4`) with zero exterior shadow softness, accompanied by an active monospaced cursor blink.

### Selection Controls (Checkboxes & Radios)
- Fixed 16x16px squares with 2px radius.
- Unchecked: Inset border `rgba(148, 163, 184, 0.3)` on `#090D16`.
- Checked: `#10B981` solid background featuring an architectural check vector in `#090D16`.

### Forensic Diff Tables
- Segmented log rows displaying "Reported State" vs. "Verified Reality".
- Rows with divergent states show a left border accent in `#F59E0B` and a subtle highlight wash across the mismatched payload keys.