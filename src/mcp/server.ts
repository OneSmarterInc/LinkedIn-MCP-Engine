import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadCampaign } from "../config/load.js";
import { CampaignConfig, Mode, SourcingProvider } from "../config/schema.js";
import { sheetCampaignStore } from "../config/store.js";
import { openLedger } from "../core/db.js";
import { buildAsyncGates } from "../core/gates/index.js";
import { draftAll } from "../core/enricher.js";
import { sourceLeads } from "../core/sourcing.js";
import { verifyBatch } from "../core/verifier.js";
import { getLLM } from "../lib/llm/index.js";
import { getSearch } from "../lib/search/index.js";
import { createSheetsGateway } from "../lib/google/sheets.js";
import { createCalendarGateway } from "../lib/google/calendar.js";
import { TAB, PIPELINE_HEADERS, STATUS, exportToSheet, recordExported } from "../core/exporter.js";
import type { RunReport } from "../core/pipeline.js";

import {
  createRunId,
  loadRunState,
  saveRunState
} from "./run-store.js";
import { listRunIds, viewRun } from "./run-view.js";
import { JOB_SEARCH_DEFAULTS, saveJobSearch, searchJobs } from "../core/jobs/job-search.js";
import { GeminiProvider } from "../lib/llm/gemini.js";
import { geminiOptions } from "../lib/llm/index.js";

const server = new McpServer({
  name: "linkedin-mcp-engine",
  version: "1.0.0"
});

const ledger = openLedger();

function success(data: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(data, null, 2)
    }]
  };
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: error instanceof Error ? error.message : String(error)
    }]
  };
}

// TOOL 1: SOURCE LEADS
server.registerTool(
  "source_leads",
  {
    description: "Source leads for a campaign and create a persistent run. campaign_path is a JSON path, or the Name of a row in the Campaigns tab.",
    inputSchema: {
      campaign_path: z.string().min(1),
      csv_path: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).optional()
    }
  },
  async ({ campaign_path, csv_path, limit }) => {
    try {
      const cfg = await loadCampaign(campaign_path);
      const effectiveCsv = csv_path ??
        (cfg.sourcing_provider === "csv_import" ? cfg.csv_path : undefined);

      const llm = getLLM(process.env);

      const source = await sourceLeads(
        cfg,
        {
          limit: limit ?? 50,
          csvPath: csv_path
        },
        {
          ...(!effectiveCsv && cfg.sourcing_provider === "gemini_xray"
            ? { search: getSearch(process.env, llm) }
            : {})
        }
      );

      const runId = createRunId();
      const now = new Date().toISOString();

      await saveRunState({
        run_id: runId,
        status: "SOURCED",
        campaign_path,
        config: cfg,
        source,
        created_at: now,
        updated_at: now
      });

      return success({
        run_id: runId,
        status: "SOURCED",
        provider: source.provider,
        leads_found: source.leads.length,
        skipped: source.skipped.length
      });
    } catch (error) {
      return failure(error);
    }
  }
);

// TOOL 2: VERIFY LEADS
server.registerTool(
  "verify_leads",
  {
    description: "Run sourced leads through all five existing verification gates.",
    inputSchema: {
      run_id: z.string().min(1)
    }
  },
  async ({ run_id }) => {
    try {
      const state = await loadRunState(run_id);

      if (state.status !== "SOURCED") {
        throw new Error(`Verification requires SOURCED status. Current status: ${state.status}`);
      }

      const gates = buildAsyncGates(state.config);

      const verification = await verifyBatch(
        state.source.leads,
        state.config,
        ledger,
        gates
      );

      state.verification = verification;
      state.status = "VERIFIED";
      state.updated_at = new Date().toISOString();

      await saveRunState(state);

      return success({
        run_id,
        status: state.status,
        passed: verification.passed.length,
        quarantined: verification.quarantined.length,
        quarantined_by_reason: verification.quarantined.reduce(
          (result, item) => {
            const reason = item.result.failure_reason ?? "UNKNOWN";
            result[reason] = (result[reason] ?? 0) + 1;
            return result;
          },
          {} as Record<string, number>
        )
      });
    } catch (error) {
      return failure(error);
    }
  }
);

// TOOL 2b: SEE A RUN
server.registerTool(
  "get_run",
  {
    description:
      "Show the leads in a run: name, title, company, location, LinkedIn, email, where the email came from, " +
      "and whether each lead PASSED or which gate it FAILED and why. Shows draft subjects once drafted. " +
      "Leave run_id empty to list the newest runs.",
    inputSchema: {
      run_id: z.string().min(1).optional(),
      include_email_bodies: z.boolean().optional()
    }
  },
  async ({ run_id, include_email_bodies }) => {
    try {
      if (!run_id) {
        const ids = await listRunIds(10);
        const runs = [];
        for (const id of ids) {
          try {
            const v = viewRun(await loadRunState(id));
            runs.push({ run_id: v.run_id, status: v.status, campaign: v.campaign, updated_at: v.updated_at, counts: v.counts });
          } catch {
            runs.push({ run_id: id, status: "UNREADABLE" });
          }
        }
        return success({ runs });
      }
      return success(viewRun(await loadRunState(run_id), { includeBodies: include_email_bodies ?? false }));
    } catch (error) {
      return failure(error);
    }
  }
);

// TOOL: RECENT JOB POSTS
server.registerTool(
  "search_jobs",
  {
    description:
      `Find recent job posts on LinkedIn (any role, any company, posted in the last ${JOB_SEARCH_DEFAULTS.daysBack} days). ` +
      "Returns title, company, location, an unconfirmed posted date, a short description, the link, and a contact email. " +
      "Emails come only from Seamless: the poster, or a recruiter/HR person at the company " +
      `(at most ${JOB_SEARCH_DEFAULTS.maxSeamlessLookups} lookups, 1 to 2 credits each). Takes no input.`,
    inputSchema: {}
  },
  async () => {
    try {
      const key = process.env.GEMINI_API_KEY?.trim();
      if (!key) throw new Error("search_jobs needs GEMINI_API_KEY in .env.");
      const llm = new GeminiProvider(geminiOptions(process.env, key));
      if (!llm.supportsGrounding) {
        throw new Error("search_jobs needs Google Search in Gemini: turn on billing and set GEMINI_GROUNDING=true.");
      }
      const seamlessKey = process.env.SEAMLESS_API_KEY?.trim();
      const result = await searchJobs({ llm, ...(seamlessKey ? { seamless: { apiKey: seamlessKey } } : {}) });
      const saved_to = await saveJobSearch(result);
      return success({ ...result, saved_to });
    } catch (error) {
      return failure(error);
    }
  }
);

// TOOL 3: DRAFT EMAILS
server.registerTool(
  "draft_emails",
  {
    description: "Generate email drafts only for leads that passed all five verification gates.",
    inputSchema: {
      run_id: z.string().min(1),
      concurrency: z.number().int().min(1).max(10).optional()
    }
  },
  async ({ run_id, concurrency }) => {
    try {
      const state = await loadRunState(run_id);

      if (state.status !== "VERIFIED" || !state.verification) {
        throw new Error("Leads must pass verification before email drafting.");
      }

      const drafts = await draftAll(
        state.verification.passed,
        state.config,
        getLLM(process.env),
        { concurrency: concurrency ?? 3 }
      );

      state.drafts = drafts;
      state.status = "DRAFTED";
      state.updated_at = new Date().toISOString();

      await saveRunState(state);

      return success({
        run_id,
        status: state.status,
        total_drafts: drafts.length,
        ready: drafts.filter(d => d.draft_status === "READY").length,
        needs_rewrite: drafts.filter(d => d.draft_status === "NEEDS_REWRITE").length,
        errors: drafts.filter(d => d.draft_status === "DRAFT_ERROR").length,
        drafts
      });
    } catch (error) {
      return failure(error);
    }
  }
);

// TOOL 3b: EXPORT RUN TO THE SHEET
server.registerTool(
  "export_run",
  {
    description:
      "Send a drafted run to the Google Sheet: drafts go to the Pipeline tab as 'Ready for Review', failed leads to the Quarantined tab. " +
      "Exported emails are recorded in the ledger so a later run will not contact them again. Call after draft_emails.",
    inputSchema: {
      run_id: z.string().min(1)
    }
  },
  async ({ run_id }) => {
    try {
      const state = await loadRunState(run_id);

      if (state.status === "EXPORTED") {
        return success({ run_id, status: state.status, message: `Run was already exported at ${state.exported_at}. Nothing added.` });
      }
      if (state.status !== "DRAFTED" || !state.drafts || !state.verification) {
        throw new Error("Run must be drafted before export. Call draft_emails first.");
      }

      const tally = <T,>(items: T[], key: (t: T) => string) =>
        items.reduce<Record<string, number>>((acc, i) => { acc[key(i)] = (acc[key(i)] ?? 0) + 1; return acc; }, {});

      const report: RunReport = {
        run_id,
        campaign: state.config.campaign_name,
        mode: state.config.mode,
        provider: state.source.provider,
        started_at: state.created_at,
        finished_at: new Date().toISOString(),
        counts: {
          rows_read: state.source.leads.length + state.source.skipped.length,
          skipped: state.source.skipped.length,
          sourced: state.source.leads.length,
          passed: state.verification.passed.length,
          quarantined: state.verification.quarantined.length
        },
        quarantined_by_reason: tally(state.verification.quarantined, (q) => q.result.failure_reason ?? "UNKNOWN"),
        skipped_by_reason: tally(state.source.skipped, (r) => r.reason),
        passed: state.verification.passed,
        quarantined: state.verification.quarantined,
        skipped: state.source.skipped,
        drafts: state.drafts,
        drafts_by_status: tally(state.drafts, (d) => d.draft_status)
      };

      const res = await exportToSheet(report, createSheetsGateway());
      const recorded = recordExported(report, res.exported, ledger);

      state.status = "EXPORTED";
      state.exported_at = new Date().toISOString();
      state.updated_at = state.exported_at;
      await saveRunState(state);

      return success({
        run_id,
        status: state.status,
        pipeline_added: res.pipeline_added,
        pipeline_already_present: res.pipeline_already_present,
        quarantined_added: res.quarantined_added,
        ledger_recorded: recorded,
        message: `${res.pipeline_added} draft(s) are in the Pipeline tab as "${STATUS.ready}". ${res.quarantined_added} lead(s) in Quarantined.`
      });
    } catch (error) {
      return failure(error);
    }
  }
);

// TOOL 4: GET PIPELINE
server.registerTool(
  "get_pipeline",
  {
    description: "Read lead records from the existing Google Sheets Pipeline tab.",
    inputSchema: {
      status: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional()
    }
  },
  async ({ status, limit }) => {
    try {
      const gw = createSheetsGateway();
      const rows = await gw.getValues(`${TAB.pipeline}!A1:J`);

      if (rows.length === 0) {
        return success({ total: 0, records: [] });
      }

      const headers = rows[0]!.map(h => h.trim());
      if (headers.join("|") !== PIPELINE_HEADERS.join("|")) {
        throw new Error("Pipeline headers do not match the expected Phase 4 layout.");
      }

      const records = rows.slice(1)
        .map((row, index) => {
          const record: Record<string, string | number> = {
            row_number: index + 2
          };

          headers.forEach((header, column) => {
            record[header] = row[column] ?? "";
          });

          return record;
        })
        .filter(record => String(record.Email ?? "").trim() !== "")
        .filter(record => !status || record.Status === status)
        .slice(0, limit ?? 100);

      return success({
        total: records.length,
        records
      });
    } catch (error) {
      return failure(error);
    }
  }
);

// TOOL 5: APPROVE LEAD
server.registerTool(
  "approve_lead",
  {
    description: "Human approval: change a matching Ready for Review lead to Approved. Does not send email.",
    inputSchema: {
      email: z.string().email(),
      confirm: z.literal(true)
    }
  },
  async ({ email }) => {
    try {
      const gw = createSheetsGateway();
      const rows = await gw.getValues(`${TAB.pipeline}!A1:J`);

      if (rows.length === 0) {
        throw new Error("Pipeline tab is empty.");
      }

      const headers = rows[0]!.map(h => h.trim());
      if (headers.join("|") !== PIPELINE_HEADERS.join("|")) {
        throw new Error("Pipeline headers do not match the expected Phase 4 layout.");
      }

      const emailColumn = headers.indexOf("Email");
      const statusColumn = headers.indexOf("Status");

      const matches = rows.slice(1)
        .map((row, index) => ({
          row_number: index + 2,
          email: (row[emailColumn] ?? "").trim(),
          status: (row[statusColumn] ?? "").trim()
        }))
        .filter(row => row.email.toLowerCase() === email.trim().toLowerCase());

      if (matches.length === 0) {
        throw new Error(`No Pipeline lead found for ${email}.`);
      }

      if (matches.length > 1) {
        throw new Error(`Multiple Pipeline rows match ${email}. Approval cancelled.`);
      }

      const match = matches[0]!;

      if (match.status === STATUS.approved) {
        return success({
          email: match.email,
          status: STATUS.approved,
          message: "Lead is already approved."
        });
      }

      if (match.status !== STATUS.ready) {
        throw new Error(
          `Approval denied. Current status is "${match.status}". Only "${STATUS.ready}" leads can be approved.`
        );
      }

      const statusColumnLetter = String.fromCharCode(65 + statusColumn);

      await gw.writeValues(
        `${TAB.pipeline}!${statusColumnLetter}${match.row_number}`,
        [[STATUS.approved]],
        "raw"
      );

      return success({
        email: match.email,
        row_number: match.row_number,
        previous_status: match.status,
        status: STATUS.approved,
        email_sent: false
      });
    } catch (error) {
      return failure(error);
    }
  }
);

// CALENDAR HELPERS
function getZonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const value = (type: string) =>
    Number(parts.find(part => part.type === type)?.value);

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second")
  };
}

function zonedDateTimeToDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  for (let i = 0; i < 3; i++) {
    const parts = formatter.formatToParts(new Date(guess));
    const value = (type: string) =>
      Number(parts.find(part => part.type === type)?.value);

    const represented = Date.UTC(
      value("year"),
      value("month") - 1,
      value("day"),
      value("hour"),
      value("minute"),
      value("second")
    );

    guess += target - represented;
  }

  return new Date(guess);
}

// TOOL 6: GET FREE SLOTS
server.registerTool(
  "get_free_slots",
  {
    description: "Find available meeting slots in Google Calendar. Uses the calendar's timezone and working hours.",
    inputSchema: {
      days_ahead: z.number().int().min(1).max(30).optional(),
      slot_minutes: z.number().int().min(15).max(120).optional(),
      start_hour: z.number().int().min(0).max(23).optional(),
      end_hour: z.number().int().min(1).max(24).optional(),
      max_slots: z.number().int().min(1).max(100).optional()
    }
  },
  async ({
    days_ahead,
    slot_minutes,
    start_hour,
    end_hour,
    max_slots
  }) => {
    try {
      const calendar = createCalendarGateway();
      const timeZone = await calendar.getTimeZone();

      const days = days_ahead ?? 7;
      const duration = slot_minutes ?? 30;
      const fromHour = start_hour ?? 9;
      const toHour = end_hour ?? 17;
      const limit = max_slots ?? 50;

      if (fromHour >= toHour) {
        throw new Error("start_hour must be earlier than end_hour.");
      }

      const now = new Date();
      const today = getZonedParts(now, timeZone);

      const finalDay = new Date(Date.UTC(
        today.year,
        today.month - 1,
        today.day + days - 1
      ));

      const rangeEnd = zonedDateTimeToDate(
        finalDay.getUTCFullYear(),
        finalDay.getUTCMonth() + 1,
        finalDay.getUTCDate(),
        toHour,
        0,
        timeZone
      );

      const busy = await calendar.getBusy(
        now.toISOString(),
        rangeEnd.toISOString()
      );

      const slots: Array<{
        start: string;
        end: string;
      }> = [];

      for (let offset = 0; offset < days; offset++) {
        const day = new Date(Date.UTC(
          today.year,
          today.month - 1,
          today.day + offset
        ));

        const year = day.getUTCFullYear();
        const month = day.getUTCMonth() + 1;
        const date = day.getUTCDate();

        for (
          let minutes = fromHour * 60;
          minutes + duration <= toHour * 60;
          minutes += duration
        ) {
          const hour = Math.floor(minutes / 60);
          const minute = minutes % 60;

          const start = zonedDateTimeToDate(
            year, month, date, hour, minute, timeZone
          );

          const end = new Date(start.getTime() + duration * 60_000);

          if (start <= now) continue;

          const conflicts = busy.some(period =>
            start < new Date(period.end) &&
            end > new Date(period.start)
          );

          if (!conflicts) {
            slots.push({
              start: start.toISOString(),
              end: end.toISOString()
            });

            if (slots.length >= limit) break;
          }
        }

        if (slots.length >= limit) break;
      }

      return success({
        timezone: timeZone,
        days_checked: days,
        slot_minutes: duration,
        available_slots: slots.length,
        slots
      });
    } catch (error) {
      return failure(error);
    }
  }
);

// TOOL 7: BOOK MEETING
server.registerTool(
  "book_meeting",
  {
    description: "Book a Google Calendar event after checking conflicts. Requires explicit confirmation. Does not send email invitations.",
    inputSchema: {
      campaign_path: z.string().min(1),
      email: z.string().email(),
      start_time: z.string().datetime({ offset: true }),
      title: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      confirm: z.literal(true)
    }
  },
  async ({
    campaign_path,
    email,
    start_time,
    title,
    description
  }) => {
    try {
      const cfg = await loadCampaign(campaign_path);
      const calendar = createCalendarGateway();

      const timeZone = await calendar.getTimeZone();
      const start = new Date(start_time);

      if (start.getTime() <= Date.now()) {
        throw new Error("Cannot book a meeting in the past.");
      }

      const end = new Date(
        start.getTime() + cfg.calendar_duration_minutes * 60_000
      );

      const busy = await calendar.getBusy(
        start.toISOString(),
        end.toISOString()
      );

      const conflict = busy.some(period =>
        start < new Date(period.end) &&
        end > new Date(period.start)
      );

      if (conflict) {
        throw new Error(
          "Booking rejected: this time slot conflicts with an existing calendar event."
        );
      }

      const meeting = await calendar.createMeeting({
        email,
        title,
        start: start.toISOString(),
        end: end.toISOString(),
        timeZone,
        description
      });

      return success({
        booked: true,
        email,
        duration_minutes: cfg.calendar_duration_minutes,
        timezone: timeZone,
        email_sent: false,
        meeting
      });
    } catch (error) {
      return failure(error);
    }
  }
);

// ---------------------------------------------------------------------------
// CAMPAIGN TOOLS: the Campaigns tab in the Sheet is where production campaigns live.
// A person (or Claude on their behalf) adds a row; no file, no deploy.
// ---------------------------------------------------------------------------

const campaignStore = () => sheetCampaignStore(createSheetsGateway());

// TOOL 8: LIST CAMPAIGNS
server.registerTool(
  "list_campaigns",
  {
    description: "List every campaign in the Sheet's Campaigns tab with its mode, whether it is active, and whether it is valid.",
    inputSchema: {}
  },
  async () => {
    try {
      return success({ campaigns: await campaignStore().list() });
    } catch (error) {
      return failure(error);
    }
  }
);

// TOOL 9: GET CAMPAIGN
server.registerTool(
  "get_campaign",
  {
    description: "Show one campaign exactly as the engine will use it. Pass the Name from the Campaigns tab.",
    inputSchema: { name: z.string().min(1) }
  },
  async ({ name }) => {
    try {
      return success(await campaignStore().get(name));
    } catch (error) {
      return failure(error);
    }
  }
);

// TOOL 10: CREATE OR UPDATE CAMPAIGN
server.registerTool(
  "create_campaign",
  {
    description:
      "Create a campaign as a new row in the Campaigns tab, or replace the row with the same name. " +
      "Ask the user for anything missing before calling: who (titles), where (states), what kind of company (keywords), " +
      "the one-sentence offer, and the sender company. New campaigns start paused unless active=true. " +
      "Mode CORPORATE writes to people at companies; CANDIDATE writes to job seekers at their personal email.",
    inputSchema: {
      name: z.string().min(1),
      mode: Mode,
      titles: z.array(z.string().min(1)).min(1),
      states: z.array(z.string().min(1)).min(1),
      keywords: z.array(z.string()).default([]),
      offer: z.string().min(10).describe("One plain sentence. The only thing the email may offer."),
      sender_company: z.string().min(1),
      persona: z.string().optional(),
      signal_query: z.string().optional(),
      provider: SourcingProvider.default("gemini_xray"),
      meeting_minutes: z.number().int().positive().default(15),
      daily_cap: z.number().int().positive().default(20),
      active: z.boolean().default(false)
    }
  },
  async (a) => {
    try {
      const cfg = CampaignConfig.parse({
        campaign_name: a.name,
        mode: a.mode,
        sourcing_provider: a.provider,
        target_geography: a.states,
        decision_maker_titles: a.titles,
        industry_keywords: a.keywords,
        offer: a.offer,
        sender_company: a.sender_company,
        ...(a.persona ? { outreach_persona: a.persona } : {}),
        ...(a.signal_query ? { signal_query: a.signal_query } : {}),
        calendar_duration_minutes: a.meeting_minutes,
        daily_send_cap: a.daily_cap,
        block_current_employer_domain: a.mode === "CANDIDATE"
      });
      const saved = await campaignStore().save(cfg, { active: a.active });
      return success({
        ...saved,
        message: saved.active
          ? `"${saved.name}" is saved and active. It runs on the next run-active.`
          : `"${saved.name}" is saved and paused. Call set_campaign_active to turn it on.`
      });
    } catch (error) {
      return failure(error);
    }
  }
);

// TOOL 11: ACTIVATE / PAUSE
server.registerTool(
  "set_campaign_active",
  {
    description: "Turn a campaign on or off. An invalid campaign cannot be turned on; the error says what to fix.",
    inputSchema: { name: z.string().min(1), active: z.boolean() }
  },
  async ({ name, active }) => {
    try {
      await campaignStore().setActive(name, active);
      return success({ name, active, message: `"${name}" is now ${active ? "active" : "paused"}.` });
    } catch (error) {
      return failure(error);
    }
  }
);

// TOOL 12: VALIDATE ALL
server.registerTool(
  "validate_campaigns",
  {
    description: "Re-check every row in the Campaigns tab and write OK or the problem into its Status cell. Use after someone edits the tab by hand.",
    inputSchema: {}
  },
  async () => {
    try {
      const rows = await campaignStore().validateAll();
      return success({ checked: rows.length, problems: rows.filter((r) => r.status !== "OK"), all: rows });
    } catch (error) {
      return failure(error);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error("MCP server startup failed:", error);
  ledger.close();
  process.exit(1);
});

process.on("SIGINT", () => {
  ledger.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  ledger.close();
  process.exit(0);
});

