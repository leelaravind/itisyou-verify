# Stitch export capability — verified, not assumed

Checked in the live Stitch UI on 19 September 2026, project
`12603262649263949929` ("ITISYOU Verify Landing Page").

## What was actually tested

1. Opened the **Export** panel with nothing selected. It refused to offer any
   format: _"No screens selected — Select screens on the canvas to see export
   options."_ So export is **selection-driven**, not project-wide.
2. The same panel carries a quick tip: **Select all — Ctrl+A**.
3. Pressed Ctrl+A on the canvas. **Both** screens present at the time were
   selected simultaneously, and the prompt bar showed both as chips
   ("ITISYOU Verify Logo", "ITISYOU Verify - Gr…").
4. With a multi-screen selection live, the Export panel offered nine formats:

   | Format            | State         |
   | ----------------- | ------------- |
   | AI Studio         | preview       |
   | Figma             | available     |
   | MCP               | available     |
   | Netlify           | preview       |
   | Lovable           | preview       |
   | Bolt              | preview       |
   | **.zip**          | **available** |
   | Code to clipboard | available     |
   | Project brief     | available     |

5. Selected `.zip`. The Export button became enabled.

## Conclusion

**Batch export across a multi-screen selection is genuinely supported**, and
`.zip` is a first-class format rather than a per-screen download. The AI Studio
variant of the panel states plainly that it "may take a minute or two to export
many screens", which is further evidence the pipeline is built for multi-screen
jobs.

## What this does NOT prove

It does not prove a 16-screen selection exports in one operation. Two screens
selected is not sixteen. The real export will be attempted at full scale once
all 16 screens exist; if it fails or truncates, the fallback is supported
batches assembled locally, and the failure will be reported rather than papered
over.

There is **no Stitch MCP server** configured in this session — Stitch offers
`MCP` as an export _target_, which is a different thing. All of this work is
browser-driven.
