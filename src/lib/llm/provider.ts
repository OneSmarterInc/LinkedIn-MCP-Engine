import type { z } from "zod";

export type ThinkingLevel = "low" | "medium" | "high";

export interface GenerateOptions {
  /** Ask the provider to search the web before answering. */
  grounded?: boolean;
  temperature?: number;
  system?: string;
  /** How much the model may think before answering. Thinking is billed as output, so small checks use "low". */
  thinking?: ThinkingLevel;
}


/**
 * The single contract every LLM backend implements.
 * Core code depends on this interface only, so switching Ollama -> Gemini changes no core code.
 */
export interface LLMProvider {
  readonly name: string;
  readonly supportsGrounding: boolean;
  generateJSON<S extends z.ZodType>(prompt: string, schema: S, opts?: GenerateOptions): Promise<z.infer<S>>;
  generateText(prompt: string, opts?: GenerateOptions): Promise<string>;
}

export class GroundingUnsupportedError extends Error {
  constructor(provider: string) {
    super(`${provider} cannot search the web. Use a provider with grounding, or call without grounded: true.`);
    this.name = "GroundingUnsupportedError";
  }
}

/** Pulls the first JSON object or array out of model text, tolerating ```json fences. */
export function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.search(/[{[]/);
  if (start === -1) throw new Error("No JSON found in model output");
  const open = stripped[start];
  const close = open === "{" ? "}" : "]";
  const end = stripped.lastIndexOf(close);
  if (end <= start) throw new Error("Unterminated JSON in model output");
  return JSON.parse(stripped.slice(start, end + 1));
}
