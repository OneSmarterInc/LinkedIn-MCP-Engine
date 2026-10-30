import { existsSync, readFileSync } from "node:fs";
import { google, type calendar_v3 } from "googleapis";
import { AbortError, withRetry } from "../retry.js";

const DEFAULT_KEY_PATH = "secrets/google-sa.json";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];
export interface CalendarEnv {
  GOOGLE_SA_JSON_PATH?: string;
  GOOGLE_CALENDAR_ID?: string;
}

export interface BusyPeriod {
  start: string;
  end: string;
}

export interface CreateMeetingInput {
  email: string;
  title: string;
  start: string;
  end: string;
  timeZone: string;
  description?: string;
}

export function createCalendarGateway(
  env: CalendarEnv = process.env
) {
  const keyPath = env.GOOGLE_SA_JSON_PATH?.trim() || DEFAULT_KEY_PATH;
  const calendarId = env.GOOGLE_CALENDAR_ID?.trim();

  if (!calendarId) {
    throw new Error("GOOGLE_CALENDAR_ID is missing from .env.");
  }

  if (!existsSync(keyPath)) {
    throw new Error(`Service account key not found: ${keyPath}`);
  }

  let serviceAccount = "the configured service account";

  try {
    const key = JSON.parse(readFileSync(keyPath, "utf8")) as {
      client_email?: string;
    };

    if (key.client_email) {
      serviceAccount = key.client_email;
    }
  } catch {
    throw new Error("Google service account JSON is invalid.");
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: SCOPES,
  });

  const api = google.calendar({
    version: "v3",
    auth,
  });

  function statusOf(err: unknown): number | undefined {
    const e = err as {
      code?: number | string;
      status?: number;
      response?: { status?: number };
    };

    const status = Number(
      e.response?.status ?? e.status ?? e.code
    );

    return Number.isFinite(status) ? status : undefined;
  }

  function friendlyError(err: unknown, operation: string): Error {
    const status = statusOf(err);

   if (status === 403) {
  const details = err as {
    response?: {
      data?: {
        error?: {
          message?: string;
          errors?: Array<{ reason?: string }>;
        };
      };
    };
    message?: string;
  };

  const apiError = details.response?.data?.error;
  const reason = apiError?.errors?.[0]?.reason ?? "unknown";
  const message =
    apiError?.message ?? details.message ?? "No additional details";

  return new AbortError(
    `Google Calendar API 403 | Reason: ${reason} | Message: ${message}`
  );
}
    if (status === 404) {
      return new AbortError(
        "Calendar not found. Check GOOGLE_CALENDAR_ID."
      );
    }

    if (status === 401) {
      return new AbortError(
        "Google rejected the service account credentials."
      );
    }

    const message =
      err instanceof Error ? err.message : String(err);

    return new Error(`${operation}: ${message}`);
  }

  async function call<T>(
    operation: string,
    fn: () => Promise<T>,
    retryServerErrors = true
  ): Promise<T> {
    return withRetry(async () => {
      try {
        return await fn();
      } catch (err) {
        const mapped = friendlyError(err, operation);

        if (
          !retryServerErrors &&
          statusOf(err) !== 429 &&
          !(mapped instanceof AbortError)
        ) {
          throw new AbortError(mapped.message);
        }

        throw mapped;
      }
    }, operation);
  }

  return {
    async getTimeZone(): Promise<string> {
      const result = await call(
        "reading calendar settings",
        () => api.calendars.get({ calendarId })
      );

      const timeZone = result.data.timeZone;

      if (!timeZone) {
        throw new Error("Google Calendar did not return a timezone.");
      }

      return timeZone;
    },

    async getBusy(
      timeMin: string,
      timeMax: string
    ): Promise<BusyPeriod[]> {
      const result = await call(
        "checking calendar availability",
        () => api.freebusy.query({
          requestBody: {
            timeMin,
            timeMax,
            items: [{ id: calendarId }],
          },
        })
      );

      const busy =
        result.data.calendars?.[calendarId]?.busy ?? [];

      return busy.flatMap((period) => {
        if (!period.start || !period.end) return [];

        return [{
          start: period.start,
          end: period.end,
        }];
      });
    },

    async createMeeting(
      input: CreateMeetingInput
    ) {
      const event: calendar_v3.Schema$Event = {
        summary: input.title,
        description: input.description,
        start: {
          dateTime: input.start,
          timeZone: input.timeZone,
        },
        end: {
          dateTime: input.end,
          timeZone: input.timeZone,
        },
        attendees: [
          { email: input.email },
        ],
      };

      const result = await call(
        "creating calendar meeting",
        () => api.events.insert({
          calendarId,
          requestBody: event,
          sendUpdates: "none",
        }),
        false
      );

      return {
        event_id: result.data.id,
        status: result.data.status,
        html_link: result.data.htmlLink,
        start: result.data.start?.dateTime,
        end: result.data.end?.dateTime,
      };
    },
  };
}

export type CalendarGateway = ReturnType<
  typeof createCalendarGateway
>;
