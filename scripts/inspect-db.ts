import { openLedger } from "../src/core/db.ts";

const db = openLedger();
try {
  const tables = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table'"
  ).all();

  console.log(JSON.stringify(tables, null, 2));
} finally {
  db.close();
}
