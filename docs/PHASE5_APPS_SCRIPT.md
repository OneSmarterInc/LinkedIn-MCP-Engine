# Phase 5: Sender and booker (`apps_script/*.gs`, see docs/APPS_SCRIPT.md)

The script lives inside the Google Sheet. Keep this repo copy and the Sheet copy identical.

## Install
1. Open the Sheet, then **Extensions > Apps Script**. Replace the code with the bundle from `npm run gs:bundle` (`apps_script/dist/AutoBooker.gs`), or push with clasp (docs/APPS_SCRIPT.md).
2. Fill in the four `CHANGE ME` values in `CONFIG` (name, title, company, postal address). The script refuses to send until you do.
3. **Project Settings > Script Properties**: add `GEMINI_API_KEY`. Check the **time zone** in Project Settings too, because business hours and proposed times use it.
4. Run `setupTriggers` once (creates two 10-minute triggers). Approve the permissions prompt.
5. Run `sendTestToMe` once and read the email it sends you. That is exactly what prospects will see.

## Test before any real prospect
Add a Pipeline row with your own second email address, a test subject and body, and Status `Approved`.
- It should become `Sending`, then `Sent`, with a ThreadID. The email should show your signature, postal address and the STOP line.
- Reply "Thursday 3pm works" from that address. The row should become `Replied` with a note showing the proposed time.
- Reply "STOP" in a new test. The row should become `Opted Out`.

## Settings you may change
| Setting | Default | Meaning |
|---|---|---|
| `MAX_SENDS_PER_DAY` / `MAX_SENDS_PER_RUN` | 20 / 10 | Hard send limits |
| `AUTO_BOOK` | false | true: create the calendar event and invite the prospect |
| `AUTO_REPLY` | false | true: also email "invite sent" (only after a real booking) |
| `MEETING_MINUTES` | 15 | Matches `calendar_duration_minutes` in the campaign file |
| `BUSINESS_START_HOUR` / `BUSINESS_END_HOUR` | 9 / 17 | Times outside this are flagged, not booked |

## Statuses it writes
`Sending` (just before the send), `Sent`, `Send Error`, `Rejected` (duplicate or already contacted), `Replied`, `Meeting Booked`, `Opted Out`, `Bounced`. Notes on the Status cell explain what happened.

## Limits to know
- Google caps how many emails Apps Script can send per day, and the cap is lower on free Gmail accounts. Check Google's quotas page.
- Opt-outs live in the Sheet. They are not yet copied into the engine's local ledger (`data/ledger.db`).
- The reply reader only looks at the Gmail thread of the sent email. A prospect who answers from a different address, or in a new thread, is not seen.
