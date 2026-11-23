import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type ItemKind = "vocabulary" | "phrasal verb" | "expression";

export interface LearnItem {
  id: string;
  kind: ItemKind;
  term: string;
  definition: string;
  example: string;
  translation?: string;
  examples?: string[];
  createdAt: number;
  dueAt: number;
  intervalDays: number;
  reviews: number;
}

export type NewItem = Pick<LearnItem, "kind" | "term" | "definition" | "example"> &
  Partial<Pick<LearnItem, "translation" | "examples">>;

const SCHEDULE_DAYS = [1, 3, 7, 14, 30, 90];
export const DAY_MS = 24 * 60 * 60 * 1000;

const DATA_DIR = join(process.cwd(), "data");
const STORE_FILE = join(DATA_DIR, "learned.json");

function loadAll(): LearnItem[] {
  try {
    if (!existsSync(STORE_FILE)) return [];
    const parsed = JSON.parse(readFileSync(STORE_FILE, "utf8"));
    return Array.isArray(parsed) ? (parsed as LearnItem[]) : [];
  } catch {
    return [];
  }
}

function persist(items: LearnItem[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STORE_FILE, JSON.stringify(items, null, 2), "utf8");
}

export function normalizeKind(raw: string): ItemKind {
  const k = raw.toLowerCase();
  if (k.includes("phrasal")) return "phrasal verb";
  if (k.includes("vocab")) return "vocabulary";
  return "expression";
}

const LEARN_LINE = /^LEARN:[ \t]*(.+)$/gim;

export function parseLearnMarkers(text: string): { clean: string; items: NewItem[] } {
  const items: NewItem[] = [];
  const clean = text
    .replace(LEARN_LINE, (_match, payload: string) => {
      const parts = payload.split("|").map((p) => p.trim());
      if (parts.length < 4) return "";
      const [kind, term, definition, example] = parts;
      if (!term || !definition || !example) return "";
      items.push({ kind: normalizeKind(kind), term, definition, example });
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { clean, items };
}

export function addNewItems(items: NewItem[], now = Date.now()): number {
  if (items.length === 0) return 0;
  const all = loadAll();
  const known = new Set(all.map((i) => i.term.toLowerCase()));
  let added = 0;
  for (const item of items) {
    if (known.has(item.term.toLowerCase())) continue;
    known.add(item.term.toLowerCase());
    all.push({
      id: randomUUID(),
      kind: item.kind,
      term: item.term,
      definition: item.definition,
      example: item.example,
      translation: item.translation,
      examples: item.examples,
      createdAt: now,
      dueAt: now + SCHEDULE_DAYS[0] * DAY_MS,
      intervalDays: SCHEDULE_DAYS[0],
      reviews: 0,
    });
    added += 1;
  }
  if (added > 0) persist(all);
  return added;
}

export function dueItems(now = Date.now()): LearnItem[] {
  return loadAll().filter((i) => i.dueAt <= now);
}

export function rescheduleAll(due: LearnItem[], now = Date.now()): void {
  if (due.length === 0) return;
  const all = loadAll();
  const dueIds = new Set(due.map((i) => i.id));
  for (const item of all) {
    if (!dueIds.has(item.id)) continue;
    item.reviews += 1;
    item.intervalDays = SCHEDULE_DAYS[Math.min(item.reviews, SCHEDULE_DAYS.length - 1)];
    item.dueAt = now + item.intervalDays * DAY_MS;
  }
  persist(all);
}

export function stats(now = Date.now()): { total: number; due: number } {
  const all = loadAll();
  return { total: all.length, due: all.filter((i) => i.dueAt <= now).length };
}

export function listItems(now = Date.now()): Array<LearnItem & { due: boolean }> {
  return loadAll()
    .map((i) => ({ ...i, due: i.dueAt <= now }))
    .sort((a, b) => Number(b.due) - Number(a.due) || a.dueAt - b.dueAt);
}

export function deleteItem(id: string): boolean {
  const all = loadAll();
  const next = all.filter((i) => i.id !== id);
  if (next.length === all.length) return false;
  persist(next);
  return true;
}
