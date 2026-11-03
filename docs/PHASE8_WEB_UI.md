# Phase 8: Web console (HTTP API in this repo + React frontend in its own repo)

The Google Sheet stays the system of record. The console is a second window onto the same tabs: it reads
Jobs_Pipeline, Pipeline, Quarantined, Campaigns and Config, and writes only Status, Subject, DraftBody
(pipeline rows), the Campaigns tab, and the Config tab. AutoBooker (Apps Script) keeps doing the sending
and booking exactly as before.

Two repositories:

```
LinkedIn-MCP-Engine-Backend/    this repo: engine, CLI, MCP server, and the HTTP API (src/api)
LinkedIn-MCP-Engine-Frontend/   React 18 + Vite console; talks to the API only
```

## This repo

```
src/api/server.ts        entry point: loads .env, opens the ledger, serves the built frontend if FRONTEND_DIST exists
src/api/app.ts           routes, auth hook, error handler, 20-30 s read cache
src/api/services/        sheet-rows.ts (read/approve/reject/edit), config-tab.ts (AutoBooker settings), engine.ts (start/poll runs)
tests/unit/backend-api.test.ts   API tests against a fake Sheet
```

```powershell
npm install                 # adds fastify, @fastify/cors, @fastify/static
npm run api                 # http://127.0.0.1:8787
```

`.env` keys: `API_PORT` (8787), `API_HOST` (127.0.0.1; 0.0.0.0 on a server), `API_TOKEN` (empty on a laptop;
on a shared server a long random string, the console asks for it once), `FRONTEND_DIST` (path to the
frontend's `dist` folder when you want one process to serve both; default `../LinkedIn-MCP-Engine-Frontend/dist`).

## Frontend repo

```powershell
npm install
npm run dev                 # http://localhost:5173, proxies /api to 127.0.0.1:8787
npm run build               # writes dist/; set FRONTEND_DIST in the backend .env to serve it from 8787
```

## Pages

| Page | Reads | Writes |
|---|---|---|
| Review queue | Ready for Review + Needs Rewrite rows from both tabs | Status, Subject, DraftBody. Keys: arrows move, E open, A approve, R reject |
| Job posts | Jobs_Pipeline rows with the HIRING signal parsed out of Research; Jobs_Quarantine with reasons in plain words | same |
| Pipeline | every row, both tabs, every status, plus summary and quarantine | same |
| Campaigns | Campaigns tab | create, edit, turn on/off (Active column) |
| Runs | out/job-searches and out/mcp-runs | starts a job search (`POST /api/search`) or a campaign run (`POST /api/runs`), polls every 3 s |
| Automation | Config tab | DryRun (shown as "Live sending"), DailySendCap, work hours, meeting minutes, signature, CAN-SPAM lines |

Approve changes Status to Approved and nothing else; AutoBooker's 15-minute timer sends it and writes
Sent and the thread id back. Status changes are guarded: Approve only from Ready for Review or Needs
Rewrite, Reject from those or Approved, Reopen from Approved, Rejected or Needs Rewrite. A draft can be
edited only while it is Ready for Review or Needs Rewrite. Rows are located by Email, never by row number.

## API

```
GET  /api/health
GET  /api/pipeline?tab=all|Jobs_Pipeline|Pipeline&status=&fresh=1
GET  /api/pipeline/left-out
GET  /api/pipeline/summary
GET  /api/pipeline/:email
POST /api/pipeline/:email/approve | reject | reopen
PATCH /api/pipeline/:email/draft        {subject?, body?}
POST /api/search                        start job search (needs GEMINI_API_KEY, GEMINI_GROUNDING=true, a campaign named JOBS_CAMPAIGN)
GET  /api/search | /api/search/latest | /api/search/:id
POST /api/runs                          {campaign, limit, export}
GET  /api/runs | /api/runs/:id?bodies=1
GET  /api/campaigns | /api/campaigns/:name
POST /api/campaigns                     create
PATCH /api/campaigns/:name              edit
POST /api/campaigns/:name/active        {active}
POST /api/campaigns/validate
GET  /api/settings
PUT  /api/settings                      {DryRun: false, DailySendCap: 25, ...}
```

Errors come back as `{ "error": "plain words" }` with 400 (bad input), 401 (token), 404 (row not found),
409 (status change not allowed), 500 (Sheet or engine failure).

## Security

The Google service-account JSON is read only by this process, from `secrets/` (gitignored). The browser
talks to this API only. When `API_TOKEN` is set every `/api` call needs `Authorization: Bearer <token>`;
`/api/health` stays open so the console can tell whether a token is needed. Never commit `secrets/` or
`.env`; GitHub push protection blocks the push if a key slips in.

## Tests

`npx vitest run tests/unit/backend-api.test.ts` boots the API with an in-memory Sheet and covers auth,
pipeline listing and signal parsing, approve/edit/reject guards, summary, Config tab create and write,
and campaign create/list/activate. `npm run typecheck` covers src/api too.
