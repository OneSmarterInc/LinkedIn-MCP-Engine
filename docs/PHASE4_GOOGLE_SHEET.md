# Phase 4: Google Sheet export

`npm run dev -- run ... --export sheet` sends the run to a Google Sheet. Nothing is ever sent as email from here.

## One-time setup
1. Put the service account key at `secrets/google-sa.json` (gitignored).
2. In `.env`: `GOOGLE_SA_JSON_PATH=secrets/google-sa.json` and `GOOGLE_SHEET_ID=<id from the Sheet URL>`.
3. Open the Sheet, click Share, add the service account's `client_email` (inside the key file) as **Editor**.
4. In Google Cloud, make sure the **Google Sheets API** is enabled for the service account's project.

## Commands
```powershell
npm run dev -- run --campaign campaigns/b2b_healthcare.json --csv tests/fixtures/dirty_leads.csv --export sheet
```
`--export` accepts `none` (default), `sheet`, `xlsx` (local Excel file in `out/`), or `both`.

## What the Sheet gets
| Tab | Content |
|---|---|
| Pipeline | One row per drafted lead. Columns: Company, Domain, Name, Title, Email, Research, Status, Subject, DraftBody, ThreadID. Status is a dropdown, starting at `Ready for Review`. A draft that failed the writer's rules is added as `Needs Rewrite`. |
| Quarantined | Leads that failed a gate, with FailedGate and FailureReason. Leads whose draft errored appear here with `DRAFT_ERROR`. |
| Summary | Live `COUNTIF` formulas over the other two tabs. |

Status values: Ready for Review, Needs Rewrite, Approved, Rejected, Sent, Replied, Meeting Booked, Opted Out.

## Behaviour to know
- Each run **appends**. Existing rows and any Status a person already set are never changed.
- A lead whose email is already in the Pipeline tab is skipped, so exporting twice does not duplicate rows.
- Lead and draft text is written as plain text, so nothing a lead or the AI wrote can run as a formula.
- If the Pipeline or Quarantined tab already has a different header row, the export stops and writes nothing.
- Exported leads are recorded in the ledger (`EXPORTED`), so a later run quarantines them as `ALREADY_CONTACTED`. This is why export is opt-in: running without `--export` leaves the ledger untouched.
- If the Sheet export fails, an Excel copy is written to `out/` and the ledger is **not** updated, so you can fix the problem and run again.
