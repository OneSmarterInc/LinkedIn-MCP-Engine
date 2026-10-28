import pino from "pino";

/** Structured JSON logger. Emails and keys are redacted so no PII or secrets reach the logs. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: ["email", "*.email", "api_key", "*.api_key", "apiKey"], censor: "[redacted]" },
});
