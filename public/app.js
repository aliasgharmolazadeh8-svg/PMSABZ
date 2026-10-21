
const $ = (id) => document.getElementById(id);

const authView = $("authView");
const dashboardView = $("dashboardView");
const chatView = $("chatView");
const authForm = $("authForm");

let authMode = "login";
let currentUser = null;
let activeLobby = null;
let socket = null;
let displayedMessageIds = new Set();

function showError(id, message = "") {
  $(id).textContent = message;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "درخواست ناموفق بود.");
  }

  return data;
}

function setView(view) {
  authView.classList.toggle("hidden", view !== "auth");
  dashboardView.classList.toggle("hidden", view !== "dashboard");
  chatView.classList.toggle("hidden", view !== "chat");
  $("logoutBtn").classList.toggle("hidden", view === "auth");
}

function setAuthMode(mode) {
  authMode = mode;
  $("loginTab").classList.toggle("active", mode === "login");
  $("registerTab").classList.toggle("active", mode === "register");
  $("authSubmit").textContent = mode === "login" ? "ورود به حساب" : "ساخت حساب";
  $("password").autocomplete = mode === "login" ? "current-password" : "new-password";
  showError("authError");
}

$("loginTab").addEventListener("click", () => setAuthMode("login"));
$("registerTab").addEventListener("click", () => setAuthMode("register"));

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("authError");

  const username = $("username").value.trim();
  const password = $("password").value;

  try {
    const data = await api(`/api/${authMode}`, {
      method: "POST",
      body: JSON.stringify({ username, password })
    });

    currentUser = data.user;
    await openDashboard();
  } catch (error) {
    showError("authError", error.message);
  }
});

async function openDashboard() {
  setView("dashboard");
  $("currentUser").textContent = currentUser.username;
  await loadLobbies();
  connectSocket();
}

async function loadLobbies() {
  try {
    const { lobbies } = await api("/api/lobbies");
    $("lobbyCount").textContent = `${lobbies.length} لابی`;

    const list = $("lobbyList");
    list.replaceChildren();

    if (!lobbies.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "هنوز لابی نداری؛ اولین لابی رو بساز!";
      list.appendChild(empty);
      return;
    }

    for (const lobby of lobbies) {
      const item = document.createElement("div");
      item.className = "lobby-item";

      const info = document.createElement("div");
      const name = document.createElement("h4");
      name.textContent = lobby.name;
      const code = document.createElement("small");
      code.textContent = `کد: ${lobby.code}`;
      info.append(name, code);

      const button = document.createElement("button");
      button.className = "btn secondary";
      button.textContent = "ورود";
      button.addEventListener("click", () => openLobby(lobby));

      item.append(info, button);
      list.appendChild(item);
    }
  } catch (error) {
    showError("dashboardError", error.message);
  }
}

$("createForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("dashboardError");

  try {
    const { lobby } = await api("/api/lobbies", {
      method: "POST",
      body: JSON.stringify({ name: $("lobbyName").value })
    });

    $("lobbyName").value = "";
    await loadLobbies();
    await openLobby(lobby);
  } catch (error) {
    showError("dashboardError", error.message);
  }
});

$("joinForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("dashboardError");

  try {
    const { lobby } = await api("/api/lobbies/join", {
      method: "POST",
      body: JSON.stringify({ code: $("lobbyCode").value })
    });

    $("lobbyCode").value = "";
    await loadLobbies();
    await openLobby(lobby);
  } catch (error) {
    showError("dashboardError", error.message);
  }
});

function connectSocket() {
  if (socket) return;

  socket = io();

  socket.on("connect_error", () => {
    showError("chatError", "اتصال برقرار نشد؛ صفحه را دوباره باز کن.");
  });

  socket.on("new-message", (message) => {
    if (!activeLobby || displayedMessageIds.has(message.id)) return;
    addMessage(message);
  });
}

function openLobby(lobby) {
  activeLobby = lobby;
  displayedMessageIds = new Set();

  $("chatName").textContent = lobby.name;
  $("chatCode").textContent = lobby.code;
  $("messages").replaceChildren();
  showError("chatError");
  setView("chat");
  connectSocket();

  socket.emit("join-lobby", lobby.id, (result) => {
    if (result?.error) {
      showError("chatError", result.error);
      return;
    }

    $("messages").replaceChildren();
    displayedMessageIds = new Set();

    for (const message of result.messages || []) {
      addMessage(message);
    }
  });
}

function addMessage(message) {
  if (message.id && displayedMessageIds.has(message.id)) return;
  if (message.id) displayedMessageIds.add(message.id);

  const wrapper = document.createElement("div");
  wrapper.className = "message";

  if (message.username === currentUser.username) {
    wrapper.classList.add("mine");
  }

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = message.username;

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = message.text;

  wrapper.append(meta, bubble);
  $("messages").appendChild(wrapper);
  $("messages").scrollTop = $("messages").scrollHeight;
}

$("messageForm").addEventListener("submit", (event) => {
  event.preventDefault();
  showError("chatError");

  const text = $("messageInput").value.trim();

  if (!text || !activeLobby || !socket) return;

  socket.emit(
    "send-message",
    { lobbyId: activeLobby.id, text },
    (result) => {
      if (result?.error) {
        showError("chatError", result.error);
        return;
      }

      $("messageInput").value = "";
      $("messageInput").focus();
    }
  );
});

$("backBtn").addEventListener("click", () => {
  activeLobby = null;
  setView("dashboard");
});

$("copyCodeBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(activeLobby.code);
    $("copyCodeBtn").textContent = "کپی شد ✓";
    setTimeout(() => {
      $("copyCodeBtn").textContent = "کپی کد";
    }, 1500);
  } catch {
    showError("chatError", `کد دعوت: ${activeLobby.code}`);
  }
});

$("logoutBtn").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    // صفحه ورود در هر صورت نمایش داده می‌شود.
  }

  if (socket) socket.disconnect();
  socket = null;
  currentUser = null;
  activeLobby = null;
  authForm.reset();
  setView("auth");
});

async function init() {
  try {
    const { user } = await api("/api/me");

    if (user) {
      currentUser = user;
      await openDashboard();
    } else {
      setView("auth");
    }
  } catch {
    setView("auth");
  }
}

init();
