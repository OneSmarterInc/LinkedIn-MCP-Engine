import { GeminiProvider } from "./gemini.js";
import { OllamaProvider } from "./ollama.js";
import type { LLMProvider } from "./provider.js";

export type { LLMProvider, GenerateOptions } from "./provider.js";
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
      return new GeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL ?? "gemini-2.5-flash" });
    }
    default:
      throw new Error(`Unknown LLM_PROVIDER "${provider}". Use "ollama" or "gemini".`);
  }
}
