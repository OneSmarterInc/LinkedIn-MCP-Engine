import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { extractJson, getLLM, GroundingUnsupportedError } from "../../src/lib/llm/index.js";
import { OllamaProvider, stripThinking } from "../../src/lib/llm/ollama.js";

describe("stripThinking", () => {
  it("removes think blocks", () => expect(stripThinking("<think>a\nb</think>\n{}")).toBe("{}"));
  it("leaves normal text alone", () => expect(stripThinking('{"a":1}')).toBe('{"a":1}'));
});

describe("extractJson", () => {
  it("parses plain JSON", () => expect(extractJson('{"a":1}')).toEqual({ a: 1 }));
  it("strips ```json fences", () => expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 }));
  it("ignores text around the JSON", () => expect(extractJson('Sure! {"a":1} Done.')).toEqual({ a: 1 }));
  it("throws when there is no JSON", () => expect(() => extractJson("no json")).toThrow());
});

describe("getLLM", () => {
  it("defaults to ollama", () => expect(getLLM({}).name).toBe("ollama"));
  it("requires a key for gemini", () => expect(() => getLLM({ LLM_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/));
  it("builds gemini when a key is set", () => expect(getLLM({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "x" }).name).toBe("gemini"));
  it("rejects unknown providers", () => expect(() => getLLM({ LLM_PROVIDER: "foo" })).toThrow(/Unknown/));
});

describe("OllamaProvider", () => {
  const Schema = z.object({ ok: z.boolean() });
  const reply = (content: string) =>
    vi.fn(async () => new Response(JSON.stringify({ message: { content } }), { status: 200 })) as unknown as typeof fetch;

  it("sends the JSON schema as `format` and validates the reply", async () => {
    const fetchFn = reply('{"ok":true}');
    const p = new OllamaProvider({ url: "http://x", model: "m", fetchFn });
    expect(await p.generateJSON("hi", Schema)).toEqual({ ok: true });
    const body = JSON.parse((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
    expect(body.format.properties.ok.type).toBe("boolean");
    expect(body.stream).toBe(false);
  });

  it("strips a <think> block before the JSON", async () => {
    const p = new OllamaProvider({ url: "http://x", model: "m", fetchFn: reply('<think>maybe {x}</think>\n{"ok":false}') });
    expect(await p.generateJSON("hi", Schema)).toEqual({ ok: false });
  });

  it("sends think:false when configured, and omits it otherwise", async () => {
    const on = reply('{"ok":true}');
    await new OllamaProvider({ url: "http://x", model: "m", think: false, fetchFn: on }).generateJSON("hi", Schema);
    expect(JSON.parse((on as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body).think).toBe(false);

    const off = reply('{"ok":true}');
    await new OllamaProvider({ url: "http://x", model: "m", fetchFn: off }).generateJSON("hi", Schema);
    expect("think" in JSON.parse((off as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body)).toBe(false);
  });

  it("shows Ollama's own message and does not retry when memory is short", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: "failed to allocate buffer of size 3121348608" }), { status: 500 })) as unknown as typeof fetch;
    const p = new OllamaProvider({ url: "http://x", model: "big:7b", fetchFn });
    await expect(p.generateJSON("hi", Schema)).rejects.toThrow(/not enough memory to load "big:7b"/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("says which model is missing", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const p = new OllamaProvider({ url: "http://x", model: "nope:1b", fetchFn });
    await expect(p.generateText("hi")).rejects.toThrow(/ollama pull nope:1b/);
  });

  it("refuses grounded calls", async () => {
    const p = new OllamaProvider({ url: "http://x", model: "m", fetchFn: reply("{}") });
    await expect(p.generateText("hi", { grounded: true })).rejects.toBeInstanceOf(GroundingUnsupportedError);
  });
});
