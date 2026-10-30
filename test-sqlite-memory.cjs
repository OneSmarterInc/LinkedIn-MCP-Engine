console.log("Starting SQLite memory test");

const Database = require("better-sqlite3");

console.log("Module loaded");

const db = new Database(":memory:");

console.log("Database opened");

console.log(db.prepare("SELECT sqlite_version() AS version").get());

db.close();

console.log("Test completed");