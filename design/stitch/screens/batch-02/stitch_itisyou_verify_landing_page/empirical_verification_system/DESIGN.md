---
name: Empirical Verification System
colors:
  surface: '#0f131c'
  surface-dim: '#0f131c'
  surface-bright: '#353943'
  surface-container-lowest: '#0a0e17'
  surface-container-low: '#181b25'
  surface-container: '#1c2029'
  surface-container-high: '#262a34'
  surface-container-highest: '#31353f'
  on-surface: '#dfe2ef'
  on-surface-variant: '#bbcac0'
  inverse-surface: '#dfe2ef'
  inverse-on-surface: '#2c303a'
  outline: '#86948a'
  outline-variant: '#3c4a42'
  surface-tint: '#4edea3'
  primary: '#6ffbbe'
  on-primary: '#003824'
  primary-container: '#4edea3'
  on-primary-container: '#005f40'
  inverse-primary: '#006c4a'
  secondary: '#4cd7f6'
  on-secondary: '#003640'
  secondary-container: '#03b5d4'
  on-secondary-container: '#00424e'
  tertiary: '#ffddb8'
  on-tertiary: '#472a00'
  tertiary-container: '#ffb95f'
  on-tertiary-container: '#754900'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#6ffbbe'
  primary-fixed-dim: '#4edea3'
  on-primary-fixed: '#002114'
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
  status-confirmed: '#4edea3'
  status-inconclusive: '#ffb95f'
  status-discrepancy: '#ffb4ab'
  status-pending: '#94a3b8'
  surface-canvas: '#0a0e17'
  surface-panel: '#181b25'
  surface-raised: '#262a34'
  border-hairline: '#3c4a42'
  border-active: '#4cd7f6'
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
  margin-lg: 3rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2.5rem
---

## Brand & Style
The design system establishes a sober, empirical, and forensic user interface for cross-system telemetry inspection. It abandons marketing hype, absolutist certainty, and infallible claims ("zero-trust certainty", "absolute state consensus", "undeniable reality") in favor of disciplined scientific observation: reading back directly from destination APIs, recording observed payloads, and transparently acknowledging settling delays or observational blind spots.

The visual style merges **Technical Minimalism** with **Forensic Instrumentation**:
- **Forensic Substrates:** Low-reflectance obsidian and deep slate surfaces that prioritize signal-to-noise ratio and prevent eye strain during sustained debugging sessions.
- **Architectural Discipline:** 1px hairline perimeter boundaries, structural grid coordinates, and rigid tabular telemetry that visually structure execution trails without unnecessary skeuomorphic ornament.
- **Skeptical State Reporting:** Visual indicators communicate exactly what was inspected, when the read query executed, what the downstream endpoint responded with, or why verification could not complete (such as network timeouts or downstream rate limits).

Every component, tag, and diff readout is treated as an immutable observation receipt rather than an emotional reassurance.

## Colors
The color palette uses deep, non-emissive dark neutrals to allow functional semantic colors to clearly denote empirical observations.

### Semantic Status Colors
- **Confirmed Evidence (`#4edea3`):** Applied exclusively when downstream inspection returns direct observable records that match expected parameters (e.g., downstream payload confirmed via secondary API read).
- **Secondary Telemetry / Probe (`#4cd7f6`):** Designates active inspection probes, pipeline queries, endpoint paths, and ongoing network reads.
- **Inconclusive / Unable to Verify (`#ffb95f`):** Marks unobservable states—such as downstream rate limiting, target host timeouts, invalid audit credentials, or an expired settling window. It communicates an observational failure, not necessarily a corrupted record.
- **Discrepancy Found (`#ffb4ab` / `#93000a`):** Signals an observable mismatch: the destination API responded successfully, but the expected record was either absent or returned conflicting field values compared to the initial payload.
- **Pending Settle (`#94a3b8`):** A neutral, low-contrast state used during active settling windows when asynchronous queues or eventual consistency intervals are still progressing.

### Neutral Layering Hierarchy
- **Canvas Base:** `#0a0e17`
- **Primary Cards & Containers:** `#181b25`
- **Elevated Modals & Drawers:** `#262a34`
- **Subtle Surface Highlight:** `#31353f`
- **Hairline Borders:** `#3c4a42` (structural base), elevated to `#4cd7f6` during active inspection focus.

## Typography
Typography is divided across structural display, clear reading, and empirical evidence logging:

- **Structural Headings (`Plus Jakarta Sans`):** Provides solid typographic rhythm for screen titles, metrics, and forensic panel groups without excessive warmth.
- **Reading Surfaces (`Inter`):** Clean and neutral for audit summaries, explanation notes, and incident root cause documentation.
- **Forensic Monospace (`JetBrains Mono`):** Dedicated to technical data: payload keys, JSON payloads, ISO-8601 timestamps with millisecond precision, HTTP status responses, trace IDs, and hash receipts. Monospace numerals must always render with tabular sizing for column-aligned log comparisons.

## Layout & Spacing
The layout uses a modular, column-based grid system designed for data density and forensic inspection:

- **Desktop (>= 1280px):** 12 columns with `gutter-lg` (2rem) and `margin-lg` (3rem). Supports parallel split panes: original webhook/request payload alongside the destination API verification response.
- **Tablet (768px – 1279px):** 8 columns with `gutter` (1.5rem) and `margin` (2rem). Inspection diffs transition to tabbed toggles.
- **Mobile (< 768px):** 4 columns with `gutter-sm` (1rem) and `margin-sm` (1rem). Telemetry tables collapse to stacked field inspection rows.

Component layouts rely strictly on `space-xs` (4px) and `space-sm` (8px) for tightly coupled diagnostic data (e.g., label/value pairs, HTTP status codes), while `space-md` (16px) and `space-lg` (24px) partition discrete inspection blocks.

## Elevation & Depth
Elevation is achieved using tonal shift and precision hairline borders rather than heavy drop shadows:

- **Surface Tiers:**
  - Base: `#0a0e17`
  - Container / Card: `#181b25` with a 1px border (`#3c4a42`)
  - Raised Inspector / Drawer: `#262a34` with a 1px top highlight border (`rgba(255, 255, 255, 0.08)`)
- **Status Outlines:**
  - `CONFIRMED_EVIDENCE`: Hairline accent `#4edea3` at 30% alpha.
  - `INCONCLUSIVE`: Hairline accent `#ffb95f` at 35% alpha.
  - `DISCREPANCY_FOUND`: Hairline accent `#ffb4ab` at 40% alpha.
  - `PENDING_SETTLE`: Hairline accent `#94a3b8` at 20% alpha.
- **Backdrop Overlays:** Modal overlays use `rgba(10, 14, 23, 0.8)` with an 8px blur, keeping telemetry cards in background focus while avoiding visual clutter.

## Shapes
The shape language uses subtle 4px (`0.25rem`) rounded corners across interactive controls, keeping the interface structured and aligned with technical tools:

- Buttons, Inputs, and Badges: `0.25rem` (4px).
- Verification Cards and Log Panels: `0.5rem` (8px).
- Modals, Popovers, and Slide-out Inspectors: `0.75rem` (12px).
- Telemetry Status Dots: Fixed 6px circles (`border-radius: 50%`) with no pulsing or glowing effects.

## Components

### Vocabulary & Copy Rules
- **Forbidden Phrases:** Never use "VERIFIED REALITY", "PHANTOM 200 DETECTED", "zero-trust certainty", "absolute consensus", "undeniable", "ground truth guarantee", or "100% verified".
- **Mandatory Empirical Phrasing:**
  - Use: *"Observed downstream state"*, *"Read back directly from destination API"*, *"Settling window elapsed without observable record"*, *"Unable to inspect destination"*, *"Evidence receipt"*.
  - Every assertion must name the specific destination, the queried endpoint, the HTTP status received, and an exact timestamp (e.g., `Stripe GET /v1/charges/ch_3M... [HTTP 200] at 2024-03-29T10:14:22.108Z`).

### Status Badges & Evidence Tags
All status badges are styled with `label-code-sm` uppercase type, a 1px hairline border, and a 6px static indicator pip:
- **`CONFIRMED_EVIDENCE`:**
  - Background: `rgba(78, 222, 163, 0.1)`
  - Border: `rgba(78, 222, 163, 0.4)`
  - Text & Pip: `#4edea3`
  - Microcopy: `CONFIRMED_EVIDENCE`
- **`INCONCLUSIVE`:**
  - Background: `rgba(255, 185, 95, 0.1)`
  - Border: `rgba(255, 185, 95, 0.4)`
  - Text & Pip: `#ffb95f`
  - Microcopy: `UNABLE_TO_VERIFY` or `INCONCLUSIVE`
- **`DISCREPANCY_FOUND`:**
  - Background: `rgba(255, 180, 171, 0.1)`
  - Border: `rgba(255, 180, 171, 0.4)`
  - Text & Pip: `#ffb4ab`
  - Microcopy: `DISCREPANCY_FOUND`
- **`PENDING_SETTLE`:**
  - Background: `rgba(148, 163, 184, 0.1)`
  - Border: `rgba(148, 163, 184, 0.3)`
  - Text & Pip: `#94a3b8`
  - Microcopy: `PENDING_SETTLE (15s remaining)`

### Evidence Cards & Observation Panels
- **Container:** Background `#181b25`, border 1px solid `#3c4a42`.
- **Panel Header:** Title in `headline-sm` with right-aligned inspected endpoint badge and timestamp in `label-code-sm` (`#94a3b8`).
- **Telemetry Breakdown:** A structured data grid displaying:
  1. Primary Observation Target (e.g., `Stripe /v1/charges/:id`)
  2. Inspection Timestamp (ISO 8601 millisecond accuracy)
  3. Response Code received from destination
  4. Matching criteria checklist (e.g., `amount: 4200 matches payload`, `status: 'succeeded'`)

### Diff Viewers (Payload vs. Downstream State)
- Dual-column comparison table:
  - Column 1: `Automation Payload (Reported)`
  - Column 2: `Observed Destination State (Read-back)`
- Rows with value conflicts highlight the cell in `rgba(255, 180, 171, 0.15)` with text `#ffb4ab`.
- If an endpoint was uncontactable, Column 2 renders an `INCONCLUSIVE` placeholder: *"No data retrieved. Upstream gateway returned 504 Gateway Timeout after 5000ms."*

### Buttons & Operational Actions
- **Primary Read/Inspect Action:** Background `#4edea3`, text `#003824` (`font-weight: 600`). On hover, transitions to `#10b981`. Never labeled "Prove Reality"; instead labeled "Run Downstream Inspection" or "Fetch Evidence".
- **Secondary Utility (JSON Raw Export):** Background `#181b25`, 1px border `#3c4a42`, text `#dfe2ef`. On hover, border shifts to `#4cd7f6`.
- **Tertiary Retry Inspection:** Translucent base with 1px border `#ffb95f` at 40% alpha, text `#ffb95f`.

### Text Inputs & Target Endpoint Selectors
- Background: `#0a0e17`
- Border: 1px solid `#3c4a42`
- Focus State: Border switches directly to `#4cd7f6` with zero fuzzy drop-shadow. Monospace font (`label-code-md`) for input strings and query paths.