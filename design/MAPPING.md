# Design token mapping and contrast audit

**A19, 2026-09-19.** Companion to `design/tokens.css`. Source material: the Stitch
export at
`design/stitch/screens/batch-01/stitch_itisyou_verify_landing_page/`.

Nothing in this document has been applied to application code. `design/tokens.css`
is a new file that replaces nothing. This is the diff a human is asked to approve.

Every ratio below was computed with the WCAG 2.1 relative-luminance formula
(`L = 0.2126·R + 0.7152·G + 0.0722·B` over the sRGB linearisation
`c ≤ 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4`, ratio `(L₁+0.05)/(L₂+0.05)`),
from the exact hex values each system specifies. Translucent borders were
composited over their stated backdrop first, because a border specified as
`rgba(148,163,184,0.08)` is not an 8% grey — it is the opaque colour that results
from painting it over `#0F172A`, and that is the colour the standard measures.

Thresholds applied: **4.5:1** for body text (WCAG 1.4.3 AA), **3:1** for large
text and for UI component boundaries and non-text indicators (1.4.11).

---

## 1. The palette decision

### The contradiction, confirmed

`synthetic_ground_truth/DESIGN.md` carries two incompatible palettes.

|                     | YAML frontmatter                | Prose body                 |
| ------------------- | ------------------------------- | -------------------------- |
| Primary             | `#4edea3`                       | `#10B981`                  |
| Background / canvas | `#0f131c`                       | `#090D16`                  |
| Card surface        | `#1c1f29` (`surface-container`) | `#0F172A` (Surface Tier 2) |
| Secondary           | `#4cd7f6`                       | `#06B6D4`                  |
| Tertiary            | `#ffb95f`                       | `#F59E0B`                  |

The generated `code.html` compounds it: its Tailwind config is built from the
**YAML** values, while its component classes reproduce the **prose** values as
arbitrary literals — `shadow-[0_0_24px_-4px_rgba(16,185,129,0.35)]` on a button
whose background is `primary-container` `#10b981`. So the shipped artefact is
already a blend of the two, which is exactly the rot to avoid.

### Decision: the YAML frontmatter is authoritative. The prose palette is rejected.

Justified on measurement, not taste. Full tables in §4.

|                  | Pairs audited | Pass | Fail   |
| ---------------- | ------------- | ---- | ------ |
| YAML frontmatter | 25            | 23   | 2      |
| Prose body       | 30            | 18   | **12** |

The prose palette's failures are not edge cases. They are:

- **The entire third text rank.** `#475569` "Foreground Forensic Subdued" scores
  **2.56:1** on the canvas it is specified against, **2.36:1** on card substrate
  and **1.93:1** on raised panels. The owner predicted this; it is worse than
  predicted, because the system uses that colour on three backgrounds and fails
  on all three. It is also the colour the generated page uses for timestamps and
  execution IDs — the evidence, in other words.
- **Every structural border the system defines.** Border Subdued 1.13:1, card rim
  1.17:1, input border 1.21:1, Border Active 1.69:1, unchecked-checkbox border
  1.70:1, Border Verified 1.92:1, Border Anomaly 2.30:1, verified-chip border
  2.15:1. Not one clears 3:1. The lowest-alpha value would need to go from
  8% to **56%** opacity to pass.

The YAML palette's two misses are qualitatively different. `outline-variant`
`#3c4a42` at 1.99:1 is a decorative hairline that carries no information, and
WCAG 1.4.11 does not apply to a boundary that is not required to identify a
component. `error-container` `#93000a` at 1.99:1 fails only when used as _text_,
which is a misuse — it is a Material container (background) role, and the system
supplies `on-error-container` `#ffdad6` for the text that sits on it, which
scores 7.24:1.

That is the difference between a generated tonal system whose pairs are derived
and a hand-picked palette whose pairs were never checked.

### Decision: neither Stitch palette ships

Winning the argument inside the export does not make the YAML palette shippable.

1. **It is dark-only.** The product serves light, dark and system-default. A
   single-theme palette is not a candidate, and inventing its light counterpart
   would be inventing a palette, not adopting one.
2. **It encodes two statuses.** This product has exactly four
   (`VERIFIED`, `FAILED`, `UNVERIFIED`, `PENDING` — `docs/agent-brief.md`) and
   will never have a fifth. A palette with a "primary" and a "tertiary" cannot
   express "we do not know" as a first-class answer; it can only express
   good-and-less-good.
3. **It spends colour on decoration.** Eight `*-fixed` roles, a `surface-tint`,
   an `inverse-primary`. In a product whose argument is that a colour on screen
   is a verdict, a brand colour on a button is a colour that means nothing.

`design/tokens.css` therefore keeps the shipped house palette
(`packages/ui/src/tokens.ts`) as its spine. I re-derived every ratio that file
claims, independently, from the raw hex. They all reproduced exactly — the
documentation there is honest, with one exception recorded in §3.

From the Stitch export, `tokens.css` adopts exactly three things:

| Adopted                              | From                                           | Why                                                                                                                                                                                               |
| ------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--c-raised` (a fourth surface tier) | "Surface Tier 3 (Raised Panels/Popovers)"      | The house ladder stops at three; overlays have nowhere to sit. Re-measured: `#1F2832` in dark, and deliberately equal to `--c-surface` in light because light-mode elevation is shadow, not tone. |
| `--r-overlay: 12px`                  | `rounded.xl: 0.75rem`                          | Same gap: dialogs and drawers currently reuse the card radius.                                                                                                                                    |
| Nothing — confirmation only          | `rounded.DEFAULT 0.25rem`, `rounded.lg 0.5rem` | Stitch independently arrived at the same 4px control / 8px container pair the house already uses. Mild corroboration, no change.                                                                  |

Rejected from the export: every hue, every glow and back-glow, `backdrop-filter`,
all three web fonts (see §6), the `*-fixed` colour roles, and the two-status chip
system (see §2).

---

## 2. The four status treatments

### What the export got wrong

`DESIGN.md` defines two chips and signals both by hue alone:

- **Verified Ground Truth** — green pill, green hairline, "centered 6px
  pulsating green verification pip", copy `VERIFIED REALITY`.
- **Silent Failure Warning** — amber pill, amber border, copy
  `PHANTOM 200 DETECTED`.

Two of our four statuses are simply absent. And a "pip" is a coloured dot: it has
the same silhouette in both states, so the only difference between a pass and a
problem is hue. That is a WCAG 1.4.1 failure on the most important element on the
page.

This is not a theoretical concern here, and there is a number for it. Our four
status colours are near-identical in luminance — the pairwise contrast _between
them_ is:

| Pair                   | Light  | Dark       |
| ---------------------- | ------ | ---------- |
| VERIFIED vs FAILED     | 1.11:1 | 1.11:1     |
| VERIFIED vs UNVERIFIED | 1.08:1 | **1.01:1** |
| VERIFIED vs PENDING    | 1.24:1 | 1.05:1     |
| FAILED vs UNVERIFIED   | 1.03:1 | 1.11:1     |
| FAILED vs PENDING      | 1.12:1 | 1.06:1     |
| UNVERIFIED vs PENDING  | 1.15:1 | 1.05:1     |

Printed in greyscale, or seen by a reader with a colour vision deficiency, all
four statuses are **the same mark**. Any colour-only signal on this product is
not a degraded experience; it is no experience.

### The replacement

Four independent signals on every status. Any one alone separates the four.

|                             | VERIFIED            | FAILED              | UNVERIFIED                       | PENDING                   |
| --------------------------- | ------------------- | ------------------- | -------------------------------- | ------------------------- |
| **Glyph silhouette**        | closed ring + tick  | closed ring + cross | **dashed ring + horizontal bar** | closed ring + clock hands |
| **Text label**              | Verified            | Failed              | Unverified                       | Pending                   |
| **Assertion-level label**   | Confirmed           | Not as expected     | Could not confirm                | Still checking            |
| **Border colour**           | `--c-verified`      | `--c-failed`        | `--c-unverified`                 | `--c-pending`             |
| **Border style**            | solid               | solid               | **dashed**                       | solid                     |
| **Fill**                    | `--c-verified-tint` | `--c-failed-tint`   | `--c-unverified-tint`            | `--c-pending-tint`        |
| **Badge size / weight**     | standard            | standard            | **standard — not reduced**       | standard                  |
| **Required follow-up line** | no                  | no                  | **yes**                          | no                        |
| **Screen-reader prefix**    | "Status: "          | "Status: "          | "Status: "                       | "Status: "                |

The glyphs already exist in `packages/ui/src/components/icons.ts`
(`iconCheck`, `iconCross`, `iconDash`, `iconClock`) and are drawn on a shared
16×16 grid with 1.6 stroke, so they sit on one baseline. The two additions this
task makes are the **dashed border style** and the **required follow-up line**,
both of which are new and both of which exist for UNVERIFIED.

### Why UNVERIFIED looks the way it does

It is a first-class answer meaning _we do not know_, and the whole product is the
claim that we say that instead of rounding it up. Three rules follow.

**It is not quieter than the others.** Same badge dimensions, same border weight,
same type size, same tint strength. A verdict that is rendered smaller than a
pass teaches the reader to skim past it, and this is the verdict that most needs
reading. The export's instinct — a green chip and an amber chip, with the two
hard cases missing entirely — is the instinct to make the product look more
certain than it is.

**Its container is broken, not weak.** The ring in the glyph is dashed and the
badge border is dashed. The shape says _unresolved_, which is different from
_faint_. A dashed outline at full weight and full colour reads as "this is open",
where a thin grey outline reads as "this is unimportant".

**It cannot be mistaken for either neighbour.** It never takes the verified hue,
the tick, or a closed ring — so it is not a soft pass. It never takes the failed
hue or the cross — so it is not a soft fail. Amber-with-a-broken-ring is a third
thing, and the bar glyph is deliberately neither a tick nor a cross: it is a
reading that did not resolve.

**And it carries its own explanation.** In a run's headline verdict, UNVERIFIED
is the only status that requires a following line naming what could not be
checked and why — "Could not reach HubSpot (auth expired 14:22 UTC)". A verdict
with a hole in it must show the shape of the hole. VERIFIED and FAILED are
complete statements; UNVERIFIED is not a statement at all until it says what is
missing.

**Residual risk, recorded rather than hidden.** Amber carries a conventional
"warning" association that risks reading as a soft failure. I kept it because
the alternative — a neutral grey — reads as "not important", which is a worse
error for this particular status, and because the amber value is already shipped
and measured (6.42:1 light, 9.47:1 dark). The separation from FAILED is carried
by form (dashed vs solid, bar vs cross) and by wording, not by hue. If user
testing shows readers treating UNVERIFIED as a failure, the fix is the wording
and the follow-up line, not the hue.

**PENDING** is the easy one and is treated as such: a clock, because the only
thing wrong is that it is early. It is the one status where a muted presentation
is correct, and it is muted by _hue_ (a desaturated slate) rather than by size,
so it still meets AA at 7.40:1 light and 9.06:1 dark.

---

## 3. Correction to the shipped palette

`packages/ui/src/tokens.ts` states that light `faint` `#5E6C78` is
"4.88:1 AA body (**4.49:1 on `sunken`, still AA**)".

It is 4.49:1 on `sunken`, and 4.49 is below 4.50. **It fails AA.** Every other
ratio that file claims is exact; this one rounds the wrong way and calls the
result a pass.

**Minimum adjustment that passes:** `#5E6C78` → `#5D6B77`.

| Backdrop            | `#5E6C78` (current) | `#5D6B77` (proposed) |
| ------------------- | ------------------- | -------------------- |
| `sunken` `#E5EBEF`  | 4.49:1 **fail**     | **4.55:1 pass**      |
| `paper` `#F1F4F6`   | 4.88:1 pass         | 4.96:1 pass          |
| `surface` `#FFFFFF` | 5.40:1 pass         | 5.48:1 pass          |

One step darker, the smallest change in the ramp that clears the threshold on the
worst backdrop. The hierarchy is preserved: `muted` on paper is 6.94:1 and
`faint` is 4.96:1, a 1.98-point gap where it was 2.05 — still three visibly
distinct text ranks, still in the same order.

This is the only colour in `design/tokens.css` that differs from what the
application ships today.

**Applied.** `packages/ui/src/tokens.ts` now carries `#5D6B77` and a comment
stating the measured ratios on all three backdrops, with the history of the wrong
claim recorded in place so the correction cannot be mistaken for a preference.

### 3.1 Did the same error occur anywhere else? — yes, once more

An audit that finds one instance of a class should say whether it looked for more.
It did. **All 31 numeric assertions and 3 qualitative assertions in that file were
recomputed**, not a sample.

**Every number is exact.** All 31 reproduce to two decimal places from the hex
values beside them: light ink 16.48, muted 6.94, faint 4.88 (old value), faint on
sunken 4.49, verified 5.97 / tint 5.72, failed 6.62 / tint 6.20, unverified
6.42 / tint 6.15, pending 7.40 / tint 6.94, fieldBorder 3.88 and 4.28, focus 5.29;
dark ink 16.12, muted 8.81, faint 6.54, verified 9.52, failed 8.57, unverified
9.47, pending 9.06, focus 8.78, fieldBorder 4.38. Whoever wrote them measured
properly.

**Two conclusions drawn from those numbers are wrong, both in the same direction
— asserting better than the truth.**

| #   | Claim                                                                                        | Reality                                                                                                                                                                              | Severity                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | line 56: `faint … 4.49:1 on sunken, still AA`                                                | 4.49 < 4.50. **Fails AA.**                                                                                                                                                           | **Accessibility failure.** Fixed.                                                                                                                              |
| 2   | line 90 (now 100): `Dark palette. **Every ratio here is higher than its light counterpart**` | False for `ink`: light 16.48:1, dark **16.12:1**. Dark is lower. The other eight (muted, faint, verified, failed, unverified, pending, focus, fieldBorder) are all genuinely higher. | **Not an accessibility failure** — 16.12:1 is AAA with enormous margin, and nothing depends on the comparison. It is a false generalisation, not a false pass. |

Also checked and **true**: `ink` is AAA (16.48 ≥ 7); `pending` is AAA (7.40 ≥ 7);
`muted` is correctly labelled AA and not AAA (6.94, just under 7); `fieldBorder`
clears 3:1; `focus` clears 3:1; "each dark status on its own tint stays at or
above 7.8:1" (minimum is `failed` on `tintFailed` at 7.82 — true, and closer to
the line than the wording suggests); and `rule`/`ruleStrong` are indeed below 3:1
on every surface in both themes, as the comment says they are deliberately.

**Claim 2 has not been changed**, because the instruction was to send a diff for
anything outside the colour value and the test rather than commit it. It is one
line:

```diff
--- a/packages/ui/src/tokens.ts
+++ b/packages/ui/src/tokens.ts
@@
 /**
- * Dark palette. Every ratio here is higher than its light counterpart — measured against
- * `paper` (#0D1217):
+ * Dark palette. Measured against `paper` (#0D1217). Every ratio here is higher than its
+ * light counterpart except `ink`, which is 16.12:1 against light's 16.48:1 — both AAA,
+ * and the difference is not one any reader can perceive:
    *   ink 16.12:1, muted 8.81:1, faint 6.54:1, verified 9.52:1, failed 8.57:1,
```

Note also that only **one** colour value changed, not two: dark `faint` `#8C9AA8`
was checked against all three dark surfaces (6.54:1, 5.91:1, 6.78:1) and passes
everywhere. The dark palette needed no correction.

### 3.2 Why the existing test did not catch it

`CUST-003` in `tests/unit/ui/tokens.test.ts` does test contrast — but it checks
`ink`, `muted` and `faint` against `paper` only, and `fieldBorder` against
`surface` only. **`sunken` never entered the loop**, and `sunken` is a real page
background (`.band`, sunken panels). The single pair that failed was the single
pair nobody computed.

That is the actual lesson, and it is not "someone made an arithmetic slip". A
test that checks a subset of the pairs, next to a comment that asserts all of
them, creates a false sense that the comment is covered. The new test
(`tests/unit/ui/contrast.test.ts`, RESIL-176..182) is built so that cannot recur:

| Case      | What it locks                                                                                                                                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RESIL-176 | Every text rank × **every** surface × both themes ≥ 4.5:1.                                                                                                                                                                                                                                                                      |
| RESIL-177 | Every status × every surface **and its own tint** × both themes ≥ 4.5:1.                                                                                                                                                                                                                                                        |
| RESIL-178 | `fieldBorder`, `focus` and every status badge border ≥ 3:1 on every surface (1.4.11); `onInk` on `ink` ≥ 4.5:1.                                                                                                                                                                                                                 |
| RESIL-179 | **The completeness guard.** Every palette key must be classified into a role. Add a colour without deciding its threshold and the suite fails with a message naming the `sunken` incident. A role naming a token that no longer exists also fails, and both palettes must carry identical keys so one theme cannot go untested. |
| RESIL-180 | `rule` and `ruleStrong` stay **below** 3:1. If one rises above it, it has started carrying meaning and must be reclassified — the assertion runs in the other direction on purpose.                                                                                                                                             |
| RESIL-181 | **The anti-drift lock.** Every ratio written in the comment block is recomputed and matched to two decimals, **and** the literal text must still be present in the file. Change a colour without the comment → fail. Change the comment without the colour → fail. Delete the comment → fail.                                   |
| RESIL-182 | Asserts the _premise_ of the colour-alone rule: the four statuses stay within 1.5:1 of each other. If they ever became separable by luminance someone would start relying on hue, so the test pins the fact that they are not.                                                                                                  |

**Verified by regression, not by assertion:** I restored `#5E6C78` temporarily and
re-ran. RESIL-176 failed with
`light: faint (#5E6C78) on sunken (#E5EBEF) is 4.49:1, below the 4.5:1 AA body minimum`
and RESIL-181 failed alongside it. The fix was then restored and the full unit
suite re-run: **1113 tests, 60 files, all passing**; `tsc --noEmit` clean; ESLint
clean; Prettier clean.

---

## 4. Contrast audit

All four tables below are computed output, not estimates. Reproduce with
`design/tokens.css` and the formula stated at the top of this document.

### A. Stitch PROSE palette (rejected)

Where the pair names a translucent border, the Foreground column shows the
**opaque result of compositing it over its stated backdrop** — that is the colour
the eye receives and the colour the standard measures.

| Pair                                                      | Foreground | Background | Ratio   | Needs | Result   |
| --------------------------------------------------------- | ---------- | ---------- | ------- | ----- | -------- |
| High-Contrast text on Canvas                              | `#F8FAFC`  | `#090D16`  | 18.57:1 | 4.5:1 | **PASS** |
| High-Contrast text on Card                                | `#F8FAFC`  | `#0F172A`  | 17.06:1 | 4.5:1 | **PASS** |
| High-Contrast text on Raised                              | `#F8FAFC`  | `#1E293B`  | 13.98:1 | 4.5:1 | **PASS** |
| Muted text on Canvas                                      | `#94A3B8`  | `#090D16`  | 7.58:1  | 4.5:1 | **PASS** |
| Muted text on Card                                        | `#94A3B8`  | `#0F172A`  | 6.96:1  | 4.5:1 | **PASS** |
| Muted text on Raised                                      | `#94A3B8`  | `#1E293B`  | 5.71:1  | 4.5:1 | **PASS** |
| Forensic Subdued on Canvas                                | `#475569`  | `#090D16`  | 2.56:1  | 4.5:1 | **FAIL** |
| Forensic Subdued on Card                                  | `#475569`  | `#0F172A`  | 2.36:1  | 4.5:1 | **FAIL** |
| Forensic Subdued on Raised                                | `#475569`  | `#1E293B`  | 1.93:1  | 4.5:1 | **FAIL** |
| Primary emerald as text on Canvas                         | `#10B981`  | `#090D16`  | 7.66:1  | 4.5:1 | **PASS** |
| Primary emerald as text on Card                           | `#10B981`  | `#0F172A`  | 7.04:1  | 4.5:1 | **PASS** |
| Secondary teal as text on Canvas                          | `#06B6D4`  | `#090D16`  | 8.00:1  | 4.5:1 | **PASS** |
| Tertiary amber as text on Canvas                          | `#F59E0B`  | `#090D16`  | 9.05:1  | 4.5:1 | **PASS** |
| Secondary button label on Card                            | `#38BDF8`  | `#0F172A`  | 8.33:1  | 4.5:1 | **PASS** |
| Primary button text on emerald                            | `#090D16`  | `#10B981`  | 7.66:1  | 4.5:1 | **PASS** |
| Primary button text on hover #059669                      | `#090D16`  | `#059669`  | 5.16:1  | 4.5:1 | **PASS** |
| Input mono text on input bg                               | `#F8FAFC`  | `#05080F`  | 19.15:1 | 4.5:1 | **PASS** |
| Forensic Subdued on input bg                              | `#475569`  | `#05080F`  | 2.64:1  | 4.5:1 | **FAIL** |
| VERIFIED chip label on its 10% fill                       | `#10B981`  | `#0f2733`  | 6.09:1  | 4.5:1 | **PASS** |
| PHANTOM chip label on its 12% fill                        | `#F59E0B`  | `#2b2726`  | 6.88:1  | 4.5:1 | **PASS** |
| VERIFIED chip border rgba(16,185,129,.40) vs Card         | `#0f584d`  | `#0F172A`  | 2.15:1  | 3.0:1 | **FAIL** |
| PHANTOM chip border #F59E0B vs Card                       | `#F59E0B`  | `#0F172A`  | 8.31:1  | 3.0:1 | **PASS** |
| Border Subdued rgba(148,163,184,.08) vs Card              | `#1a2235`  | `#0F172A`  | 1.13:1  | 3.0:1 | **FAIL** |
| Border Active rgba(6,182,212,.28) vs Card                 | `#0c445a`  | `#0F172A`  | 1.69:1  | 3.0:1 | **FAIL** |
| Border Verified rgba(16,185,129,.35) vs Card              | `#0f5048`  | `#0F172A`  | 1.92:1  | 3.0:1 | **FAIL** |
| Border Anomaly rgba(245,158,11,.40) vs Card               | `#6b4d1e`  | `#0F172A`  | 2.30:1  | 3.0:1 | **FAIL** |
| Card rim rgba(148,163,184,.10) vs Card                    | `#1c2538`  | `#0F172A`  | 1.17:1  | 3.0:1 | **FAIL** |
| Input border rgba(148,163,184,.15) vs input bg            | `#1a1f28`  | `#05080F`  | 1.21:1  | 3.0:1 | **FAIL** |
| Checkbox unchecked border rgba(148,163,184,.30) vs Canvas | `#333a47`  | `#090D16`  | 1.70:1  | 3.0:1 | **FAIL** |
| Checkbox tick on emerald fill                             | `#090D16`  | `#10B981`  | 7.66:1  | 3.0:1 | **PASS** |

**12 failures of 30.**

### B. Stitch YAML palette (authoritative reading of the export)

| Pair                                            | Foreground | Background | Ratio   | Needs | Result   |
| ----------------------------------------------- | ---------- | ---------- | ------- | ----- | -------- |
| on-surface on surface                           | `#dfe2ef`  | `#0f131c`  | 14.39:1 | 4.5:1 | **PASS** |
| on-surface on surface-container-lowest          | `#dfe2ef`  | `#0a0e17`  | 14.95:1 | 4.5:1 | **PASS** |
| on-surface on surface-container                 | `#dfe2ef`  | `#1c1f29`  | 12.73:1 | 4.5:1 | **PASS** |
| on-surface on surface-container-highest         | `#dfe2ef`  | `#31353f`  | 9.50:1  | 4.5:1 | **PASS** |
| on-surface-variant on surface                   | `#bbcabf`  | `#0f131c`  | 10.89:1 | 4.5:1 | **PASS** |
| on-surface-variant on surface-container-highest | `#bbcabf`  | `#31353f`  | 7.19:1  | 4.5:1 | **PASS** |
| outline vs surface (UI boundary)                | `#86948a`  | `#0f131c`  | 5.85:1  | 3.0:1 | **PASS** |
| outline-variant vs surface (UI boundary)        | `#3c4a42`  | `#0f131c`  | 1.99:1  | 3.0:1 | **FAIL** |
| primary as text on surface                      | `#4edea3`  | `#0f131c`  | 10.88:1 | 4.5:1 | **PASS** |
| on-primary on primary                           | `#003824`  | `#4edea3`  | 7.73:1  | 4.5:1 | **PASS** |
| primary-container as text on surface            | `#10b981`  | `#0f131c`  | 7.32:1  | 4.5:1 | **PASS** |
| on-primary-container on primary-container       | `#00422b`  | `#10b981`  | 4.56:1  | 4.5:1 | **PASS** |
| secondary as text on surface                    | `#4cd7f6`  | `#0f131c`  | 10.93:1 | 4.5:1 | **PASS** |
| on-secondary on secondary                       | `#003640`  | `#4cd7f6`  | 7.72:1  | 4.5:1 | **PASS** |
| secondary-container as text on surface          | `#03b5d3`  | `#0f131c`  | 7.57:1  | 4.5:1 | **PASS** |
| on-secondary-container on secondary-container   | `#00424e`  | `#03b5d3`  | 4.53:1  | 4.5:1 | **PASS** |
| tertiary as text on surface                     | `#ffb95f`  | `#0f131c`  | 10.93:1 | 4.5:1 | **PASS** |
| on-tertiary on tertiary                         | `#472a00`  | `#ffb95f`  | 7.73:1  | 4.5:1 | **PASS** |
| tertiary-container as text on surface           | `#e29100`  | `#0f131c`  | 7.33:1  | 4.5:1 | **PASS** |
| on-tertiary-container on tertiary-container     | `#523200`  | `#e29100`  | 4.56:1  | 4.5:1 | **PASS** |
| error as text on surface                        | `#ffb4ab`  | `#0f131c`  | 10.94:1 | 4.5:1 | **PASS** |
| on-error on error                               | `#690005`  | `#ffb4ab`  | 7.72:1  | 4.5:1 | **PASS** |
| error-container as text on surface              | `#93000a`  | `#0f131c`  | 1.99:1  | 4.5:1 | **FAIL** |
| on-error-container on error-container           | `#ffdad6`  | `#93000a`  | 7.24:1  | 4.5:1 | **PASS** |
| inverse-on-surface on inverse-surface           | `#2c303a`  | `#dfe2ef`  | 10.22:1 | 4.5:1 | **PASS** |

### C. Proposed `design/tokens.css` — LIGHT

| Pair                                                   | Foreground | Background | Ratio   | Needs | Result   |
| ------------------------------------------------------ | ---------- | ---------- | ------- | ----- | -------- |
| --c-ink on --c-paper                                   | `#10161C`  | `#F1F4F6`  | 16.48:1 | 4.5:1 | **PASS** |
| --c-muted on --c-paper                                 | `#48555F`  | `#F1F4F6`  | 6.94:1  | 4.5:1 | **PASS** |
| --c-faint on --c-paper                                 | `#5D6B77`  | `#F1F4F6`  | 4.96:1  | 4.5:1 | **PASS** |
| --c-verified on --c-paper                              | `#0E6A4C`  | `#F1F4F6`  | 5.97:1  | 4.5:1 | **PASS** |
| --c-failed on --c-paper                                | `#A81F14`  | `#F1F4F6`  | 6.62:1  | 4.5:1 | **PASS** |
| --c-unverified on --c-paper                            | `#7D4E00`  | `#F1F4F6`  | 6.42:1  | 4.5:1 | **PASS** |
| --c-pending on --c-paper                               | `#3F5163`  | `#F1F4F6`  | 7.40:1  | 4.5:1 | **PASS** |
| --c-field-border on --c-paper (UI boundary)            | `#6E7C88`  | `#F1F4F6`  | 3.88:1  | 3.0:1 | **PASS** |
| --c-focus ring on --c-paper (non-text indicator)       | `#1A5FD0`  | `#F1F4F6`  | 5.29:1  | 3.0:1 | **PASS** |
| --c-ink on --c-surface                                 | `#10161C`  | `#FFFFFF`  | 18.20:1 | 4.5:1 | **PASS** |
| --c-muted on --c-surface                               | `#48555F`  | `#FFFFFF`  | 7.66:1  | 4.5:1 | **PASS** |
| --c-faint on --c-surface                               | `#5D6B77`  | `#FFFFFF`  | 5.48:1  | 4.5:1 | **PASS** |
| --c-verified on --c-surface                            | `#0E6A4C`  | `#FFFFFF`  | 6.59:1  | 4.5:1 | **PASS** |
| --c-failed on --c-surface                              | `#A81F14`  | `#FFFFFF`  | 7.31:1  | 4.5:1 | **PASS** |
| --c-unverified on --c-surface                          | `#7D4E00`  | `#FFFFFF`  | 7.09:1  | 4.5:1 | **PASS** |
| --c-pending on --c-surface                             | `#3F5163`  | `#FFFFFF`  | 8.18:1  | 4.5:1 | **PASS** |
| --c-field-border on --c-surface (UI boundary)          | `#6E7C88`  | `#FFFFFF`  | 4.28:1  | 3.0:1 | **PASS** |
| --c-focus ring on --c-surface (non-text indicator)     | `#1A5FD0`  | `#FFFFFF`  | 5.85:1  | 3.0:1 | **PASS** |
| --c-ink on --c-sunken                                  | `#10161C`  | `#E5EBEF`  | 15.14:1 | 4.5:1 | **PASS** |
| --c-muted on --c-sunken                                | `#48555F`  | `#E5EBEF`  | 6.37:1  | 4.5:1 | **PASS** |
| --c-faint on --c-sunken                                | `#5D6B77`  | `#E5EBEF`  | 4.55:1  | 4.5:1 | **PASS** |
| --c-verified on --c-sunken                             | `#0E6A4C`  | `#E5EBEF`  | 5.48:1  | 4.5:1 | **PASS** |
| --c-failed on --c-sunken                               | `#A81F14`  | `#E5EBEF`  | 6.08:1  | 4.5:1 | **PASS** |
| --c-unverified on --c-sunken                           | `#7D4E00`  | `#E5EBEF`  | 5.90:1  | 4.5:1 | **PASS** |
| --c-pending on --c-sunken                              | `#3F5163`  | `#E5EBEF`  | 6.80:1  | 4.5:1 | **PASS** |
| --c-field-border on --c-sunken (UI boundary)           | `#6E7C88`  | `#E5EBEF`  | 3.56:1  | 3.0:1 | **PASS** |
| --c-focus ring on --c-sunken (non-text indicator)      | `#1A5FD0`  | `#E5EBEF`  | 4.86:1  | 3.0:1 | **PASS** |
| --c-ink on --c-raised                                  | `#10161C`  | `#FFFFFF`  | 18.20:1 | 4.5:1 | **PASS** |
| --c-muted on --c-raised                                | `#48555F`  | `#FFFFFF`  | 7.66:1  | 4.5:1 | **PASS** |
| --c-faint on --c-raised                                | `#5D6B77`  | `#FFFFFF`  | 5.48:1  | 4.5:1 | **PASS** |
| --c-verified on --c-raised                             | `#0E6A4C`  | `#FFFFFF`  | 6.59:1  | 4.5:1 | **PASS** |
| --c-failed on --c-raised                               | `#A81F14`  | `#FFFFFF`  | 7.31:1  | 4.5:1 | **PASS** |
| --c-unverified on --c-raised                           | `#7D4E00`  | `#FFFFFF`  | 7.09:1  | 4.5:1 | **PASS** |
| --c-pending on --c-raised                              | `#3F5163`  | `#FFFFFF`  | 8.18:1  | 4.5:1 | **PASS** |
| --c-field-border on --c-raised (UI boundary)           | `#6E7C88`  | `#FFFFFF`  | 4.28:1  | 3.0:1 | **PASS** |
| --c-focus ring on --c-raised (non-text indicator)      | `#1A5FD0`  | `#FFFFFF`  | 5.85:1  | 3.0:1 | **PASS** |
| --c-verified on --c-verified-tint (badge)              | `#0E6A4C`  | `#E4F2EC`  | 5.72:1  | 4.5:1 | **PASS** |
| --c-failed on --c-failed-tint (badge)                  | `#A81F14`  | `#FBE8E6`  | 6.20:1  | 4.5:1 | **PASS** |
| --c-unverified on --c-unverified-tint (badge)          | `#7D4E00`  | `#F7EEDC`  | 6.15:1  | 4.5:1 | **PASS** |
| --c-pending on --c-pending-tint (badge)                | `#3F5163`  | `#E8EDF2`  | 6.94:1  | 4.5:1 | **PASS** |
| --c-verified badge border vs --c-paper (UI boundary)   | `#0E6A4C`  | `#F1F4F6`  | 5.97:1  | 3.0:1 | **PASS** |
| --c-failed badge border vs --c-paper (UI boundary)     | `#A81F14`  | `#F1F4F6`  | 6.62:1  | 3.0:1 | **PASS** |
| --c-unverified badge border vs --c-paper (UI boundary) | `#7D4E00`  | `#F1F4F6`  | 6.42:1  | 3.0:1 | **PASS** |
| --c-pending badge border vs --c-paper (UI boundary)    | `#3F5163`  | `#F1F4F6`  | 7.40:1  | 3.0:1 | **PASS** |
| --c-on-ink on --c-ink (primary button)                 | `#F1F4F6`  | `#10161C`  | 16.48:1 | 4.5:1 | **PASS** |

**0 failures of 45.**

### D. Proposed `design/tokens.css` — DARK

| Pair                                                   | Foreground | Background | Ratio   | Needs | Result   |
| ------------------------------------------------------ | ---------- | ---------- | ------- | ----- | -------- |
| --c-ink on --c-paper                                   | `#E9EEF3`  | `#0D1217`  | 16.12:1 | 4.5:1 | **PASS** |
| --c-muted on --c-paper                                 | `#A6B3C0`  | `#0D1217`  | 8.81:1  | 4.5:1 | **PASS** |
| --c-faint on --c-paper                                 | `#8C9AA8`  | `#0D1217`  | 6.54:1  | 4.5:1 | **PASS** |
| --c-verified on --c-paper                              | `#5CCCA4`  | `#0D1217`  | 9.52:1  | 4.5:1 | **PASS** |
| --c-failed on --c-paper                                | `#FF9082`  | `#0D1217`  | 8.57:1  | 4.5:1 | **PASS** |
| --c-unverified on --c-paper                            | `#E8AE45`  | `#0D1217`  | 9.47:1  | 4.5:1 | **PASS** |
| --c-pending on --c-paper                               | `#A4B6C9`  | `#0D1217`  | 9.06:1  | 4.5:1 | **PASS** |
| --c-field-border on --c-paper (UI boundary)            | `#6B7C8C`  | `#0D1217`  | 4.38:1  | 3.0:1 | **PASS** |
| --c-focus ring on --c-paper (non-text indicator)       | `#7FB3FF`  | `#0D1217`  | 8.78:1  | 3.0:1 | **PASS** |
| --c-ink on --c-surface                                 | `#E9EEF3`  | `#161D25`  | 14.55:1 | 4.5:1 | **PASS** |
| --c-muted on --c-surface                               | `#A6B3C0`  | `#161D25`  | 7.95:1  | 4.5:1 | **PASS** |
| --c-faint on --c-surface                               | `#8C9AA8`  | `#161D25`  | 5.91:1  | 4.5:1 | **PASS** |
| --c-verified on --c-surface                            | `#5CCCA4`  | `#161D25`  | 8.59:1  | 4.5:1 | **PASS** |
| --c-failed on --c-surface                              | `#FF9082`  | `#161D25`  | 7.73:1  | 4.5:1 | **PASS** |
| --c-unverified on --c-surface                          | `#E8AE45`  | `#161D25`  | 8.55:1  | 4.5:1 | **PASS** |
| --c-pending on --c-surface                             | `#A4B6C9`  | `#161D25`  | 8.18:1  | 4.5:1 | **PASS** |
| --c-field-border on --c-surface (UI boundary)          | `#6B7C8C`  | `#161D25`  | 3.95:1  | 3.0:1 | **PASS** |
| --c-focus ring on --c-surface (non-text indicator)     | `#7FB3FF`  | `#161D25`  | 7.92:1  | 3.0:1 | **PASS** |
| --c-ink on --c-sunken                                  | `#E9EEF3`  | `#090D11`  | 16.70:1 | 4.5:1 | **PASS** |
| --c-muted on --c-sunken                                | `#A6B3C0`  | `#090D11`  | 9.13:1  | 4.5:1 | **PASS** |
| --c-faint on --c-sunken                                | `#8C9AA8`  | `#090D11`  | 6.78:1  | 4.5:1 | **PASS** |
| --c-verified on --c-sunken                             | `#5CCCA4`  | `#090D11`  | 9.87:1  | 4.5:1 | **PASS** |
| --c-failed on --c-sunken                               | `#FF9082`  | `#090D11`  | 8.88:1  | 4.5:1 | **PASS** |
| --c-unverified on --c-sunken                           | `#E8AE45`  | `#090D11`  | 9.81:1  | 4.5:1 | **PASS** |
| --c-pending on --c-sunken                              | `#A4B6C9`  | `#090D11`  | 9.39:1  | 4.5:1 | **PASS** |
| --c-field-border on --c-sunken (UI boundary)           | `#6B7C8C`  | `#090D11`  | 4.54:1  | 3.0:1 | **PASS** |
| --c-focus ring on --c-sunken (non-text indicator)      | `#7FB3FF`  | `#090D11`  | 9.09:1  | 3.0:1 | **PASS** |
| --c-ink on --c-raised                                  | `#E9EEF3`  | `#1F2832`  | 12.78:1 | 4.5:1 | **PASS** |
| --c-muted on --c-raised                                | `#A6B3C0`  | `#1F2832`  | 6.98:1  | 4.5:1 | **PASS** |
| --c-faint on --c-raised                                | `#8C9AA8`  | `#1F2832`  | 5.19:1  | 4.5:1 | **PASS** |
| --c-verified on --c-raised                             | `#5CCCA4`  | `#1F2832`  | 7.55:1  | 4.5:1 | **PASS** |
| --c-failed on --c-raised                               | `#FF9082`  | `#1F2832`  | 6.79:1  | 4.5:1 | **PASS** |
| --c-unverified on --c-raised                           | `#E8AE45`  | `#1F2832`  | 7.51:1  | 4.5:1 | **PASS** |
| --c-pending on --c-raised                              | `#A4B6C9`  | `#1F2832`  | 7.18:1  | 4.5:1 | **PASS** |
| --c-field-border on --c-raised (UI boundary)           | `#6B7C8C`  | `#1F2832`  | 3.47:1  | 3.0:1 | **PASS** |
| --c-focus ring on --c-raised (non-text indicator)      | `#7FB3FF`  | `#1F2832`  | 6.96:1  | 3.0:1 | **PASS** |
| --c-verified on --c-verified-tint (badge)              | `#5CCCA4`  | `#10261F`  | 8.06:1  | 4.5:1 | **PASS** |
| --c-failed on --c-failed-tint (badge)                  | `#FF9082`  | `#2A1613`  | 7.82:1  | 4.5:1 | **PASS** |
| --c-unverified on --c-unverified-tint (badge)          | `#E8AE45`  | `#291F0E`  | 8.15:1  | 4.5:1 | **PASS** |
| --c-pending on --c-pending-tint (badge)                | `#A4B6C9`  | `#151D26`  | 8.18:1  | 4.5:1 | **PASS** |
| --c-verified badge border vs --c-paper (UI boundary)   | `#5CCCA4`  | `#0D1217`  | 9.52:1  | 3.0:1 | **PASS** |
| --c-failed badge border vs --c-paper (UI boundary)     | `#FF9082`  | `#0D1217`  | 8.57:1  | 3.0:1 | **PASS** |
| --c-unverified badge border vs --c-paper (UI boundary) | `#E8AE45`  | `#0D1217`  | 9.47:1  | 3.0:1 | **PASS** |
| --c-pending badge border vs --c-paper (UI boundary)    | `#A4B6C9`  | `#0D1217`  | 9.06:1  | 3.0:1 | **PASS** |
| --c-on-ink on --c-ink (primary button)                 | `#0D1217`  | `#E9EEF3`  | 16.12:1 | 4.5:1 | **PASS** |

**0 failures of 45.**

### E. Minimum passing adjustments for every failure

Each proposal is the smallest change that clears the threshold while preserving
the hierarchy the original intended. These apply **only if** someone chooses to
revive part of a rejected palette; `design/tokens.css` uses none of these colours.

| Failing pair                                                | Measured | Minimum fix           | Result | Hierarchy preserved?                                                                                                                                                                                       |
| ----------------------------------------------------------- | -------- | --------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prose `#475569` text on Canvas `#090D16`                    | 2.56:1   | → `#7C8BA1`           | 5.61:1 | Yes — sits between Muted `#94A3B8` (7.58) and nothing below it; `#64748B` reaches only 4.08:1 and is not enough.                                                                                           |
| Prose `#475569` text on Card `#0F172A`                      | 2.36:1   | → `#7C8BA1`           | 5.16:1 | Yes                                                                                                                                                                                                        |
| Prose `#475569` text on Raised `#1E293B`                    | 1.93:1   | → `#94A3B8`           | 5.71:1 | **No** — on the raised tier the third rank collapses into the second. The honest fix is to drop the third text rank on raised panels, not to recolour it.                                                  |
| Prose `#475569` on input bg `#05080F`                       | 2.64:1   | → `#7C8BA1`           | 5.79:1 | Yes                                                                                                                                                                                                        |
| Border Subdued `rgba(148,163,184,.08)` on Card              | 1.13:1   | alpha 0.08 → **0.56** | 3.03:1 | The intended effect (an almost-invisible rim) is unachievable at AA. Either accept it as decorative and carry the card's identity on its background step, or make it a real 3:1 border. It cannot be both. |
| Card rim `rgba(148,163,184,.10)` on Card                    | 1.17:1   | alpha 0.10 → **0.56** | 3.03:1 | Same                                                                                                                                                                                                       |
| Input border `rgba(148,163,184,.15)` on input bg            | 1.21:1   | alpha 0.15 → **0.55** | 3.01:1 | An input boundary is never decorative — 1.4.11 applies. Must be fixed.                                                                                                                                     |
| Checkbox unchecked border `rgba(148,163,184,.30)` on Canvas | 1.70:1   | alpha 0.30 → **0.55** | 3.04:1 | Must be fixed; an unchecked checkbox has no other visible boundary.                                                                                                                                        |
| Border Active `rgba(6,182,212,.28)` on Card                 | 1.69:1   | alpha 0.28 → **0.54** | 3.01:1 | Must be fixed; it signals focus.                                                                                                                                                                           |
| Border Verified `rgba(16,185,129,.35)` on Card              | 1.92:1   | alpha 0.35 → **0.56** | 3.04:1 | Must be fixed; it is a status signal.                                                                                                                                                                      |
| Verified chip border `rgba(16,185,129,.40)` on Card         | 2.15:1   | use solid `#10B981`   | 7.04:1 | Matches what the amber chip already does (solid `#F59E0B`, 8.31:1) — the export is inconsistent with itself here.                                                                                          |
| Border Anomaly `rgba(245,158,11,.40)` on Card               | 2.30:1   | alpha 0.40 → **0.52** | 3.07:1 | Must be fixed; it is a status signal.                                                                                                                                                                      |
| YAML `outline-variant` `#3c4a42` vs surface                 | 1.99:1   | → `#5a6e63`           | 3.40:1 | Only needed if it is ever load-bearing. As a decorative hairline it may stay.                                                                                                                              |
| YAML `error-container` `#93000a` as text                    | 1.99:1   | do not use as text    | —      | Use `on-error-container` `#ffdad6` (7.24:1) on it, or `error` `#ffb4ab` (10.94:1) as the text colour. This is a misuse of the role, not a bad value.                                                       |

The proposed `design/tokens.css` has **no** failures to adjust: 45 pairs in light,
45 in dark, all pass. See tables C and D.

---

## 5. Token-to-code mapping

### 5.1 The honest finding first

**`apps/app/src/**` contains no colour literals and no size literals.** I searched
the whole tree for hex values, `rgb(`/`rgba(`, and `px`/`rem`/`em` in style
positions. There are zero. Every colour and dimension in the running application
already lives in `packages/ui/src/tokens.ts` and is emitted as a custom property
by `packages/ui/src/styles.ts`.

The only two files under `apps/app/src/` that mention styling at all are
`index.ts` (the CSP, which hashes the stylesheet) and
`routes/public/story/narrative.ts` (which quotes `style="width:33%"` inside a
prose sentence about a bug). Neither is a literal to replace.

So the requested mapping "for every existing colour/size literal in the app" has
an empty left-hand side in `apps/app/src/` and a real one in `packages/ui/src/`,
which is where the literals actually are. That package is owned by A05 and is out
of scope for me to edit. The mapping below is the handoff.

### 5.2 Colour literals — `packages/ui/src/tokens.ts`

Every value is identical unless marked. 36 colour literals in total.

| Existing literal                        | Where                                     | Token in `design/tokens.css`                                | Change                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------- | ----------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#F1F4F6` `#FFFFFF` `#E5EBEF`           | `LIGHT.paper/surface/sunken`              | `--c-paper` `--c-surface` `--c-sunken`                      | **Visually identical**                                                                                                                                                                                                                                                                                                                                                          |
| `#10161C` `#48555F`                     | `LIGHT.ink/muted`                         | `--c-ink` `--c-muted`                                       | **Visually identical**                                                                                                                                                                                                                                                                                                                                                          |
| `#5E6C78`                               | `LIGHT.faint`                             | `--c-faint` = `#5D6B77`                                     | **Deliberate improvement.** Fixes the 4.49:1 AA failure on `sunken` (§3). Perceptually a one-step darkening; a reader will not notice, an audit will.                                                                                                                                                                                                                           |
| `#CBD4DC` `#A5B2BE` `#6E7C88` `#1A5FD0` | `LIGHT.rule/ruleStrong/fieldBorder/focus` | `--c-rule` `--c-rule-strong` `--c-field-border` `--c-focus` | **Visually identical**                                                                                                                                                                                                                                                                                                                                                          |
| `#0E6A4C` `#A81F14` `#7D4E00` `#3F5163` | `LIGHT` statuses                          | `--c-verified` `--c-failed` `--c-unverified` `--c-pending`  | **Visually identical**                                                                                                                                                                                                                                                                                                                                                          |
| `#E4F2EC` `#FBE8E6` `#F7EEDC` `#E8EDF2` | `LIGHT` tints                             | `--c-*-tint`                                                | **Visually identical**                                                                                                                                                                                                                                                                                                                                                          |
| `#0D1217` `#161D25` `#090D11`           | `DARK.paper/surface/sunken`               | `--c-paper` `--c-surface` `--c-sunken`                      | **Visually identical**                                                                                                                                                                                                                                                                                                                                                          |
| `#E9EEF3` `#A6B3C0` `#8C9AA8`           | `DARK.ink/muted/faint`                    | `--c-ink` `--c-muted` `--c-faint`                           | **Visually identical**                                                                                                                                                                                                                                                                                                                                                          |
| `#27313B` `#3C4954` `#6B7C8C` `#7FB3FF` | `DARK.rule/ruleStrong/fieldBorder/focus`  | `--c-rule` `--c-rule-strong` `--c-field-border` `--c-focus` | **Visually identical**                                                                                                                                                                                                                                                                                                                                                          |
| `#5CCCA4` `#FF9082` `#E8AE45` `#A4B6C9` | `DARK` statuses                           | `--c-verified` `--c-failed` `--c-unverified` `--c-pending`  | **Visually identical**                                                                                                                                                                                                                                                                                                                                                          |
| `#10261F` `#2A1613` `#291F0E` `#151D26` | `DARK` tints                              | `--c-*-tint`                                                | **Visually identical**                                                                                                                                                                                                                                                                                                                                                          |
| `#F1F4F6` / `#0D1217`                   | `onInk` both palettes                     | `--c-on-ink`                                                | **Visually identical**                                                                                                                                                                                                                                                                                                                                                          |
| — (new)                                 | no equivalent today                       | `--c-raised` (`#FFFFFF` light, `#1F2832` dark)              | **Regression risk: none today, low on adoption.** Nothing uses it yet. In light it equals `--c-surface` deliberately; if a component ever relies on seeing a difference in light mode it will find none, which is why the comment in `tokens.css` says so explicitly. All dark-mode text ranks re-measured against it: lowest is `--c-field-border` at 3.47:1, still above 3:1. |

### 5.3 Size and dimension literals — `packages/ui/src/styles.ts`

| Existing literal                                          | Count       | Where                                                                   | Token                                         | Change                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | ----------- | ----------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `1px`                                                     | 33          | every border, rule and outline                                          | `--hairline`                                  | **Visually identical.** Naming only. Worth doing because a future high-density adjustment currently means 33 edits.                                                                                                                                                                                                                                                                                                                        |
| `2.75rem`                                                 | 3           | `.btn`, `.field`, `.select` min-height                                  | `--control-height`                            | **Visually identical.** 44px, the minimum touch target — a value that should be stated once with its reason, not repeated three times without one.                                                                                                                                                                                                                                                                                         |
| `0.6rem`                                                  | 3           | `.btn`, `.field`, `.select` vertical padding                            | `--control-pad-y`                             | **Visually identical**                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `1.0625rem`                                               | 2           | `.lede`, `.disclosure__title`                                           | `--t-lede`                                    | **Visually identical.** Currently an off-scale size with no name; it is 17px and it is intentional, so it should be a token rather than a number two places agree on by luck.                                                                                                                                                                                                                                                              |
| `1.1rem`                                                  | 1           | `.check input` width/height                                             | _none proposed_                               | Deliberately left alone. A checkbox sized in `rem` tracks the label; forcing it onto the 4px scale would break that.                                                                                                                                                                                                                                                                                                                       |
| `0.25rem` `0.5rem` `0.32rem` `0.42rem` `0.7rem` `0.15rem` | 6           | badge and checkbox padding                                              | `--s1` `--s2` / _none_                        | **Regression risk.** `0.25rem`/`0.5rem` are already `--s1`/`--s2` and can be swapped with no visual change. The others (`0.32`, `0.42`, `0.7`, `0.15`) are optically tuned badge padding that does **not** sit on the 4px grid. Snapping them to the scale would change badge height, which changes the evidence-margin width, which is the one measurement the layout comment in `tokens.ts` says was already got wrong once. Leave them. |
| `0.01em`–`0.14em` letter-spacing                          | 14 distinct | headings, eyebrow, mono                                                 | _none proposed_                               | Deliberately left alone. Optical tracking per size is not a scale, and tokenising it would invite someone to "standardise" it.                                                                                                                                                                                                                                                                                                             |
| `34rem` `40rem` `46rem` `52rem` `60rem`                   | 12 uses     | media query conditions                                                  | `--bp-sm` … `--bp-xl`, **documentation only** | **No change possible.** A custom property cannot be used in a media query condition in any browser. `tokens.css` records the set in a comment so it can be grepped, and says explicitly not to "fix" the literals by referencing them. Flagged because a future reader will otherwise try.                                                                                                                                                 |
| `390px` `24rem` `7.5rem` `12px` `11px` `10px` `1.75rem`   | 7           | `packages/ui/src/story/styles.ts` (the development-story illustrations) | _none proposed_                               | Deliberately left alone. These are SVG illustration geometry, not interface dimensions. `7.5rem` duplicates `--w-margin` and could use it; the rest should not be tokenised.                                                                                                                                                                                                                                                               |
| `4px` / `8px`                                             | 2           | `RADIUS.control` / `RADIUS.container`                                   | `--r-control` `--r-container`                 | **Visually identical.** Independently corroborated by the Stitch export, which arrived at the same pair.                                                                                                                                                                                                                                                                                                                                   |
| — (new)                                                   | —           | dialogs currently reuse `--r-container`                                 | `--r-overlay: 12px`                           | **Deliberate improvement** when adopted; nothing uses it yet. From Stitch `rounded.xl`.                                                                                                                                                                                                                                                                                                                                                    |

### 5.4 Type and spacing scale

`--t-display` … `--t-micro`, `--s1` … `--s24`, `--w-measure`, `--w-wide`,
`--w-margin`, `--w-step`, `--f-sans`, `--f-mono` are carried across byte-identical
from `packages/ui/src/tokens.ts`. **Visually identical** in every case.

The Stitch scale (`space-xs` 0.25 / `space-sm` 0.5 / `space-md` 1 / `space-lg` 1.5
/ `space-xl` 2.5rem) is a subset of the house scale, so nothing needed to change.
Its type scale is a fixed-pixel ladder with separate mobile variants
(`display-lg` 56px / `display-lg-mobile` 36px); the house scale uses `clamp()`
and gets the same range with no breakpoint. No change.

---

## 6. Fonts and the CSP consequence

The Stitch system specifies **Plus Jakarta Sans** (headings), **Inter** (body) and
**JetBrains Mono** (code), and the generated `code.html` loads them with
`<link href="https://fonts.googleapis.com/css2?...">` plus
`<script src="https://cdn.tailwindcss.com">`.

**Recommendation: adopt none of them.** The exact cost, since the brief requires
it to be stated rather than waved at.

`apps/app/src/index.ts` currently serves:

```
default-src 'none'; style-src 'sha256-…' 'sha256-…'; style-src-elem 'sha256-…' 'sha256-…';
style-src-attr 'none'; script-src 'sha256-…'; script-src-attr 'none';
img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none';
frame-ancestors 'none'; connect-src 'self'; upgrade-insecure-requests
```

| Option                                            | CSP change required                                                                                                                                                                                                    | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Fonts as the export uses them              | `style-src` **and** `style-src-elem` gain `https://fonts.googleapis.com`; `font-src` gains `https://fonts.gstatic.com`.                                                                                                | **Not worth it.** The hash-only style policy becomes a host-allowlist policy: today the browser will apply only our exact bytes; afterwards it will apply any stylesheet Google serves. That is the single strongest guarantee in the policy and it would be spent on a typeface. It also adds a subprocessor — every page view sends the visitor's IP and User-Agent to Google — which would need a new disclosure on the privacy page. |
| Self-hosting the same three faces                 | **None.** `font-src 'self'` already permits it, and the `@font-face` rules live inside the already-hashed inline stylesheet. Note the hash changes, but it is recomputed from the constant at boot, so nothing breaks. | **Still not worth it.** Zero policy cost, but 4+ font requests and roughly 120–200KB on a Worker whose entire stylesheet is 3.4KB brotli, for a site whose first job is to be understood in fifteen seconds.                                                                                                                                                                                                                             |
| `cdn.tailwindcss.com`, as the generated page uses | `script-src` and `script-src-elem` gain a third-party host, defeating the hash policy on scripts as well.                                                                                                              | **Never.** This is a play-CDN JIT compiler running in the page. It is not a production technique and it is not a technique this policy can express.                                                                                                                                                                                                                                                                                      |
| System font stack (current)                       | None.                                                                                                                                                                                                                  | **Adopt.** Zero requests, zero policy, zero subprocessors, renders on every target platform. The Stitch intent — geometric sans for headings, neutral sans for prose, mono for machine output — survives; only the specific faces do not.                                                                                                                                                                                                |

The one idea from the export's typography worth keeping costs nothing: its split
between prose faces and a mono face for "ground truth" is the same rule the house
system already enforces (human wrote it → sans; machine produced it → mono).
Independent arrival at the same rule is worth recording.

---

## 7. Lexicon — take the visual system, reject the vocabulary

The export's writing asserts the opposite of what the engine does. This product
exists because it returns `UNVERIFIED` — "we could not check" — instead of
rounding a missing reading up to a pass. Words like _absolute_, _undeniable_ and
_certainty_ claim the rounding-up that the whole design refuses. A sceptical
buyer who reads "absolute state consensus" on the marketing page and then meets
an `UNVERIFIED` verdict in the product has caught us contradicting ourselves, and
they will be right.

### 7.1 Rejected phrases

Every phrase below appears in `synthetic_ground_truth/DESIGN.md` or the generated
`code.html`. None may be reintroduced.

| Rejected phrase                                                                    | Why it is rejected                                                                                                                                                                |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERIFIED REALITY`                                                                 | We verify evidence, not reality. We saw what two APIs returned, which is a smaller claim and the only one we can support.                                                         |
| `PHANTOM 200 DETECTED`                                                             | Jargon that names our internal diagnosis rather than the customer's problem, and asserts detection of a thing we infer. A 200 with no matching record is evidence, not a phantom. |
| `zero-trust certainty`                                                             | "Zero-trust" is a network security term being borrowed for its sound, and "certainty" is the one thing we never sell.                                                             |
| `absolute state consensus`                                                         | Nothing here is absolute and there is no consensus mechanism. Three words, three false implications.                                                                              |
| `undeniable, deterministic verification`                                           | "Undeniable" invites a customer to deny it. Our verdicts are deniable — that is why they cite evidence.                                                                           |
| `deterministic certainty`                                                          | Determinism is a property of our rule evaluation, not of the world it observes. Missing evidence is not made certain by being evaluated consistently.                             |
| `cryptographic confirmation`                                                       | We do not sign or attest anything cryptographically. This is a security claim we cannot support and it would not survive a procurement questionnaire.                             |
| `Verification Oracles` / `Real-Time Oracle Consensus`                              | Blockchain vocabulary for an HTTP request to HubSpot. It makes the product sound like something it is not.                                                                        |
| `Zero-Trust Payload Ledger`                                                        | We store evidence rows in D1. Calling it a ledger implies immutability and an audit chain we do not build.                                                                        |
| `Cryptographic Proof Protocol`                                                     | Same. There is no protocol and no proof.                                                                                                                                          |
| `absolute engineering rigor`, `unflinching auditability`, `mathematical stability` | Self-praise, unfalsifiable, and the kind of phrase that makes a technical buyer stop reading.                                                                                     |
| `Don't trust the log. Verify the reality.`                                         | Good rhythm, wrong claim, and it insults the customer's existing tooling on the way past. Keep the structure, drop "reality".                                                     |
| `All Verification Oracles Operational 99.99%`                                      | An uptime figure we have not measured, presented as live status.                                                                                                                  |
| `SOC2 TYPE II VERIFIED`, `ISO 27001 COMPLIANT`, `E2E ENCRYPTED HASHING`            | Compliance claims that are false today. See `design/REVIEW.md` §2. The third is not even coherent.                                                                                |
| `Certified SLA Partner`, `Custom SLA Settlement Guarantee (99.99%)`                | We offer no SLA and settle nothing.                                                                                                                                               |
| `silent failures were proactively mitigated`                                       | We observe. We never modify a customer's CRM, send replacement emails or repair their automation (`docs/agent-brief.md`). "Mitigated" claims we act.                              |
| `Ground-Truth Checks` (as a billing unit)                                          | "Ground truth" asserts our reading is the truth. Our reading is evidence.                                                                                                         |
| `Phantom Success`, `Silent Failure Warning` (as UI labels)                         | Neither maps to one of the four statuses. A UI label that is not a status is a fifth status by the back door.                                                                     |

### 7.2 Replacement lexicon

Plain English. Each line is a claim we can defend if a buyer pushes on it.

| Concept                     | Say this                                                                                                                             | Not this                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| What the product does       | "Checks whether your automation actually did what it was supposed to do, using evidence we fetch ourselves from HubSpot and Resend." | "Deterministic ground-truth verification infrastructure" |
| The core promise            | "We check independently, and we tell you when we could not."                                                                         | "Absolute state consensus"                               |
| Tagline                     | "Your workflow said it worked. We check."                                                                                            | "Don't trust the log. Verify the reality."               |
| A pass                      | **Verified** — "Every required check had supporting evidence."                                                                       | "VERIFIED REALITY"                                       |
| A fail                      | **Failed** — "The evidence contradicts what should have happened."                                                                   | "PHANTOM 200 DETECTED"                                   |
| No reading                  | **Unverified** — "We could not check. Here is what was missing."                                                                     | "Assertion drift", "degraded parity"                     |
| Too early                   | **Pending** — "Still inside the agreed window."                                                                                      | "Awaiting consensus"                                     |
| The problem we address      | "A workflow can report success and still not have created the record or sent the email."                                             | "Silent 200 OK errors across distributed runtimes"       |
| Evidence                    | "What we retrieved" / "What we expected"                                                                                             | "Ground truth" / "Reported state vs verified reality"    |
| Our limits, stated up front | "We only observe. We never change your CRM, send emails for you, or fix your automation."                                            | (absent from the export entirely)                        |
| Independence                | "We fetch the evidence ourselves rather than believing the success callback."                                                        | "Zero-trust certainty"                                   |
| Reliability                 | "Retries on a fixed schedule; a run that cannot be checked is reported as unverified, not as a pass."                                | "99.99% uptime guarantee"                                |
| The record                  | "Run history with the evidence we retrieved, within your retention period."                                                          | "Zero-Trust Payload Ledger"                              |

### 7.3 The one-line test

Before any string ships, read it and ask: **if the engine returned `UNVERIFIED`,
would this sentence still be true?** If not, the sentence is overclaiming. That
test rejects every phrase in §7.1 and passes every phrase in §7.2.

---

## 8. Component specification: the claim/evidence comparator

The best idea in the Stitch export is its side-by-side panel: the automation's own
log on the left, what an independent check found on the right, the same fields in
both columns. It makes the product's entire argument visible before a word of copy
is read. This section specifies it so it can be built without anyone reopening the
generated HTML — which contains none of the constraints below and several
violations of them.

The shipped `ClaimRule` component (`packages/ui/src/components/evidence.ts`,
`.claimrule` in `styles.ts`) is the same idea for **one** field, stacked
vertically. This is its multi-field, two-column sibling. It does not replace
`ClaimRule`; a single assertion should still use the simpler one.

### 8.1 What it is

A comparison of two sources for the same set of fields, where one source is a
claim and the other is evidence, plus a verdict for each row and one for the whole
panel.

It is **not** a diff viewer. A diff viewer's job is to show what changed between
two versions of the same thing. This shows two _different kinds of statement_
about one event — what was asserted, and what was found — and the asymmetry is the
point. The right column can legitimately contain _nothing_, and a diff viewer has
no way to express that.

### 8.2 Structure

```
+-------------------------------------------------------------+
| Enquiry #84920 - acknowledgement email                       |  caption
| Checked 14:22:09 UTC - window closed 14:25:00 UTC            |  mono, --c-faint
+------------------+---------------------+--------------------+
| Field            | Reported by your    | What we retrieved  |  column heads
|                  | workflow            |                    |
+------------------+---------------------+--------------------+
| [tick] CRM id    | 84920               | 84920              |  row: VERIFIED
| [cross] Contact  | a@example.com       | b@example.com      |  row: FAILED
| [dash] Sent at   | 14:22:04 UTC        | no reading         |  row: UNVERIFIED
| [clock] Stage    | qualified           | not checked yet    |  row: PENDING
+------------------+---------------------+--------------------+
| [dash Unverified]  We could not check 1 of 4 items.          |  verdict strip
| Could not reach Resend (auth expired 14:22 UTC).             |  required line
+-------------------------------------------------------------+
```

Three columns, not two: the field name is a shared row header and must not be
repeated inside each side. Repeating it is what forces a reader to match rows by
eye, which is the failure mode of every two-panel log comparison.

### 8.3 Markup and semantics

It is a **table**, not two stacked `div` columns. This is a comparison of values
across two sources — the tabular relationship is real, and a screen reader must be
able to read one row as a unit:

- `table` with a `caption` carrying the run identity.
- `th scope="col"` x 3. Column heads are prose, in sans.
- `th scope="row"` for the field name, so each cell is announced with its field.
- Values in `td`, set in **mono** — they are machine output, per the house rule.
- The row verdict is a `StatusBadge` inside the row header cell, so the status is
  announced _before_ the two values rather than after them.
- The panel verdict is **outside** the table, in a `p` following it, so it is not
  mistaken for a row.

Two column-heading rules, both non-obvious and both load-bearing:

- The left column is **"Reported by your workflow"**, never "Reported state" and
  never "Claimed". It names _who_ made the claim. Our verdict is about the
  customer's automation, and the heading should make that attribution explicit
  rather than leaving the reader to infer whom we are contradicting.
- The right column is **"What we retrieved"**, never "Verified reality", "Ground
  truth", "Actual" or "Truth". We retrieved a value from an API at a moment in
  time. That is a smaller claim than reality and it is the only one we can
  support. See §7.

### 8.4 The four row states

Colour is never the only difference. Every row carries the glyph and the label
from §2, and the right-hand cell's **content** differs in each state.

| State          | Left cell          | Right cell                                             | Row treatment                                                                                                                                                                                                              |
| -------------- | ------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VERIFIED**   | the reported value | the retrieved value, identical                         | Tick glyph. No emphasis on either cell — agreement is the quiet case.                                                                                                                                                      |
| **FAILED**     | the reported value | the retrieved value, **different**                     | Cross glyph. **Both** cells emphasised, not only the right one: the reader needs the pair to understand the contradiction. Never mark only the "wrong" side — we do not know which side is wrong, only that they disagree. |
| **UNVERIFIED** | the reported value | the literal words `no reading`, mono, `--c-unverified` | Dashed-ring glyph and a **dashed cell border** on the right cell. Never an empty cell, never an em dash, never a spinner.                                                                                                  |
| **PENDING**    | the reported value | the literal words `not checked yet`                    | Clock glyph. The only state where the right cell is legitimately unpopulated — and it says so in words.                                                                                                                    |

### 8.5 UNVERIFIED — the case the export cannot express

This is the state the generated design has no vocabulary for, and it is the one
that matters most. Six rules.

1. **An empty cell is forbidden.** An empty right-hand cell reads as either "same
   as the left" or "still loading", and both are wrong. It must contain the words
   `no reading`. This is the table-cell form of the rule already enforced in
   `evidence.ts` — that a null verification percentage renders a headline and
   never a bar, because a missing measurement drawn as 0% or 100% is a lie either
   way.
2. **It is visually distinct from FAILED, not a lighter version of it.** FAILED
   shows two values that disagree. UNVERIFIED shows one value and an absence. The
   dashed cell border echoes the dashed glyph ring: _the check did not close_.
3. **It is visually distinct from VERIFIED in more than hue.** Per the luminance
   measurement in §2, `verified` and `unverified` are 1.01:1 apart in dark mode.
   Hue is carrying nothing here. The glyph, the words `no reading`, and the dashed
   border are the whole signal.
4. **The reason is mandatory and adjacent.** Every UNVERIFIED row carries a reason
   line beneath it, in the field-name column, naming what blocked the check:
   `Could not reach Resend (auth expired 14:22 UTC)`. Not in a tooltip, not behind
   a `details` element, not on another page. A verdict with a hole in it must show
   the shape of the hole.
5. **UNVERIFIED rows sort to the top.** When the panel's own verdict is
   UNVERIFIED, the rows that caused it lead. The reader's first question is always
   "which one?".
6. **A mixed panel is UNVERIFIED, not VERIFIED-with-notes.** If three rows pass
   and one could not be checked, the panel verdict is UNVERIFIED and the strip
   reads `We could not check 1 of 4 items.` Rounding a partial result up to a pass
   is the single thing this product exists not to do, and a summary row is exactly
   where that rounding would happen unnoticed.

### 8.6 The panel verdict strip

Sits below the table. Carries the panel `StatusBadge`, a plain sentence, and — for
UNVERIFIED only — the required follow-up line.

The panel verdict is **derived, never authored**: FAILED if any row failed; else
UNVERIFIED if any row is unverified; else PENDING if any row is pending; else
VERIFIED. FAILED outranks UNVERIFIED because a contradiction found is a stronger
statement than a check not made; UNVERIFIED outranks PENDING because a known gap
outranks a timer still running. **VERIFIED requires every row to be verified.**

This ordering matches the run-level precedence in the frozen contract and must not
be re-derived locally — if the domain layer exposes it, call it.

### 8.7 Responsive behaviour

Below `40rem` the table reflows to stacked groups — but it must stack as
**triplets**, one per field:

```
CRM record id                    [tick] Verified
  Reported by your workflow      84920
  What we retrieved              84920
```

Never as two sequential lists (all reported values, then all retrieved values).
That is the standard failure of a responsive comparison table and it destroys the
only thing the component is for. Each stacked group keeps its row verdict at the
top, so the reader gets the answer before the two values.

The existing `.margin-row` stacking rule (`--w-margin`, stacks at `40rem`) is the
same pattern at the same breakpoint; reuse it rather than inventing a second one.

### 8.8 Constraints inherited from the platform

- **No inline styles.** `style-src-attr 'none'`. Any emphasis, border or width is
  a predefined class. If a future variant needs a proportional width it uses the
  existing round-**down** fill classes, for the reason recorded in
  `apps/app/src/index.ts`.
- **No JavaScript.** No sorting widget, no collapse toggle, no tab switcher
  between "reported" and "retrieved". The comparison _is_ the content; hiding half
  of it behind an interaction defeats it, and the site ships one nine-line script.
- **No animation on the verdict.** The export pulses its status pips
  (`animate-pulse`, `animate-ping`, no reduced-motion guard). A verdict must not
  move.
- **Horizontal overflow is contained.** A long identifier or URL scrolls inside
  its own cell and never widens the page — the `min-width:0` rule that
  CUST-092/093/094 already test for.
- **Tabular numerals.** `font-variant-numeric: tabular-nums` (the `.mono` class
  already sets it) so two values differing in one digit misalign visibly rather
  than invisibly.

### 8.9 What to reject from the export's version

| In the generated HTML                                                                      | Why it does not survive                                                            |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Column heads `Reported State` / `Verified Reality`                                         | §7. We retrieve values; we do not report reality.                                  |
| Amber left-border accent as the only difference marker                                     | Colour-only signal, and it fails 1.4.11 at 2.30:1 anyway (§4, table A).            |
| `TRUTH_VERDICT: SILENT FAILURE DETECTED`                                                   | Not one of the four statuses.                                                      |
| `ROOT_CAUSE: Schema mismatch: 'arr_v2' dropped`                                            | We do not diagnose root causes. We report what we retrieved and what was expected. |
| `Post-Settlement Destination Check (+5.0s)`, `SYNCHRONOUS COMPARATOR`, `SHALLOW TELEMETRY` | Invented jargon for a timer and two columns.                                       |
| The pulsing green verification pip                                                         | §8.8, and it is a colour-only signal besides.                                      |
| Glassmorphism, `backdrop-filter: blur(16px) saturate(180%)`, the emerald back-glow         | Decoration placed behind evidence. The borders carrying it also fail 1.4.11 (§4).  |
