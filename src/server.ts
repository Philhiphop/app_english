import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Mistral } from "@mistralai/mistralai";
import { MODEL, buildSystemPrompt } from "./coach.js";
import { addNewItems, dueItems, parseLearnMarkers, rescheduleAll, stats } from "./memory.js";

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

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
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
  if (req.method === "GET") {
    void handleStatic(req, res, url);
    return;
  }
  sendJson(res, 405, { error: "Méthode non autorisée" });
});

server.listen(PORT, () => {
  console.log(`Coach d'anglais démarré sur http://localhost:${PORT}`);
});
