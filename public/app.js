const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const badge = document.getElementById("badge");
const toast = document.getElementById("toast");
const itemForm = document.getElementById("item-form");
const itemsEl = document.getElementById("items");
const itemsCount = document.getElementById("items-count");
const itemSubmit = document.getElementById("item-submit");
const itemCancel = document.getElementById("item-cancel");
const panel = document.getElementById("panel");

let editingId = null;

function cancelEdit() {
  editingId = null;
  itemForm.reset();
  itemSubmit.textContent = "Ajouter";
  itemCancel.hidden = true;
}

function startEdit(it) {
  editingId = it.id;
  document.getElementById("item-kind").value = it.kind;
  document.getElementById("item-term").value = it.term;
  document.getElementById("item-def").value = it.definition;
  document.getElementById("item-ex").value = it.example;
  itemSubmit.textContent = "Enregistrer";
  itemCancel.hidden = false;
  panel.open = true;
  document.getElementById("item-term").focus();
}

itemCancel.addEventListener("click", cancelEdit);

const history = [];

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function renderText(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\n/g, "<br>");
  return html;
}

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = renderText(text);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

let toastTimer = null;
function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
}

async function refreshStats() {
  try {
    const res = await fetch("/api/stats");
    const s = await res.json();
    badge.textContent = `📚 ${s.total} appris · 🔁 ${s.due} à réviser`;
  } catch { /* ignore */ }
}

async function send(text) {
  if (!text.trim()) return;
  input.value = "";
  addMessage("user", text);
  history.push({ role: "user", content: text });
  const pending = addMessage("assistant", "…");
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Erreur serveur");
    pending.innerHTML = renderText(data.reply);
    history.push({ role: "assistant", content: data.reply });
    if (data.saved > 0) {
      showToast(`📌 ${data.saved} élément(s) ajouté(s) à ta révision espacée`);
    }
    refreshStats();
  } catch (err) {
    pending.innerHTML = `<em>${escapeHtml(err.message)}</em>`;
  }
  log.scrollTop = log.scrollHeight;
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  send(input.value);
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => send(chip.dataset.say));
});

async function loadItems() {
  try {
    const res = await fetch("/api/items");
    const data = await res.json();
    renderItems(data.items || []);
  } catch { /* ignore */ }
}

function renderItems(items) {
  itemsCount.textContent = items.length ? `(${items.length})` : "";
  itemsEl.innerHTML = "";
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "item" + (it.due ? " due" : "");

    const head = document.createElement("div");
    head.className = "item-head";
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = it.kind;
    const term = document.createElement("strong");
    term.textContent = it.term;
    const dueTag = document.createElement("span");
    dueTag.className = "due-tag";
    dueTag.textContent = it.due ? "🔁 à réviser" : "📅 " + new Date(it.dueAt).toLocaleDateString("fr-FR");
    const edit = document.createElement("button");
    edit.className = "del";
    edit.type = "button";
    edit.textContent = "✏️";
    edit.title = "Modifier";
    edit.addEventListener("click", () => startEdit(it));
    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.textContent = "✕";
    del.title = "Supprimer";
    del.addEventListener("click", async () => {
      await fetch("/api/items/" + encodeURIComponent(it.id), { method: "DELETE" });
      loadItems();
      refreshStats();
    });
    head.append(kind, term, dueTag, edit, del);

    const def = document.createElement("div");
    def.className = "item-def";
    def.textContent = it.definition;

    row.append(head, def);

    if (it.translation) {
      const tr = document.createElement("div");
      tr.className = "item-tr";
      tr.textContent = "🇫🇷 " + it.translation;
      row.appendChild(tr);
    }

    const allExamples = [it.example, ...(Array.isArray(it.examples) ? it.examples : [])].filter(Boolean);
    const seen = new Set();
    for (const e of allExamples) {
      if (seen.has(e)) continue;
      seen.add(e);
      const ex = document.createElement("div");
      ex.className = "item-ex";
      ex.textContent = "ex. " + e;
      row.appendChild(ex);
    }
    itemsEl.appendChild(row);
  }
}

itemForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    kind: document.getElementById("item-kind").value,
    term: document.getElementById("item-term").value,
    definition: document.getElementById("item-def").value,
    example: document.getElementById("item-ex").value,
  };
  try {
    const isEdit = editingId !== null;
    const res = await fetch(isEdit ? "/api/items/" + encodeURIComponent(editingId) : "/api/items", {
      method: isEdit ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Erreur serveur");
    showToast(isEdit ? "✅ Modifié" : data.added ? "📌 Ajouté à ta révision espacée" : "ℹ️ Déjà dans tes acquis");
    cancelEdit();
    loadItems();
    refreshStats();
  } catch (err) {
    showToast("❌ " + err.message);
  }
});

refreshStats();
loadItems();
