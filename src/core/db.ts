
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Ledger {
  isContacted(email: string): boolean;
  isSuppressed(email: string): boolean;
  recordContact(c: {
    email: string;
    lead_id: string;
    full_name: string;
    campaign: string;
    status: string;
  }): void;
  suppress(email: string, reason: string): void;
  close(): void;
}

export function openLedger(
  path = process.env.LEDGER_PATH ?? "data/ledger.db"
): Ledger {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);

  db.exec("PRAGMA journal_mode = WAL;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS global_contacts_ledger (
      email TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      full_name TEXT NOT NULL,
      campaign TEXT NOT NULL,
      status TEXT NOT NULL,
      first_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suppression_list (
      email TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      added_at TEXT NOT NULL
    );
  `);

  const contacted = db.prepare(
    "SELECT 1 FROM global_contacts_ledger WHERE email = ?"
  );

  const suppressed = db.prepare(
    "SELECT 1 FROM suppression_list WHERE email = ?"
  );

  const insertContact = db.prepare(`
    INSERT OR IGNORE INTO global_contacts_ledger
    (email, lead_id, full_name, campaign, status, first_seen_at)
    VALUES (@email, @lead_id, @full_name, @campaign, @status, @first_seen_at)
  `);

  const insertSuppress = db.prepare(`
    INSERT OR REPLACE INTO suppression_list
    (email, reason, added_at)
    VALUES (?, ?, ?)
  `);

  return {
    isContacted: (email) =>
      contacted.get(email.toLowerCase()) !== undefined,

    isSuppressed: (email) =>
      suppressed.get(email.toLowerCase()) !== undefined,

    recordContact: (c) => {
      insertContact.run({
        ...c,
        email: c.email.toLowerCase(),
        first_seen_at: new Date().toISOString(),
      });
    },

    suppress: (email, reason) => {
      insertSuppress.run(
        email.toLowerCase(),
        reason,
        new Date().toISOString()
      );
    },

    close: () => db.close(),
  };
}
