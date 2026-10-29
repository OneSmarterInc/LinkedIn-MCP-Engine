import { GeminiProvider } from "./gemini.js";
import { OllamaProvider } from "./ollama.js";
import type { LLMProvider, ThinkingLevel } from "./provider.js";

export type { LLMProvider, GenerateOptions, ThinkingLevel } from "./provider.js";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

/** Reads GEMINI_* settings from the environment. Shared by the LLM and the search provider. */
export function geminiOptions(env: NodeJS.ProcessEnv, apiKey: string) {
  const level = (env.GEMINI_THINKING ?? "").toLowerCase();
  if (level && !["low", "medium", "high"].includes(level)) {
    throw new Error(`GEMINI_THINKING must be low, medium, high, or empty (got "${level}")`);
  }
  return {
    apiKey,
    model: env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    ...(level ? { thinking: level as ThinkingLevel } : {}),
    grounding: (env.GEMINI_GROUNDING ?? "true").toLowerCase() !== "false",
  };
}
export { GroundingUnsupportedError, extractJson } from "./provider.js";

/** Picks the LLM backend from LLM_PROVIDER. This is the only place that knows which one is live. */
export function getLLM(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const provider = (env.LLM_PROVIDER ?? "ollama").toLowerCase();
  switch (provider) {
    case "ollama":
      return new OllamaProvider({
        url: env.OLLAMA_URL ?? "http://localhost:11434",
        model: env.OLLAMA_MODEL ?? "qwen2.5:7b",
        timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 60_000),
        ...(env.OLLAMA_THINK !== undefined && env.OLLAMA_THINK !== ""
          ? { think: env.OLLAMA_THINK.toLowerCase() === "true" }
          : {}),
      });
    case "gemini": {
      if (!env.GEMINI_API_KEY) throw new Error("LLM_PROVIDER=gemini but GEMINI_API_KEY is empty");
      return new GeminiProvider(geminiOptions(env, env.GEMINI_API_KEY));
    }
    default:
      throw new Error(`Unknown LLM_PROVIDER "${provider}". Use "ollama" or "gemini".`);
  }
}
