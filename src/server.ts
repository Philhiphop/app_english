import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Mistral } from "@mistralai/mistralai";
import { MODEL, buildSystemPrompt, extractText } from "./coach.js";
import { enrichItem } from "./enrich.js";
import { addNewItems, deleteItem, dueItems, listItems, normalizeKind, parseLearnMarkers, rescheduleAll, stats, updateItem, type ItemKind, type NewItem } from "./memory.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");
const PORT = Number(process.env.PORT ?? 3000);
const MAX_BODY_BYTES = 256 * 1024;
const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 4000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Payload trop grand"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function sanitizeMessages(input: unknown): ChatMessage[] | null {
  if (!Array.isArray(input)) return null;
  const cleaned: ChatMessage[] = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (typeof m !== "object" || m === null) continue;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    const text = String(content ?? "").slice(0, MAX_MESSAGE_CHARS).trim();
    if (text) cleaned.push({ role, content: text });
  }
  return cleaned.length > 0 ? cleaned : null;
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "Corps de requête JSON invalide." });
    return;
  }

  const messages = sanitizeMessages((payload as { messages?: unknown })?.messages);
  if (!messages) {
    sendJson(res, 400, { error: "Le champ 'messages' doit être un tableau non vide de { role, content }." });
    return;
  }

  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    sendJson(res, 500, {
      error: "MISTRAL_API_KEY n'est pas définie côté serveur. Copie .env.example en .env et renseigne ta clé Mistral.",
    });
    return;
  }

  const now = Date.now();
  const due = dueItems(now);
  rescheduleAll(due, now);
  const systemPrompt = buildSystemPrompt(due);

  const client = new Mistral({ apiKey });
  const completion = await client.chat.complete({
    model: MODEL,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    temperature: 0.7,
    maxTokens: 1024,
  });

  const raw = extractText(completion.choices?.[0]?.message?.content);
  const { clean, items } = parseLearnMarkers(raw);
  const saved = addNewItems(items, now);

  sendJson(res, 200, { reply: clean, saved, reviewed: due.length, stats: stats(now) });
}

const KIND_PATTERN = /phrasal|vocab|expression|idiom/i;

function parseItemPayload(payload: unknown): NewItem | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  const rawKind = String(p.kind ?? "");
  const term = String(p.term ?? "").trim().slice(0, 120);
  const definition = String(p.definition ?? "").trim().slice(0, 500);
  const example = String(p.example ?? "").trim().slice(0, 500);
  if (!KIND_PATTERN.test(rawKind) || !term || !definition || !example) return null;
  return { kind: normalizeKind(rawKind), term, definition, example };
}

async function enrichIfNeeded(
  existing: { term: string; definition: string; translation?: string; examples?: string[] } | null,
  next: NewItem,
): Promise<{ translation?: string; examples?: string[] }> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) return { translation: existing?.translation, examples: existing?.examples };
  const changed = !existing || existing.term.toLowerCase() !== next.term.toLowerCase() || existing.definition !== next.definition;
  if (!changed) return { translation: existing?.translation, examples: existing?.examples };
  try {
    const enrichment = await enrichItem(apiKey, next.kind, next.term, next.definition);
    if (enrichment) {
      return {
        translation: enrichment.translation || undefined,
        examples: enrichment.examples.length > 0 ? enrichment.examples : undefined,
      };
    }
  } catch {
    // Enrichissement facultatif : on conserve l'ancien contenu si l'appel échoue.
  }
  return { translation: existing?.translation, examples: existing?.examples };
}

async function handleAddItem(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "Corps de requête JSON invalide." });
    return;
  }
  const parsed = parseItemPayload(payload);
  if (!parsed) {
    sendJson(res, 400, {
      error: "Champs requis : kind (vocabulary | phrasal verb | expression), term, definition, example (tous non vides).",
    });
    return;
  }
  const { translation, examples } = await enrichIfNeeded(null, parsed);
  const added = addNewItems([{ ...parsed, translation, examples }]);
  const item = listItems().find((i) => i.term.toLowerCase() === parsed.term.toLowerCase());
  sendJson(res, added > 0 ? 201 : 200, { added: added > 0, item, stats: stats() });
}

async function handleUpdateItem(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "Corps de requête JSON invalide." });
    return;
  }
  const parsed = parseItemPayload(payload);
  if (!parsed) {
    sendJson(res, 400, {
      error: "Champs requis : kind (vocabulary | phrasal verb | expression), term, definition, example (tous non vides).",
    });
    return;
  }
  const existing = listItems().find((i) => i.id === id);
  if (!existing) {
    sendJson(res, 404, { error: "Élément introuvable." });
    return;
  }
  const { translation, examples } = await enrichIfNeeded(existing, parsed);
  const item = updateItem(id, { ...parsed, translation, examples });
  sendJson(res, 200, { item, stats: stats() });
}

async function handleStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = normalize(join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + sep)) {
    sendJson(res, 403, { error: "Interdit" });
    return;
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Introuvable" });
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "POST" && url.pathname === "/api/chat") {
    handleChat(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Erreur interne";
      sendJson(res, 500, { error: message });
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/stats") {
    sendJson(res, 200, stats());
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/items") {
    handleAddItem(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Erreur interne";
      sendJson(res, 500, { error: message });
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/items") {
    sendJson(res, 200, { items: listItems() });
    return;
  }
  if (url.pathname.startsWith("/api/items/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/items/".length));
    if (req.method === "DELETE") {
      const deleted = id.length > 0 && deleteItem(id);
      sendJson(res, deleted ? 200 : 404, { deleted });
      return;
    }
    if (req.method === "PUT" || req.method === "PATCH") {
      if (!id) {
        sendJson(res, 400, { error: "ID manquant." });
        return;
      }
      handleUpdateItem(req, res, id).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Erreur interne";
        sendJson(res, 500, { error: message });
      });
      return;
    }
  }
  if (req.method === "GET") {
    void handleStatic(req, res, url);
    return;
  }
  sendJson(res, 405, { error: "Méthode non autorisée" });
});

server.listen(PORT, () => {
  console.log(`Coach d'anglais démarré sur http://localhost:${PORT}`);
});
