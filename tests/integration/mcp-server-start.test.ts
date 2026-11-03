import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

/**
 * Starts the real MCP server and asks for its tool list.
 * Catches start-up crashes such as "Tool get_run is already registered" after a merge,
 * which unit tests do not see because they never start the server.
 */
function listTools(): Promise<{ names: string[]; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "src/mcp/server.ts"], {
      env: { ...process.env, LOG_LEVEL: "silent" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); fail(new Error(`server did not answer. stderr:\n${stderr}`)); }, 25_000);
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.stdout.on("data", (d) => {
      out += String(d);
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } };
          if (msg.id === 2 && msg.result?.tools) {
            clearTimeout(timer);
            child.kill();
            done({ names: msg.result.tools.map((t) => t.name), stderr });
          }
        } catch { /* partial line */ }
      }
    });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) { clearTimeout(timer); fail(new Error(`server exited with code ${code}:\n${stderr}`)); }
    });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  });
}

describe("MCP server", () => {
  it("starts, and every tool name is used once", async () => {
    const { names } = await listTools();
    expect(new Set(names).size).toBe(names.length);
    for (const t of ["source_leads", "list_runs", "get_run", "verify_leads", "draft_emails", "export_run", "search_jobs", "get_job_search"]) {
      expect(names).toContain(t);
    }
  }, 30_000);
});
