/**
 * PixelChat — WebSocket Client (8-bit Gamified)
 * ==============================================
 * Handles WebSocket connection, message rendering,
 * XP / rank / streak / session gamification.
 */

// ── Config ───────────────────────────────────────────────────────
const WS_PROTOCOL         = window.location.protocol === "https:" ? "wss:" : "ws:";
const BACKEND_PORT        = 8000;  // Defined in root .env (BACKEND_PORT)
const BACKEND_HOST        = `${window.location.hostname}:${BACKEND_PORT}`;
const SERVER_URL          = `${WS_PROTOCOL}//${BACKEND_HOST}/ws`;
// ── Sounds ───────────────────────────────────────────────────────
const SOUNDS = {
    join:    new Audio("/static/sounds/mushroom.mp3"),   // mushroom_mario  — someone joins
    message: new Audio("/static/sounds/coin.mp3"),       // mario_coin      — new message
    leave:   new Audio("/static/sounds/pipe.mp3"),       // mario_bros_pipe — someone leaves
};
// Pre-load clips so first play is instant
Object.values(SOUNDS).forEach(a => { a.preload = "auto"; a.volume = 0.5; });

function playSound(name) {
    const clip = SOUNDS[name];
    if (!clip) return;
    clip.currentTime = 0;
    clip.play().catch(() => {});   // silently ignore if browser blocks autoplay
}

const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY  = 10000;

// Avatar bg colors — all derived from #778873 / #A1BC98 palette
const AVATAR_COLORS = [
    "#778873", "#A1BC98", "#546058", "#8aab88",
    "#6a8068", "#c8dcc5", "#4a6050", "#9abca0",
    "#667860", "#b0ccb0", "#506858", "#7a9878",
];

// Ranks
const RANKS = [
    { level: 1, xp: 0,   name: "NEWBIE",    next: 50   },
    { level: 2, xp: 50,  name: "SQUIRE",    next: 150  },
    { level: 3, xp: 150, name: "KNIGHT",    next: 320  },
    { level: 4, xp: 320, name: "CHAMPION",  next: 600  },
    { level: 5, xp: 600, name: "WARLORD",   next: 1000 },
    { level: 6, xp: 1000,name: "LEGEND",    next: 1000 },
];

// ── State ─────────────────────────────────────────────────────────
let ws                 = null;
let currentUsername    = "";
let reconnectAttempts  = 0;
let reconnectTimer     = null;
let isIntentionalClose = false;
let isJoined           = false;
let typingTimeout      = null;
let lastTypingSent     = 0;
let isTabFocused       = true;

// Gamification
let totalXP      = 0;
let streakCount  = 0;
let messagesSent = 0;
let sessionStart = null;
let sessionTimer = null;
let currentLevel = 1;

// ── DOM ───────────────────────────────────────────────────────────
const loginScreen     = document.getElementById("login-screen");
const chatScreen      = document.getElementById("chat-screen");
const usernameInput   = document.getElementById("username-input");
const joinBtn         = document.getElementById("join-btn");
const joinBtnText     = document.getElementById("join-btn-text");
const loginError      = document.getElementById("login-error");
const messagesScroll  = document.getElementById("messages-scroll");
const messageInput    = document.getElementById("message-input");
const sendBtn         = document.getElementById("send-btn");
const userList        = document.getElementById("user-list");
const headerSubtitle  = document.getElementById("header-subtitle");
const typingIndicator = document.getElementById("typing-indicator");
const typingTextEl    = document.getElementById("typing-text");
const emojiPicker     = document.getElementById("emoji-picker");
const emojiToggleBtn  = document.getElementById("emoji-toggle-btn");
const statusDot       = document.getElementById("status-dot");
const statusText      = document.getElementById("status-text");

// Gamification DOM
const xpBarFill       = document.getElementById("xp-bar-fill");
const xpValue         = document.getElementById("xp-value");
const rankNameEl      = document.getElementById("rank-name");
const onlineBadge     = document.getElementById("online-count-badge");
const msgCountEl      = document.getElementById("msg-count-stat");
const streakEl        = document.getElementById("streak-count");
const sessionTimeEl   = document.getElementById("session-time-stat");
const levelupToast    = document.getElementById("levelup-toast");
const levelupSub      = document.getElementById("levelup-sub");

// ══════════════════════════════════════════════════════════════════
//  WEBSOCKET
// ══════════════════════════════════════════════════════════════════

function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(SERVER_URL);

    ws.onopen = () => {
        reconnectAttempts = 0;
        updateConnectionStatus("connected");
        ws.send(JSON.stringify({ type: "join", username: currentUsername }));
    };

    ws.onmessage = (event) => {
        try { handleMessage(JSON.parse(event.data)); }
        catch (err) { console.error("[WS] parse error:", err); }
    };

    ws.onclose = () => {
        updateConnectionStatus("disconnected");
        if (loginScreen && !loginScreen.classList.contains("hidden")) return;
        if (!isIntentionalClose && currentUsername) scheduleReconnect();
    };

    ws.onerror = (e) => console.error("[WS] error:", e);
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts), RECONNECT_MAX_DELAY);
    reconnectAttempts++;
    updateConnectionStatus("reconnecting");
    reconnectTimer = setTimeout(connect, delay);
}

function disconnect() {
    isIntentionalClose = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) ws.close();
}

// ══════════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ══════════════════════════════════════════════════════════════════

function handleMessage(data) {
    switch (data.type) {
        case "system":
            if (!isJoined && data.message && data.message.includes("Welcome")) {
                isJoined = true;
                showChatScreen();
            }
            addSystemMessage(data.message, data.timestamp);
            break;

        case "join":
            addSystemMessage(data.message, data.timestamp, "join");
            playSound("join");
            gainXP(5);
            break;

        case "leave":
            addSystemMessage(data.message, data.timestamp, "leave");
            hideTypingIndicator(data.username);
            playSound("leave");
            break;

        case "message":
            addChatMessage(data.username, data.text, data.timestamp);
            hideTypingIndicator(data.username);
            playSound("message");
            if (data.username !== currentUsername && !isTabFocused) playNotificationSound();
            break;

        case "userList":
            updateUserList(data.users);
            break;

        case "typing":
            showTypingIndicator(data.username);
            break;

        case "history":
            renderHistory(data.messages);
            break;

        case "error":
            if (!isJoined) {
                showLoginError(data.message);
                currentUsername = "";
                joinBtn.disabled = false;
                joinBtnText.textContent = "► START QUEST";
            }
            break;

        default:
            console.warn("[WS] unknown type:", data.type);
    }
}

// ══════════════════════════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════════════════════════

function addSystemMessage(text, time, subtype = "") {
    const el = document.createElement("div");
    el.className = `message system ${subtype ? subtype + "-msg" : ""}`;
    el.innerHTML = `
        <div class="message-bubble">
            <p class="message-text">${escapeHtml(text)}</p>
            ${time ? `<span class="message-time">${escapeHtml(time)}</span>` : ""}
        </div>`;
    messagesScroll.appendChild(el);
    scrollToBottom();
}

function addChatMessage(username, text, time) {
    const isOwn = username === currentUsername;
    const el = document.createElement("div");
    el.className = `message ${isOwn ? "own" : "other"}`;
    el.innerHTML = `
        <div class="message-bubble">
            <div class="message-meta">
                <span class="message-username">${escapeHtml(username)}</span>
                ${time ? `<span class="message-time">${escapeHtml(time)}</span>` : ""}
            </div>
            <p class="message-text">${escapeHtml(text)}</p>
        </div>`;
    messagesScroll.appendChild(el);
    scrollToBottom();
}

function updateUserList(users) {
    userList.innerHTML = "";
    const count = users.length;
    if (headerSubtitle) headerSubtitle.textContent = `${count} PLAYER${count !== 1 ? "S" : ""} ONLINE`;
    if (onlineBadge) onlineBadge.textContent = count;

    users.forEach((user) => {
        const li = document.createElement("li");
        const isYou = user === currentUsername;
        if (isYou) li.classList.add("is-you");

        li.innerHTML = `
            <div class="user-avatar" style="background:${getAvatarColor(user)}">
                ${user.charAt(0).toUpperCase()}
            </div>
            <span class="user-name">${escapeHtml(user)}</span>
            ${isYou ? '<span class="user-you-tag">YOU</span>' : ""}`;
        userList.appendChild(li);
    });
}

function updateConnectionStatus(status) {
    if (!statusDot || !statusText) return;
    statusDot.className = "status-dot " + status;
    const labels = { connected: "ONLINE", disconnected: "OFFLINE", reconnecting: "WAIT..." };
    statusText.textContent = labels[status] || status.toUpperCase();
}

function showLoginError(message) {
    loginError.textContent = "! " + message.toUpperCase();
    joinBtn.disabled = false;
    joinBtnText.textContent = "► START QUEST";
}

function showChatScreen() {
    loginScreen.classList.add("hidden");
    chatScreen.classList.remove("hidden");
    messageInput.focus();
    startSessionTimer();
}

function scrollToBottom() {
    messagesScroll.scrollTop = messagesScroll.scrollHeight;
}

function renderHistory(messages) {
    if (!messages || !messages.length) return;

    const sep = document.createElement("div");
    sep.className = "message system";
    sep.innerHTML = `<div class="message-bubble"><p class="message-text">--- PREV MESSAGES ---</p></div>`;
    messagesScroll.appendChild(sep);

    messages.forEach((msg) => {
        if (msg.type === "message") addChatMessage(msg.username, msg.text, msg.timestamp);
    });

    const sep2 = document.createElement("div");
    sep2.className = "message system";
    sep2.innerHTML = `<div class="message-bubble"><p class="message-text">--- NEW MESSAGES ---</p></div>`;
    messagesScroll.appendChild(sep2);
    scrollToBottom();
}

// ══════════════════════════════════════════════════════════════════
//  TYPING
// ══════════════════════════════════════════════════════════════════

function showTypingIndicator(username) {
    typingTextEl.textContent = `${username.toUpperCase()} TYPING`;
    typingIndicator.classList.add("active");
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => typingIndicator.classList.remove("active"), 3000);
}

function hideTypingIndicator(username) {
    if (typingTextEl.textContent.includes(username.toUpperCase())) {
        typingIndicator.classList.remove("active");
        if (typingTimeout) clearTimeout(typingTimeout);
    }
}

function sendTypingEvent() {
    const now = Date.now();
    if (now - lastTypingSent < 2000) return;
    lastTypingSent = now;
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "typing" }));
    }
}

// ══════════════════════════════════════════════════════════════════
//  GAMIFICATION
// ══════════════════════════════════════════════════════════════════

function gainXP(amount) {
    totalXP += amount;
    updateXPBar();
    checkLevelUp();
}

function updateXPBar() {
    const rank = getCurrentRank();
    const xpInLevel    = totalXP - rank.xp;
    const xpNeeded     = rank.next - rank.xp;
    const pct          = rank.level === 6 ? 100 : Math.min(100, (xpInLevel / xpNeeded) * 100);

    if (xpBarFill)  xpBarFill.style.width = `${pct.toFixed(1)}%`;
    if (xpValue)    xpValue.textContent   = `${totalXP}/${rank.next}`;
    if (rankNameEl) rankNameEl.textContent = rank.name;
}

function getCurrentRank() {
    let current = RANKS[0];
    for (const r of RANKS) {
        if (totalXP >= r.xp) current = r;
        else break;
    }
    return current;
}

function checkLevelUp() {
    const rank = getCurrentRank();
    if (rank.level > currentLevel) {
        currentLevel = rank.level;
        if (levelupSub) levelupSub.textContent = `NEW RANK: ${rank.name}`;
        levelupToast.classList.add("show");
        playLevelUpSound();
        setTimeout(() => levelupToast.classList.remove("show"), 3500);
    }
}

function incrementStreak() {
    streakCount++;
    if (streakEl) streakEl.textContent = streakCount;
    if (streakCount % 5 === 0) gainXP(10);
}

function incrementMessageCount() {
    messagesSent++;
    if (msgCountEl) msgCountEl.textContent = messagesSent;
    gainXP(2);
    incrementStreak();
}

function startSessionTimer() {
    sessionStart = Date.now();
    sessionTimer = setInterval(() => {
        const min = Math.floor((Date.now() - sessionStart) / 60000);
        if (sessionTimeEl) {
            sessionTimeEl.textContent = min >= 60
                ? `${Math.floor(min / 60)}H${min % 60}M`
                : `${min}M`;
        }
        gainXP(1);
    }, 60000);
}

// ══════════════════════════════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════════════════════════════

function escapeHtml(text) {
    const d = document.createElement("div");
    d.textContent = text;
    return d.innerHTML;
}

function getAvatarColor(username) {
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
        hash = username.charCodeAt(i) + ((hash << 5) - hash);
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function sendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "message", text }));
        messageInput.value = "";
        messageInput.focus();
        emojiPicker.classList.remove("open");
        emojiToggleBtn.classList.remove("active");
        incrementMessageCount();
    }
}

function playNotificationSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "square";  // 8-bit square wave
        osc.frequency.value = 440;
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
    } catch (e) {}
}

function playLevelUpSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const notes = [262, 330, 392, 523];  // C4 E4 G4 C5 — 8-bit fanfare
        notes.forEach((freq, i) => {
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = "square";
            osc.frequency.value = freq;
            const t = ctx.currentTime + i * 0.12;
            gain.gain.setValueAtTime(0.12, t);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
            osc.start(t);
            osc.stop(t + 0.12);
        });
    } catch (e) {}
}

// ══════════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════════════════════════════════════

joinBtn.addEventListener("click", () => {
    const username = usernameInput.value.trim();
    if (!username) {
        showLoginError("ENTER A NAME FIRST!");
        return;
    }
    loginError.textContent = "";
    joinBtn.disabled = true;
    joinBtnText.textContent = "CONNECTING...";
    currentUsername = username;
    isIntentionalClose = false;
    isJoined = false;
    connect();
});

usernameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinBtn.click();
});

sendBtn.addEventListener("click", sendMessage);

messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

messageInput.addEventListener("input", () => {
    if (messageInput.value.trim().length > 0) sendTypingEvent();
});

emojiToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    emojiPicker.classList.toggle("open");
    emojiToggleBtn.classList.toggle("active");
});

document.getElementById("emoji-grid").addEventListener("click", (e) => {
    const target = e.target.closest(".emoji");
    if (target) {
        messageInput.value += target.textContent;
        messageInput.focus();
    }
});

document.addEventListener("click", (e) => {
    if (!emojiPicker.contains(e.target) && e.target !== emojiToggleBtn) {
        emojiPicker.classList.remove("open");
        emojiToggleBtn.classList.remove("active");
    }
});

window.addEventListener("focus", () => { isTabFocused = true; });
window.addEventListener("blur",  () => { isTabFocused = false; });

window.addEventListener("load", () => {
    usernameInput.focus();
    // Init XP bar
    updateXPBar();
});
