import { Mistral } from "@mistralai/mistralai";
import { MODEL, extractText } from "./coach.js";

export interface Enrichment {
  translation: string;
  examples: string[];
}

export function parseEnrichment(raw: string): Enrichment | null {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const translation = typeof parsed.translation === "string" ? parsed.translation.trim().slice(0, 300) : "";
    const examples = Array.isArray(parsed.examples)
      ? parsed.examples
          .filter((e): e is string => typeof e === "string")
          .map((e) => e.trim().slice(0, 300))
          .filter((e) => e.length > 0)
          .slice(0, 5)
      : [];
    if (!translation && examples.length === 0) return null;
    return { translation, examples };
  } catch {
    return null;
  }
}

export async function enrichItem(apiKey: string, kind: string, term: string, definition: string): Promise<Enrichment | null> {
  const client = new Mistral({ apiKey });
  const user = `You are an English teacher for a French-speaking learner at level B2.
The learner wants to learn this ${kind}:
- term: ${term}
- English definition: ${definition}

Reply with ONLY a JSON object, no markdown fences, no extra text:
{"translation": "<concise French translation of the definition>", "examples": ["<natural example sentence 1 using the term>", "<example 2>", "<example 3>"]}`;
  const completion = await client.chat.complete({
    model: MODEL,
    messages: [{ role: "user", content: user }],
    temperature: 0.3,
    maxTokens: 400,
  });
  return parseEnrichment(extractText(completion.choices?.[0]?.message?.content));
}
