import { z } from "zod";
import { AbortError, withRetry } from "../retry.js";
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

async function readOllamaError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    return String((JSON.parse(text) as { error?: string }).error ?? text).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  readonly supportsGrounding = false;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: OllamaOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async chat(prompt: string, opts: GenerateOptions, format?: unknown): Promise<string> {
    const base = this.opts.url.replace(/\/$/, "");
    const messages = [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content: prompt },
    ];

    let res: Response;
    try {
      res = await this.fetchFn(`${base}/api/chat`, {
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
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (code === "ECONNREFUSED") throw new AbortError(`ollama: cannot reach ${base}. Is Ollama running?`);
      throw err;
    }

    if (res.status === 404) {
      throw new AbortError(`ollama: model "${this.opts.model}" not found. Run: ollama pull ${this.opts.model}`);
    }
    if (!res.ok) {
      const detail = await readOllamaError(res);
      if (/allocate|memory|out of memory/i.test(detail)) {
        throw new AbortError(`ollama: not enough memory to load "${this.opts.model}". Close other apps or use a smaller model. (${detail})`);
      }
      const msg = `ollama: HTTP ${res.status}: ${detail || res.statusText}`;
      // 429 and 5xx may be temporary, so retry. Other 4xx will not fix themselves.
      if (res.status === 429 || res.status >= 500) throw new Error(msg);
      throw new AbortError(msg);
    }

    const data = (await res.json()) as ChatResponse;
    const answer = stripThinking(data.message?.content ?? "");
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
