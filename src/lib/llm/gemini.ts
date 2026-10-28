import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { withRetry } from "../retry.js";
import { extractJson, type GenerateOptions, type LLMProvider } from "./provider.js";

export interface GeminiOptions {
  apiKey: string;
  model: string;
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly supportsGrounding = true;
  private readonly ai: GoogleGenAI;

  constructor(private readonly opts: GeminiOptions) {
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey });
  }

  private async call(prompt: string, opts: GenerateOptions, jsonSchema?: unknown): Promise<string> {
    // Gemini 2.5 cannot combine Google Search grounding with JSON mode,
    // so grounded JSON calls ask for JSON in the prompt and parse the text.
    const useJsonMode = jsonSchema !== undefined && !opts.grounded;
    const contents = jsonSchema && opts.grounded
      ? `${prompt}\n\nReturn only JSON matching this schema, with no other text:\n${JSON.stringify(jsonSchema)}`
      : prompt;

    const res = await this.ai.models.generateContent({
      model: this.opts.model,
      contents,
      config: {
        temperature: opts.temperature ?? 0,
        ...(opts.system ? { systemInstruction: opts.system } : {}),
        ...(opts.grounded ? { tools: [{ googleSearch: {} }] } : {}),
        ...(useJsonMode ? { responseMimeType: "application/json", responseJsonSchema: jsonSchema } : {}),
      },
    });
    const text = res.text;
    if (!text) throw new Error("gemini: empty response");
    return text;
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
