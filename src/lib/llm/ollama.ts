import { z } from "zod";
import { withRetry, throwForStatus } from "../retry.js";
import { GroundingUnsupportedError, extractJson, type GenerateOptions, type LLMProvider } from "./provider.js";

export interface OllamaOptions {
  url: string;
  model: string;
  timeoutMs?: number;
  /** For thinking models (qwen3, deepseek-r1). false = answer directly. Unset = model default. */
  think?: boolean;
  fetchFn?: typeof fetch;
}

/** Removes <think>...</think> blocks that thinking models may put before the answer. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

type ChatResponse = { message?: { content?: string } };

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  readonly supportsGrounding = false;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: OllamaOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async chat(prompt: string, opts: GenerateOptions, format?: unknown): Promise<string> {
    const messages = [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content: prompt },
    ];
    const res = await this.fetchFn(`${this.opts.url.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.opts.model,
        messages,
        stream: false,
        ...(format ? { format } : {}),
        ...(this.opts.think !== undefined ? { think: this.opts.think } : {}),
        options: { temperature: opts.temperature ?? 0 },
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
    });
    throwForStatus(res, "ollama");
    const data = (await res.json()) as ChatResponse;
    const content = data.message?.content;
    const answer = stripThinking(content ?? "");
    if (!answer) throw new Error("ollama: empty response");
    return answer;
  }

  generateJSON<S extends z.ZodType>(prompt: string, schema: S, opts: GenerateOptions = {}): Promise<z.infer<S>> {
    if (opts.grounded) return Promise.reject(new GroundingUnsupportedError(this.name));
    const jsonSchema = z.toJSONSchema(schema);
    return withRetry(async () => {
      const text = await this.chat(prompt, opts, jsonSchema);
      return schema.parse(extractJson(text));
    }, "ollama.generateJSON", 2);
  }

  generateText(prompt: string, opts: GenerateOptions = {}): Promise<string> {
    if (opts.grounded) return Promise.reject(new GroundingUnsupportedError(this.name));
    return withRetry(() => this.chat(prompt, opts), "ollama.generateText", 2);
  }
}
