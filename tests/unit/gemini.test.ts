import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ApiError } from "@google/genai";
import { GeminiProvider, thinkingConfig } from "../../src/lib/llm/gemini.js";
import { geminiOptions, getLLM, DEFAULT_GEMINI_MODEL } from "../../src/lib/llm/index.js";
import { getSearch } from "../../src/lib/search/index.js";

function fakeClient(text: string) {
  const generateContent = vi.fn(async (_req: unknown) => ({ text }));
  return { client: { models: { generateContent } } as never, generateContent };
}
type Req = { contents: string; config: Record<string, unknown> };
const Schema = z.object({ ok: z.boolean() });

describe("GeminiProvider", () => {
  it("uses JSON mode with the schema when not grounded", async () => {
    const { client, generateContent } = fakeClient('{"ok":true}');
    const p = new GeminiProvider({ apiKey: "k", model: "gemini-3.8-flash" }, client);
    expect(await p.generateJSON("hi", Schema)).toEqual({ ok: true });
    const cfg = (generateContent.mock.calls[0]![0] as Req).config;
    expect(cfg.responseMimeType).toBe("application/json");
    expect(cfg.tools).toBeUndefined();
  });

  it("uses Google Search and puts the schema in the prompt when grounded", async () => {
    const { client, generateContent } = fakeClient('Here: {"ok":false}');
    const p = new GeminiProvider({ apiKey: "k", model: "gemini-3.8-flash" }, client);
    expect(await p.generateJSON("hi", Schema, { grounded: true })).toEqual({ ok: false });
    const req = generateContent.mock.calls[0]![0] as Req;
    expect(req.config.tools).toEqual([{ googleSearch: {} }]);
    expect(req.config.responseMimeType).toBeUndefined();
    expect(req.contents).toContain("Return only JSON");
  });

  it("sends a thinking level on Gemini 3 (per call beats default)", async () => {
    const { client, generateContent } = fakeClient('{"ok":true}');
    const p = new GeminiProvider({ apiKey: "k", model: "gemini-3.8-flash", thinking: "high" }, client);
    await p.generateJSON("a", Schema);
    await p.generateJSON("b", Schema, { thinking: "low" });
    const levels = generateContent.mock.calls.map((c) => ((c[0] as Req).config.thinkingConfig as { thinkingLevel?: string }).thinkingLevel);
    expect(levels).toEqual(["HIGH", "LOW"]);
  });

  it("maps thinking to a token budget on Gemini 2.x", () => {
    expect(thinkingConfig("gemini-2.5-flash", "low")).toEqual({ thinkingBudget: 512 });
    expect(thinkingConfig("gemini-3.8-flash", "low")).toEqual({ thinkingLevel: "LOW" });
    expect(thinkingConfig("gemini-3.8-flash", undefined)).toBeUndefined();
  });

  it("does not retry a 404 (unknown model) and shows Google's message", async () => {
    const body = JSON.stringify({ error: { code: 404, message: "This model models/old is no longer available." } });
    const generateContent = vi.fn(async () => { throw new ApiError({ message: body, status: 404 }); });
    const p = new GeminiProvider({ apiKey: "k", model: "old" }, { models: { generateContent } } as never);
    await expect(p.generateText("hi")).rejects.toThrow("gemini: HTTP 404: This model models/old is no longer available.");
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("retries a 503", async () => {
    let n = 0;
    const generateContent = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new ApiError({ message: "busy", status: 503 });
      return { text: "ok" };
    });
    const p = new GeminiProvider({ apiKey: "k", model: "m" }, { models: { generateContent } } as never);
    expect(await p.generateText("hi")).toBe("ok");
    expect(generateContent).toHaveBeenCalledTimes(2);
  });
});

describe("Gemini settings", () => {
  it("defaults to gemini-3.8-flash with grounding on", () => {
    expect(geminiOptions({}, "k")).toMatchObject({ model: DEFAULT_GEMINI_MODEL, grounding: true });
    expect(DEFAULT_GEMINI_MODEL).toBe("gemini-3.8-flash");
  });

  it("GEMINI_GROUNDING=false turns off web search (free tier)", () => {
    const llm = getLLM({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "k", GEMINI_GROUNDING: "false" });
    expect(llm.supportsGrounding).toBe(false);
  });

  it("live LinkedIn search explains how to turn grounding on", () => {
    expect(() => getSearch({ SEARCH_PROVIDER: "gemini", GEMINI_API_KEY: "k", GEMINI_GROUNDING: "false" }))
      .toThrow(/GEMINI_GROUNDING=true/);
  });

  it("rejects a bad GEMINI_THINKING value", () => {
    expect(() => geminiOptions({ GEMINI_THINKING: "max" }, "k")).toThrow(/GEMINI_THINKING/);
  });
});
