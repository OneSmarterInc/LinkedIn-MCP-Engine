# Phase 6: Campaigns live in the Sheet

A campaign used to be a JSON file inside the repo. Adding one needed a developer, a commit, and a deploy. Now a campaign is a row in the `Campaigns` tab of the same Google Sheet the team uses to approve emails. A person adds a row, ticks Active, and it runs the next morning. Claude can add the row for them.

JSON files still work. `--campaign campaigns/x.json` reads the file. `--campaign "Ohio TPAs"` reads the row. Both produce the same `CampaignConfig`, so nothing downstream changed.

## The Campaigns tab

| Column | Fill in | Example |
|---|---|---|
| Name | Unique. This is how you refer to it everywhere. | Ohio TPAs |
| Active | Checkbox. Only ticked rows run. | ☑ |
| Mode | CORPORATE writes to people at companies. CANDIDATE writes to job seekers at personal email. | CORPORATE |
| Provider | Where leads come from. Usually gemini_xray. | gemini_xray |
| States | Comma-separated. | Ohio, Indiana, Michigan |
| Titles | Comma-separated. | CFO, VP of Human Resources |
| Keywords | Comma-separated. Narrows the company type. | Third Party Administrator, Healthcare |
| SignalQuery | Optional. A hiring or news signal to search for. | actively hiring Cloud Architect |
| Persona | Optional. Who the email sounds like. | a peer in benefits operations |
| SenderCompany | Required. | One Smarter |
| Offer | Required. One sentence. The only thing the email may offer. | a 15-minute call to compare how claims are reviewed |
| MeetingMinutes | Default 15. | 15 |
| DailyCap | Default 20. | 20 |
| BlockEmployerDomain | Leave blank. Derived from Mode (on for CANDIDATE). | |
| CsvPath | Only for csv_import campaigns. | |
| Status | Written by the engine. OK, or what is wrong in plain words. | OK |
| UpdatedAt | Written by the engine and by the Sheet when a person edits. | |

The tab is created with dropdowns and checkboxes by either `setup()` in Apps Script or the first `campaign list` from the CLI.

## Three ways to add a campaign

**1. Type a row.** Open the tab, fill the cells, run `campaign validate` (or the `validate_campaigns` tool). Status says OK or what to fix. Tick Active.

**2. Ask Claude.** With the MCP server connected to Claude Desktop:

> Make a campaign called "KY Manufacturing CFOs". CFOs and VPs of Finance at manufacturing companies in Kentucky. Offer a 15-minute call about reviewing payment files before money goes out. From One Smarter.

Claude calls `create_campaign`. A row appears, paused, Status OK. "Activate it" calls `set_campaign_active`.

**3. Import the JSON files.** One time, to seed the tab:

```powershell
npx tsx src/main.ts campaign import campaigns/b2b_healthcare.json campaigns/hiring_orgs.json campaigns/talent_sourcing.json
```

## Commands

```powershell
npx tsx src/main.ts campaign list                     # every row, active flag, status
npx tsx src/main.ts campaign validate                 # re-check all rows, write Status cells
npx tsx src/main.ts campaign show "Ohio TPAs"         # the row as the engine sees it
npx tsx src/main.ts campaign activate "Ohio TPAs"
npx tsx src/main.ts campaign pause "Ohio TPAs"
npx tsx src/main.ts run --campaign "Ohio TPAs" --limit 10 --export sheet   # one campaign, by name
npx tsx src/main.ts run-active --limit 50             # every active row, exported to the Sheet
```

On Windows PowerShell, call `npx tsx src/main.ts` directly. `npm run dev --` drops the flags.

## MCP tools added

| Tool | Does |
|---|---|
| `list_campaigns` | Rows with name, mode, active, status |
| `get_campaign` | One campaign as the engine will run it |
| `create_campaign` | Add or replace a row. Starts paused unless `active: true`. |
| `set_campaign_active` | Turn on or off. Refuses to turn on an invalid row and says why. |
| `validate_campaigns` | Re-check every row, write Status cells |

`source_leads` now accepts a campaign Name as well as a path.

## The morning run

One schedule, one command: `run-active`. It reads active rows, runs each one through source → 5 gates → draft → export to the Pipeline tab, honoring each row's DailyCap. A failure in one campaign is logged and the next one still runs.

Windows Task Scheduler, daily at 8:00:

```
Program:   powershell.exe
Arguments: -NoProfile -Command "cd D:\MCP; npx tsx src/main.ts run-active >> out\run-active.log 2>&1"
```

Linux cron:

```
0 8 * * 1-5  cd /srv/mcp && npx tsx src/main.ts run-active >> out/run-active.log 2>&1
```

## What a user experiences

```
"Reach CFOs in Kentucky about claims review"        (one sentence to Claude)
        │  Claude asks what is missing, calls create_campaign
        ▼
Campaigns tab: new row, Status OK, Active ☐
        │  user ticks Active, or says "activate it"
        ▼
Next morning: run-active sources, verifies, drafts
        ▼
Pipeline tab: drafts waiting            →  human approves  →  AutoBooker sends and books
```

## Rules that stayed in code

What emails are blocked, how a draft is shaped, what a valid campaign is. Users change what a campaign targets. They do not change how the engine behaves.

## Files

- `src/config/store.ts` — row ↔ config, file store, Sheet store, plain-words validation
- `src/config/load.ts` — `loadCampaign(ref)` picks file or Sheet by the reference
- `src/main.ts` — `campaign …` commands and `run-active`
- `src/mcp/server.ts` — five campaign tools
- `apps_script/AutoBooker.gs` — `ensureCampaignsTab()` (dropdowns, checkboxes, example row) and `onEdit` stamp
- `tests/unit/campaign-store.test.ts` — 15 tests
