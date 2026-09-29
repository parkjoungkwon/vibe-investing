const state = {
  me: null,
  channels: [],
  joinable: [],
  current: null,
  threadId: null,
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, { credentials: "same-origin", ...options, headers });
  if (res.status === 401) {
    showLogin();
    throw new Error("로그인이 필요합니다.");
  }
  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  const data = isJson ? await res.json() : await res.blob();
  if (!res.ok) {
    throw new Error(data.error || "요청이 거절되었습니다.");
  }
  return data;
}

function showLogin() {
  $("login").hidden = false;
  $("app").hidden = true;
}

function showApp() {
  $("login").hidden = true;
  $("app").hidden = false;
}

function openModal(title, html) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = html;
  $("modal").hidden = false;
}

$("modal-close").onclick = () => {
  $("modal").hidden = true;
};

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  const data = new FormData(form);
  $("login-error").hidden = true;
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: data.get("email"),
        displayName: data.get("displayName"),
      }),
    });
    await boot();
  } catch (err) {
    $("login-error").hidden = false;
    $("login-error").textContent = err.message;
  }
});

$("logout").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" });
  showLogin();
};

function renderLists() {
  const groups = { public: [], private: [], dm: [] };
  for (const ch of state.channels) {
    groups[ch.type].push(ch);
  }
  const paint = (id, items, prefix) => {
    $(id).innerHTML = items
      .map(
        (ch) =>
          `<li><button type="button" data-id="${ch.id}" class="${state.current === ch.id ? "active" : ""}">${prefix}${escapeHtml(ch.name)}</button></li>`,
      )
      .join("");
    $(id).querySelectorAll("button").forEach((btn) => {
      btn.onclick = () => openChannel(Number(btn.dataset.id));
    });
  };
  paint("public-list", groups.public, "# ");
  paint("private-list", groups.private, "잠긴 ");
  paint("dm-list", groups.dm, "");
  $("joinable-section").hidden = state.joinable.length === 0;
  $("joinable-list").innerHTML = state.joinable
    .map((ch) => `<li><button type="button" data-id="${ch.id}">들어가기 · ${escapeHtml(ch.name)}</button></li>`)
    .join("");
  $("joinable-list").querySelectorAll("button").forEach((btn) => {
    btn.onclick = async () => {
      await api(`/api/channels/${btn.dataset.id}/join`, { method: "POST" });
      await refreshChannels();
      openChannel(Number(btn.dataset.id));
    };
  });
}

async function refreshChannels() {
  const data = await api("/api/channels");
  state.channels = data.channels;
  state.joinable = data.joinable;
  renderLists();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderMessage(msg) {
  const files = (msg.attachments || [])
    .map(
      (file) =>
        `<div class="file"><a href="/api/files/${file.id}" target="_blank" rel="noreferrer">${escapeHtml(file.original_name)}</a></div>`,
    )
    .join("");
  const reactions = (msg.reactions || [])
    .map(
      (r) =>
        `<button type="button" data-react="${escapeHtml(r.emoji)}" data-id="${msg.id}">${escapeHtml(r.emoji)} ${r.count}</button>`,
    )
    .join("");
  return `<article class="msg" data-id="${msg.id}">
    <header><strong>${escapeHtml(msg.author_name)}</strong><span>${escapeHtml(msg.created_at)}</span></header>
    <div class="body">${escapeHtml(msg.body)}</div>
    ${files}
    <div class="actions">
      ${reactions}
      <button type="button" data-react="👍" data-id="${msg.id}">👍</button>
      <button type="button" data-react="👀" data-id="${msg.id}">👀</button>
      ${msg.parent_id ? "" : `<button type="button" data-thread="${msg.id}">이어진 대화 ${msg.reply_count || ""}</button>`}
    </div>
  </article>`;
}

function bindMessageActions(root, channelId) {
  root.querySelectorAll("[data-react]").forEach((btn) => {
    btn.onclick = async () => {
      await api(`/api/messages/${btn.dataset.id}/reactions`, {
        method: "POST",
        body: JSON.stringify({ emoji: btn.dataset.react }),
      });
      await loadMessages(channelId);
      if (state.threadId) await loadThread(channelId, state.threadId);
    };
  });
  root.querySelectorAll("[data-thread]").forEach((btn) => {
    btn.onclick = () => openThread(channelId, Number(btn.dataset.thread));
  });
}

async function loadMessages(channelId) {
  const data = await api(`/api/channels/${channelId}/messages`);
  $("messages").innerHTML = data.messages.map(renderMessage).join("");
  bindMessageActions($("messages"), channelId);
  $("messages").scrollTop = $("messages").scrollHeight;
}

async function loadThread(channelId, parentId) {
  const data = await api(`/api/channels/${channelId}/messages?parentId=${parentId}`);
  $("thread-messages").innerHTML = data.messages.map(renderMessage).join("");
  bindMessageActions($("thread-messages"), channelId);
}

async function openChannel(id) {
  state.current = id;
  state.threadId = null;
  $("thread").hidden = true;
  const ch = state.channels.find((c) => c.id === id);
  $("channel-title").textContent = ch ? ch.name : "채널";
  $("channel-meta").textContent = ch ? `${labelFor(ch.type)} · 기록은 남습니다` : "";
  $("composer").hidden = false;
  $("invite").hidden = !ch || ch.type === "dm";
  renderLists();
  await loadMessages(id);
}

function labelFor(type) {
  if (type === "public") return "공개 채널";
  if (type === "private") return "비공개 채널";
  if (type === "dm") return "쪽지";
  return type;
}

async function openThread(channelId, parentId) {
  state.threadId = parentId;
  $("thread").hidden = false;
  await loadThread(channelId, parentId);
}

$("close-thread").onclick = () => {
  state.threadId = null;
  $("thread").hidden = true;
};

$("composer").onsubmit = async (event) => {
  event.preventDefault();
  if (!state.current) return;
  const file = $("file").files[0];
  if (file) {
    const body = new FormData();
    body.append("file", file);
    body.append("body", $("body").value || file.name);
    await fetch(`/api/channels/${state.current}/files`, { method: "POST", body, credentials: "same-origin" });
    $("file").value = "";
  } else {
    await api(`/api/channels/${state.current}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: $("body").value }),
    });
  }
  $("body").value = "";
  await loadMessages(state.current);
};

$("thread-composer").onsubmit = async (event) => {
  event.preventDefault();
  if (!state.current || !state.threadId) return;
  await api(`/api/channels/${state.current}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: $("thread-body").value, parentId: state.threadId }),
  });
  $("thread-body").value = "";
  await loadThread(state.current, state.threadId);
  await loadMessages(state.current);
};

$("new-public").onclick = async () => {
  const name = prompt("공개 채널 이름");
  if (!name) return;
  const data = await api("/api/channels", {
    method: "POST",
    body: JSON.stringify({ name, type: "public" }),
  });
  await refreshChannels();
  openChannel(data.channel.id);
};

$("new-private").onclick = async () => {
  const name = prompt("비공개 채널 이름");
  if (!name) return;
  const data = await api("/api/channels", {
    method: "POST",
    body: JSON.stringify({ name, type: "private" }),
  });
  await refreshChannels();
  openChannel(data.channel.id);
};

$("new-dm").onclick = async () => {
  const users = (await api("/api/users")).users.filter((u) => u.id !== state.me.id);
  const html = users
    .map((u) => `<p><button type="button" data-user="${u.id}">${escapeHtml(u.display_name)} (${escapeHtml(u.email)})</button></p>`)
    .join("");
  openModal("쪽지 상대", html || "<p>다른 직원이 아직 없습니다.</p>");
  $("modal-body").querySelectorAll("button").forEach((btn) => {
    btn.onclick = async () => {
      const data = await api("/api/dms", {
        method: "POST",
        body: JSON.stringify({ userId: Number(btn.dataset.user) }),
      });
      $("modal").hidden = true;
      await refreshChannels();
      openChannel(data.channel.id);
    };
  });
};

$("invite").onclick = async () => {
  if (!state.current) return;
  const users = (await api("/api/users")).users.filter((u) => u.id !== state.me.id);
  const html = users
    .map((u) => `<p><button type="button" data-user="${u.id}">초대 · ${escapeHtml(u.display_name)}</button></p>`)
    .join("");
  openModal("멤버 초대", html);
  $("modal-body").querySelectorAll("button").forEach((btn) => {
    btn.onclick = async () => {
      await api(`/api/channels/${state.current}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: Number(btn.dataset.user) }),
      });
      $("modal").hidden = true;
    };
  });
};

let searchTimer;
$("search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
};

async function runSearch() {
  const q = $("search").value.trim();
  if (!q) return;
  const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
  const html = data.results
    .map(
      (msg) =>
        `<article class="msg search-hit" data-channel="${msg.channel_id}"><header><strong>${escapeHtml(msg.author_name)}</strong></header><div class="body">${escapeHtml(msg.body)}</div></article>`,
    )
    .join("");
  openModal(`찾기 · ${data.results.length}건 (내 채널만)`, html || "<p>볼 수 있는 결과가 없습니다.</p>");
  $("modal-body").querySelectorAll(".search-hit").forEach((el) => {
    el.onclick = () => {
      $("modal").hidden = true;
      openChannel(Number(el.dataset.channel));
    };
  });
}

$("export").onclick = () => {
  window.location.href = "/api/export";
};

$("audit").onclick = async () => {
  const data = await api("/api/audit");
  const html = `<pre>${escapeHtml(JSON.stringify(data.events, null, 2))}</pre>`;
  openModal("감사 기록", html);
};

function connectEvents() {
  const es = new EventSource("/api/events");
  const reload = () => {
    if (state.current) loadMessages(state.current);
    if (state.current && state.threadId) loadThread(state.current, state.threadId);
  };
  es.addEventListener("message", reload);
  es.addEventListener("reaction", reload);
}

async function boot() {
  try {
    const me = await api("/api/me");
    state.me = me.user;
    $("me-name").textContent = `${me.user.display_name} · ${me.user.email}`;
    $("workspace-name").textContent = me.workspace.name;
    $("admin-section").hidden = me.user.role !== "admin";
    showApp();
    await refreshChannels();
    const general = state.channels.find((c) => c.type === "public");
    if (general) await openChannel(general.id);
    connectEvents();
  } catch {
    showLogin();
  }
}

boot();
