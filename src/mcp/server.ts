import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadCampaign } from "../config/load.js";
import { openLedger } from "../core/db.js";
import { buildAsyncGates } from "../core/gates/index.js";
import { draftAll } from "../core/enricher.js";
import { sourceLeads } from "../core/sourcing.js";
import { verifyBatch } from "../core/verifier.js";
import { getLLM } from "../lib/llm/index.js";
import { getSearch } from "../lib/search/index.js";
import { createSheetsGateway } from "../lib/google/sheets.js";
import { createCalendarGateway } from "../lib/google/calendar.js";
import { TAB, PIPELINE_HEADERS, STATUS } from "../core/exporter.js";

import {
  createRunId,
  loadRunState,
  saveRunState
} from "./run-store.js";

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
    description: "Source leads using an existing campaign configuration and create a persistent run.",
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

