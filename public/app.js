const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const badge = document.getElementById("badge");
const toast = document.getElementById("toast");

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

refreshStats();
