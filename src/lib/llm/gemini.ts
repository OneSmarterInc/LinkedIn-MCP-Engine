import { ApiError, GoogleGenAI, ThinkingLevel as GenAIThinkingLevel } from "@google/genai";
import { z } from "zod";
import { AbortError, withRetry } from "../retry.js";
import { extractJson, type GenerateOptions, type LLMProvider, type ThinkingLevel } from "./provider.js";

export interface GeminiOptions {
  apiKey: string;
  model: string;
  /** Default thinking level for every call. Unset = model default. Per-call opts override it. */
  thinking?: ThinkingLevel;
  /**
   * Allow Google Search grounding. Gemini 3 models only offer grounding on a billed (paid) project,
   * so set false while on the free tier.
   */
  grounding?: boolean;
  /** Max time for one request. Default 60 s. */
  timeoutMs?: number;
}

/** The part of the SDK client we use; tests pass a fake. */
type GenAIClient = Pick<GoogleGenAI, "models">;

const LEVELS: Record<ThinkingLevel, GenAIThinkingLevel> = {
  low: GenAIThinkingLevel.LOW,
  medium: GenAIThinkingLevel.MEDIUM,
  high: GenAIThinkingLevel.HIGH,
};
/** Gemini 2.x uses a token budget instead of a level. */
const BUDGETS: Record<ThinkingLevel, number> = { low: 512, medium: 2048, high: 8192 };

export function thinkingConfig(model: string, level: ThinkingLevel | undefined) {
  if (!level) return undefined;
  return /^gemini-2\./.test(model) ? { thinkingBudget: BUDGETS[level] } : { thinkingLevel: LEVELS[level] };
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly supportsGrounding: boolean;
  private readonly ai: GenAIClient;

  constructor(private readonly opts: GeminiOptions, client?: GenAIClient) {
    // The SDK retries 429/5xx silently (5 tries, up to 60 s apart). Turn that off:
    // our withRetry does the retrying and logs every attempt, so a slow key is visible.
    this.ai = client ?? new GoogleGenAI({
      apiKey: opts.apiKey,
      httpOptions: { timeout: opts.timeoutMs ?? 60_000, retryOptions: { attempts: 1 } },
    });
    this.supportsGrounding = opts.grounding ?? true;
  }

  private async call(prompt: string, opts: GenerateOptions, jsonSchema?: unknown): Promise<string> {
    // Grounded JSON calls ask for JSON in the prompt and parse the text. This works on every Gemini version.
    const useJsonMode = jsonSchema !== undefined && !opts.grounded;
    const contents = jsonSchema && opts.grounded
      ? `${prompt}\n\nReturn only JSON matching this schema, with no other text:\n${JSON.stringify(jsonSchema)}`
      : prompt;
    const thinking = thinkingConfig(this.opts.model, opts.thinking ?? this.opts.thinking);

    try {
      const res = await this.ai.models.generateContent({
        model: this.opts.model,
        contents,
        config: {
          temperature: opts.temperature ?? 0,
          ...(opts.system ? { systemInstruction: opts.system } : {}),
          ...(opts.grounded ? { tools: [{ googleSearch: {} }] } : {}),
          ...(useJsonMode ? { responseMimeType: "application/json", responseJsonSchema: jsonSchema } : {}),
          ...(thinking ? { thinkingConfig: thinking } : {}),
          httpOptions: { timeout: this.opts.timeoutMs ?? 60_000, retryOptions: { attempts: 1 } },
        },
      });
      const text = res.text;
      if (!text) throw new Error("gemini: empty response");
      return text;
    } catch (err) {
      // 4xx (bad key, unknown model, bad request) will not fix itself: stop instead of retrying.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw new AbortError(`gemini: HTTP ${err.status}: ${summarize(err.message)}`);
      }
      if (err instanceof ApiError && err.status === 429) {
        const msg = summarize(err.message);
        // A per-day or zero quota will not recover in seconds: stop and say so.
        if (/per ?day|limit: ?0|billing/i.test(msg)) {
          throw new AbortError(`gemini: quota exhausted (429). ${msg}`);
        }
        throw new Error(`gemini: rate limited (429), will retry. ${msg}`);
      }
      if ((err as Error).name === "AbortError" || /timed? ?out|timeout/i.test((err as Error).message)) {
        throw new Error(`gemini: no answer within ${(this.opts.timeoutMs ?? 60_000) / 1000} s`);
      }
      throw err;
    }
  }

  generateJSON<S extends z.ZodType>(prompt: string, schema: S, opts: GenerateOptions = {}): Promise<z.infer<S>> {
    const jsonSchema = z.toJSONSchema(schema);
    return withRetry(async () => schema.parse(extractJson(await this.call(prompt, opts, jsonSchema))),
      "gemini.generateJSON", 3);
  }

  generateText(prompt: string, opts: GenerateOptions = {}): Promise<string> {
    return withRetry(() => this.call(prompt, opts), "gemini.generateText", 3);
  }
}

/** Pulls the human message out of Google's JSON error body. */
function summarize(message: string): string {
  try {
    const m = (JSON.parse(message) as { error?: { message?: string } }).error?.message;
    if (m) return m;
  } catch { /* not JSON */ }
  return message.slice(0, 300);
}
