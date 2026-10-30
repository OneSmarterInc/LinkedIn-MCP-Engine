console.log("STEP 1: Node started");

try {
    console.log("STEP 2: Loading better-sqlite3");

    const Database = require("better-sqlite3");

    console.log("STEP 3: Module loaded");

    const db = new Database(":memory:");

    console.log("STEP 4: Database opened");

    console.log(db.prepare("SELECT 1 AS result").get());

    db.close();

    console.log("STEP 5: SQLite working");
} catch (error) {
    console.error("SQLITE ERROR:", error);
}