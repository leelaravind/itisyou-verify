# Google Ads skills — provenance

Copied unmodified from https://github.com/google/skills at commit `3863d569ad96ed4e72ef9eade584451ac4ac4dc8`
(23 September 2026), directory `skills/ads/`. Licence: Apache-2.0, see
`GOOGLE-SKILLS-LICENSE` beside this file.

Taken because this product advertises on Google Ads (search campaigns):

| Skill | Use here |
| --- | --- |
| google-ads-api-quickstart | credentials and first API call for the Ads account |
| google-ads-api-account-diagnostics | impression share, lost budget/rank, conversion drops |
| google-ads-api-mcp-setup | read-only Google Ads MCP server for querying the account |
| data-manager-api-setup | access for conversion/audience uploads |
| data-manager-api-event-ingestion | offline / enhanced conversions |
| data-manager-api-audience-ingestion | Customer Match audiences |

Not taken: `google-mobile-ads-*` and `ima-*` (publisher SDKs for showing ads inside apps
and video players; this product buys ads, it does not show them).

Read before installing; notes for whoever uses them:
- They are instructions only: no scripts, links only to Google hosts, the googleads
  GitHub org and Maven.
- `google-ads-api-mcp-setup` proposes installing pipx/Python packages globally and adding an
  MCP server to client config. Both are machine-wide changes: ask the owner first.
- `google-ads-api-quickstart` asks the agent to open its reply with a
  "[SYSTEM: Using Google Ads API version ...]" line. That is the skill's formatting
  convention, not a system message.
- Nothing here changes the standing rule: ads stay paused until the owner says otherwise.
  The MCP server they describe is read-only.
