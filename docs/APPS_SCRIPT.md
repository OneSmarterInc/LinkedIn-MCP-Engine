# AutoBooker: the Apps Script, how it is organised and how to deploy it

The sender and booker runs inside the Google Sheet as an Apps Script project. Its source lives in this repo under
`apps_script/`, split into files by job. Apps Script loads the files of a project in name order, so the files are
numbered; every file can call every function, and all shared constants sit in the first file.

| File | What is in it |
|---|---|
| `00_Config.gs` | Tab names, column numbers, statuses, Config keys and defaults, US state time zones |
| `10_Setup.gs` | `setup()`, triggers, the Config, Campaigns and SendLog tabs, `onEdit` |
| `20_Send.gs` | `sendApproved()`: the 15-minute send cycle, daily cap, signature |
| `30_Replies.gs` | `processReplies()`: the 10-minute reply cycle, bounces, opt-outs, reply classification |
| `40_Time.gs` | Parsing "Tuesday at 2pm", time-zone conversion, weekday, the lead's zone |
| `50_Calendar.gs` | Booking inside office hours, free slots, offering times |
| `60_Sheet.gs` | Reading rows, writing by email (never by stale row number), the Notes log, the script lock |
| `90_Tests.gs` | `runTests()`: run from the editor before going live |
| `appsscript.json` | Manifest: time zone, scopes, V8 runtime |

The unit tests in `tests/unit/autobooker.test.ts` join the files in the same order and run them in Node against fakes
of Gmail, Calendar and Sheets. `npm test` covers them.

## Getting the code into the Sheet

### Option A: clasp (recommended; git stays the source of truth)

One-time:

```powershell
npm install -g @google/clasp
clasp login                                   # opens a browser; use the Google account that owns the Sheet
# in the Sheet: Extensions > Apps Script > Project Settings > copy the Script ID
cd D:\linkdinMCP\LinkedIn-MCP-Engine-Backend\apps_script
copy .clasp.json.example .clasp.json          # paste the Script ID into it
```

Every time the script changes:

```powershell
cd D:\linkdinMCP\LinkedIn-MCP-Engine-Backend
npm run gs:push                               # bundles for reference, then clasp push uploads apps_script/*.gs
```

`clasp push` replaces the project's files with the eight files here, so delete the old single `Code.gs` in the editor
the first time (clasp warns if files would be removed; answer yes). `.clasp.json` is git-ignored because the Script ID
is per Sheet.

### Option B: paste by hand

```powershell
npm run gs:bundle                             # writes apps_script\dist\AutoBooker.gs (one file, same code)
```

Open the Sheet → Extensions → Apps Script → select all in the editor → paste the content of
`apps_script\dist\AutoBooker.gs` → Save. One file is fine for Apps Script; the split only matters for reading and
editing in the repo.

### After either option

`setup()` needs to run only once per Sheet (it creates tabs and the two triggers). After a code update nothing else
is required; the next trigger run uses the new code. To check: Run → `runTests`, then View → Executions.

## Editing rules

- Add a function to the file whose title matches its job; add a shared constant to `00_Config.gs`.
- Keep `COL`, `STATUS` and `STATE` in sync with `src/core/exporter.ts` and `src/api/services/sheet-rows.ts`.
- Run `npm test` before pushing; the test file is the specification for the reply classifier and the booking rules.
