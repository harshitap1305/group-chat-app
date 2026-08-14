/**
 * PixelChat — WebSocket Client
 */

// ── Config ───────────────────────────────────────────────────────
const WS_PROTOCOL = window.location.protocol === "https:" ? "wss:" : "ws:";
const HTTP_PROTOCOL = window.location.protocol === "https:" ? "https:" : "http:";
const BACKEND_PORT = 8000;  // Defined in root .env (BACKEND_PORT)
const BACKEND_HOST = `${window.location.hostname}:${BACKEND_PORT}`;
const SERVER_URL = `${WS_PROTOCOL}//${BACKEND_HOST}/ws`;
const UPLOAD_URL = `${HTTP_PROTOCOL}//${BACKEND_HOST}/upload`;
// ── Sounds ───────────────────────────────────────────────────────
const SOUNDS = {
    join: new Audio("/static/sounds/mushroom.mp3"),   // someone joins
    message: new Audio("/static/sounds/coin.mp3"),    // new message
    leave: new Audio("/static/sounds/pipe.mp3"),      // someone leaves
};

Object.values(SOUNDS).forEach(a => { a.preload = "auto"; a.volume = 0.5; });

function playSound(name) {
    const clip = SOUNDS[name];
    if (!clip) return;
    clip.currentTime = 0;
    clip.play().catch(() => { });
}

const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 10000;

// Avatar bg colors
const AVATAR_COLORS = [
    "#778873", "#A1BC98", "#546058", "#8aab88",
    "#6a8068", "#c8dcc5", "#4a6050", "#9abca0",
    "#667860", "#b0ccb0", "#506858", "#7a9878",
];

// Predefined Avatars
const AVATARS = [
    { id: "wizard", name: "WIZARD", icon: "🧙‍♂️", bg: "#4a6050", border: "#A1BC98" },
    { id: "robot", name: "ROBOT", icon: "🤖", bg: "#384d54", border: "#729fa8" },
    { id: "ninja", name: "NINJA", icon: "🥷", bg: "#2d3330", border: "#586660" },
    { id: "astronaut", name: "ASTRO", icon: "👨‍🚀", bg: "#423854", border: "#8f75b8" },
    { id: "dragon", name: "DRAGON", icon: "🐉", bg: "#5c2a2a", border: "#b85c5c" },
    { id: "hero", name: "HERO", icon: "🦸", bg: "#2a425c", border: "#5c8eb8" },
    { id: "alien", name: "ALIEN", icon: "👽", bg: "#2a5c3b", border: "#5cb87d" },
    { id: "cyber", name: "CYBER", icon: "👾", bg: "#542a5c", border: "#b85cb0" },
    { id: "fox", name: "FOX", icon: "🦊", bg: "#5c3d2a", border: "#b87c5c" },
    { id: "owl", name: "OWL", icon: "🦉", bg: "#473f32", border: "#8a7d67" },
    { id: "bear", name: "BEAR", icon: "🐻", bg: "#3b2f28", border: "#786154" },
    { id: "lion", name: "LION", icon: "🦁", bg: "#594924", border: "#ad914e" },
];

let selectedAvatar = "wizard";

function getAvatarData(avatarId, username = "") {
    const found = AVATARS.find(a => a.id === avatarId);
    if (found) return found;
    return {
        id: avatarId || "default",
        name: username || "HERO",
        icon: (username || "?").charAt(0).toUpperCase(),
        bg: getAvatarColor(username || avatarId || "user"),
        border: "#A1BC98"
    };
}

function renderAvatarPicker() {
    const pickerGrid = document.getElementById("avatar-picker-grid");
    if (!pickerGrid) return;
    pickerGrid.innerHTML = "";

    AVATARS.forEach((av) => {
        const item = document.createElement("div");
        item.className = `avatar-option ${av.id === selectedAvatar ? "selected" : ""}`;
        item.dataset.id = av.id;
        item.style.backgroundColor = av.bg;
        item.style.borderColor = av.border;
        item.title = av.name;

        item.innerHTML = `
            <span class="avatar-option-icon">${av.icon}</span>
            <span class="avatar-option-name">${av.name}</span>
        `;

        item.addEventListener("click", () => {
            selectedAvatar = av.id;
            document.querySelectorAll(".avatar-option").forEach(el => el.classList.remove("selected"));
            item.classList.add("selected");
        });

        pickerGrid.appendChild(item);
    });
}

// Ranks
const RANKS = [
    { level: 1, xp: 0, name: "NEWBIE", next: 50 },
    { level: 2, xp: 50, name: "SQUIRE", next: 150 },
    { level: 3, xp: 150, name: "KNIGHT", next: 320 },
    { level: 4, xp: 320, name: "CHAMPION", next: 600 },
    { level: 5, xp: 600, name: "WARLORD", next: 1000 },
    { level: 6, xp: 1000, name: "LEGEND", next: 1000 },
];

// ── State ─────────────────────────────────────────────────────────
let ws = null;
let currentUsername = "";
let reconnectAttempts = 0;
let reconnectTimer = null;
let isIntentionalClose = false;
let isJoined = false;
let typingTimeout = null;
let lastTypingSent = 0;
let isTabFocused = true;

// Gamification
let totalXP = 0;
let streakCount = 0;
let messagesSent = 0;
let sessionStart = null;
let sessionTimer = null;
let currentLevel = 1;

// Receipt tracking: maps client_msg_id -> receipt <span> DOM element
const pendingReceipts = new Map();

// Attachment state
let attachmentData = null;
let pendingFile = null;

function clearPendingAttachment() {
    attachmentData = null;
    pendingFile = null;
    if (attachmentPreviewBar) attachmentPreviewBar.classList.add("hidden");
    if (attachmentFilename) attachmentFilename.textContent = "";
    if (attachmentFilesize) attachmentFilesize.textContent = "";
    if (fileInput) fileInput.value = "";
}

function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function getFileIcon(fileType, fileName) {
    if (fileType.includes("pdf")) return "📄";
    if (fileType.includes("word") || fileName.endsWith(".docx") || fileName.endsWith(".doc")) return "📝";
    if (fileType.includes("zip") || fileType.includes("rar") || fileType.includes("7z")) return "🗜️";
    if (fileType.includes("text") || fileName.endsWith(".txt")) return "🗒️";
    if (fileType.includes("spreadsheet") || fileName.endsWith(".xlsx") || fileName.endsWith(".csv")) return "📊";
    return "📁";
}

// ── DOM ───────────────────────────────────────────────────────────
const loginScreen = document.getElementById("login-screen");
const chatScreen = document.getElementById("chat-screen");
const usernameInput = document.getElementById("username-input");
const joinBtn = document.getElementById("join-btn");
const joinBtnText = document.getElementById("join-btn-text");
const loginError = document.getElementById("login-error");
const messagesScroll = document.getElementById("messages-scroll");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const userList = document.getElementById("user-list");
const headerSubtitle = document.getElementById("header-subtitle");
const typingIndicator = document.getElementById("typing-indicator");
const typingTextEl = document.getElementById("typing-text");
const emojiPicker = document.getElementById("emoji-picker");
const emojiToggleBtn = document.getElementById("emoji-toggle-btn");
const fileInput = document.getElementById("file-input");
const attachmentToggleBtn = document.getElementById("attachment-toggle-btn");
const attachmentPreviewBar = document.getElementById("attachment-preview-bar");
const attachmentFilename = document.getElementById("attachment-filename");
const attachmentFilesize = document.getElementById("attachment-filesize");
const attachmentRemoveBtn = document.getElementById("attachment-remove-btn");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");

// Gamification DOM
const xpBarFill = document.getElementById("xp-bar-fill");
const xpValue = document.getElementById("xp-value");
const rankNameEl = document.getElementById("rank-name");
const onlineBadge = document.getElementById("online-count-badge");
const msgCountEl = document.getElementById("msg-count-stat");
const streakEl = document.getElementById("streak-count");
const sessionTimeEl = document.getElementById("session-time-stat");
const levelupToast = document.getElementById("levelup-toast");
const levelupSub = document.getElementById("levelup-sub");

// Info modal + leave button
const infoBtn = document.getElementById("info-btn");
const leaveBtn = document.getElementById("leave-btn");
const infoModalOverlay = document.getElementById("info-modal-overlay");
const infoModalClose = document.getElementById("info-modal-close");

// ══════════════════════════════════════════════════════════════════
//  WEBSOCKET
// ══════════════════════════════════════════════════════════════════

function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(SERVER_URL);

    ws.onopen = () => {
        reconnectAttempts = 0;
        updateConnectionStatus("connected");
        ws.send(JSON.stringify({ type: "join", username: currentUsername, avatar: selectedAvatar }));
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
    pendingReceipts.clear();
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
            if (data.username === currentUsername) break;
            addChatMessage(data.username, data.text, data.timestamp, data.avatar, data.attachment);
            hideTypingIndicator(data.username);
            playSound("message");
            if (!isTabFocused) playNotificationSound();
            break;

        case "receipt":
            updateReceipt(data.msg_id, data.status);
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

function addChatMessage(username, text, time, avatarId = "wizard", attachment = null) {
    const isOwn = username === currentUsername;
    const avatarData = getAvatarData(avatarId, username);
    const el = document.createElement("div");
    el.className = `message ${isOwn ? "own" : "other"}`;

    const avatarHtml = `
        <div class="chat-msg-avatar" style="background:${avatarData.bg}; border-color:${avatarData.border}" title="${escapeHtml(avatarData.name)}">
            <span>${avatarData.icon}</span>
        </div>`;

    let attachmentHtml = "";
    if (attachment && attachment.url) {
        const fileUrl = escapeHtml(attachment.url);
        const fileName = escapeHtml(attachment.fileName || "attachment");
        const fileType = (attachment.fileType || "").toLowerCase();
        const fileSize = formatBytes(attachment.fileSize || 0);

        if (fileType.startsWith("image/")) {
            attachmentHtml = `
                <div class="chat-attachment chat-attachment-image">
                    <a href="${fileUrl}" target="_blank" title="View Full Image">
                        <img src="${fileUrl}" alt="${fileName}">
                    </a>
                </div>`;
        } else if (fileType.startsWith("video/")) {
            attachmentHtml = `
                <div class="chat-attachment chat-attachment-video">
                    <video controls src="${fileUrl}"></video>
                </div>`;
        } else if (fileType.startsWith("audio/")) {
            attachmentHtml = `
                <div class="chat-attachment chat-attachment-audio">
                    <audio controls src="${fileUrl}"></audio>
                </div>`;
        } else {
            const icon = getFileIcon(fileType, fileName);
            attachmentHtml = `
                <div class="chat-attachment">
                    <a href="${fileUrl}" download="${fileName}" class="chat-attachment-file" target="_blank" title="Download File">
                        <span class="file-card-icon">${icon}</span>
                        <div class="file-card-details">
                            <span class="file-card-name">${fileName}</span>
                            <span class="file-card-size">${fileSize}</span>
                        </div>
                        <span class="file-card-dl-btn">💾 DOWNLOAD</span>
                    </a>
                </div>`;
        }
    }

    el.innerHTML = `
        ${!isOwn ? avatarHtml : ""}
        <div class="message-bubble">
            <div class="message-meta">
                <span class="message-username">${escapeHtml(username)}</span>
                ${time ? `<span class="message-time">${escapeHtml(time)}</span>` : ""}
            </div>
            ${text ? `<p class="message-text">${escapeHtml(text)}</p>` : ""}
            ${attachmentHtml}
        </div>
        ${isOwn ? avatarHtml : ""}
    `;
    messagesScroll.appendChild(el);
    scrollToBottom();
}

function addOwnMessageOptimistic(text, msgId, attachment = null) {
    const avatarData = getAvatarData(selectedAvatar, currentUsername);
    const el = document.createElement("div");
    el.className = "message own";

    const avatarHtml = `
        <div class="chat-msg-avatar" style="background:${avatarData.bg}; border-color:${avatarData.border}" title="${escapeHtml(avatarData.name)}">
            <span>${avatarData.icon}</span>
        </div>`;

    // Build attachment HTML
    let attachmentHtml = "";
    if (attachment && attachment.url) {
        const fileUrl = escapeHtml(attachment.url);
        const fileName = escapeHtml(attachment.fileName || "attachment");
        const fileType = (attachment.fileType || "").toLowerCase();
        const fileSize = formatBytes(attachment.fileSize || 0);
        if (fileType.startsWith("image/")) {
            attachmentHtml = `<div class="chat-attachment chat-attachment-image"><a href="${fileUrl}" target="_blank"><img src="${fileUrl}" alt="${fileName}"></a></div>`;
        } else if (fileType.startsWith("video/")) {
            attachmentHtml = `<div class="chat-attachment chat-attachment-video"><video controls src="${fileUrl}"></video></div>`;
        } else if (fileType.startsWith("audio/")) {
            attachmentHtml = `<div class="chat-attachment chat-attachment-audio"><audio controls src="${fileUrl}"></audio></div>`;
        } else {
            const icon = getFileIcon(fileType, fileName);
            attachmentHtml = `<div class="chat-attachment"><a href="${fileUrl}" download="${fileName}" class="chat-attachment-file" target="_blank"><span class="file-card-icon">${icon}</span><div class="file-card-details"><span class="file-card-name">${fileName}</span><span class="file-card-size">${fileSize}</span></div><span class="file-card-dl-btn">💾 DOWNLOAD</span></a></div>`;
        }
    }

    const receiptId = `receipt-${msgId}`;
    el.innerHTML = `
        <div class="message-bubble">
            <div class="message-meta">
                <span class="message-username">${escapeHtml(currentUsername)}</span>
                <span class="message-time">${currentTime()}</span>
            </div>
            ${text ? `<p class="message-text">${escapeHtml(text)}</p>` : ""}
            ${attachmentHtml}
            <span class="receipt-icon" id="${receiptId}" title="Sent">😴</span>
        </div>
        ${avatarHtml}
    `;
    messagesScroll.appendChild(el);
    scrollToBottom();
    pendingReceipts.set(msgId, document.getElementById(receiptId));
}

/**
 * Upgrade the receipt emoji on a sent bubble based on server confirmation
 */
function updateReceipt(msgId, status) {
    const el = pendingReceipts.get(msgId);
    if (!el) return;
    if (status === "partial") {
        el.textContent = "😃";
        el.title = "Delivered to some";
        el.classList.add("receipt-partial");
    } else if (status === "delivered_all") {
        el.textContent = "😎";
        el.title = "Delivered to all";
        el.classList.add("receipt-delivered");
    }
    pendingReceipts.delete(msgId);
}

function updateUserList(users) {
    userList.innerHTML = "";
    const count = users.length;
    if (headerSubtitle) headerSubtitle.textContent = `${count} PLAYER${count !== 1 ? "S" : ""} ONLINE`;
    if (onlineBadge) onlineBadge.textContent = count;

    users.forEach((item) => {
        const username = typeof item === "object" ? item.username : item;
        const avatarId = typeof item === "object" ? item.avatar : "wizard";
        const avatarData = getAvatarData(avatarId, username);

        const li = document.createElement("li");
        const isYou = username === currentUsername;
        if (isYou) li.classList.add("is-you");

        li.innerHTML = `
            <div class="user-avatar" style="background:${avatarData.bg}; border-color:${avatarData.border}">
                ${avatarData.icon}
            </div>
            <span class="user-name">${escapeHtml(username)}</span>
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
    playSound("join");
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
        if (msg.type === "message") addChatMessage(msg.username, msg.text, msg.timestamp, msg.avatar, msg.attachment);
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
    const xpInLevel = totalXP - rank.xp;
    const xpNeeded = rank.next - rank.xp;
    const pct = rank.level === 6 ? 100 : Math.min(100, (xpInLevel / xpNeeded) * 100);

    if (xpBarFill) xpBarFill.style.width = `${pct.toFixed(1)}%`;
    if (xpValue) xpValue.textContent = `${totalXP}/${rank.next}`;
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

/** Returns the current wall-clock time as HH:MM:SS (matches server format). */
function currentTime() {
    return new Date().toLocaleTimeString("en-GB");
}

function sendMessage() {
    const text = messageInput.value.trim();
    const hasAttachment = typeof attachmentData !== "undefined" && attachmentData !== null;
    if (!text && !hasAttachment) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
        // Generate a local ID to track this bubble's receipt
        const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        ws.send(JSON.stringify({
            type: "message",
            text,
            client_msg_id: msgId,
            attachment: attachmentData || null
        }));
        playSound("message");
        const attachmentSnapshot = attachmentData || null;
        addOwnMessageOptimistic(text, msgId, attachmentSnapshot);
        messageInput.value = "";
        clearPendingAttachment();
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
    } catch (e) { }
}

function playLevelUpSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const notes = [262, 330, 392, 523];
        notes.forEach((freq, i) => {
            const osc = ctx.createOscillator();
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
    } catch (e) { }
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

if (attachmentToggleBtn && fileInput) {
    attachmentToggleBtn.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", async () => {
        if (!fileInput.files || !fileInput.files[0]) return;
        pendingFile = fileInput.files[0];

        // Show preview bar immediately with uploading state
        attachmentFilename.textContent = pendingFile.name;
        attachmentFilesize.textContent = "(UPLOADING...)";
        attachmentPreviewBar.classList.remove("hidden");
        attachmentData = null;

        // Upload the file to the server
        try {
            const formData = new FormData();
            formData.append("file", pendingFile);
            const res = await fetch(UPLOAD_URL, { method: "POST", body: formData });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            attachmentData = await res.json();
            if (attachmentData.url && attachmentData.url.startsWith("/")) {
                attachmentData.url = `${HTTP_PROTOCOL}//${BACKEND_HOST}${attachmentData.url}`;
            }
            attachmentFilesize.textContent = `(${formatBytes(attachmentData.fileSize)})`;
        } catch (err) {
            console.error("[Upload] failed:", err);
            attachmentFilename.textContent = "UPLOAD FAILED";
            attachmentFilesize.textContent = "";
            attachmentData = null;
            pendingFile = null;
        }
    });

    if (attachmentRemoveBtn) {
        attachmentRemoveBtn.addEventListener("click", clearPendingAttachment);
    }
}

document.addEventListener("click", (e) => {
    if (!emojiPicker.contains(e.target) && e.target !== emojiToggleBtn) {
        emojiPicker.classList.remove("open");
        emojiToggleBtn.classList.remove("active");
    }
});

window.addEventListener("focus", () => { isTabFocused = true; });
window.addEventListener("blur", () => { isTabFocused = false; });

// ── Info modal ────────────────────────────────────────────────
infoBtn.addEventListener("click", () => {
    infoModalOverlay.classList.remove("hidden");
});

infoModalClose.addEventListener("click", () => {
    infoModalOverlay.classList.add("hidden");
});

// Close on backdrop click
infoModalOverlay.addEventListener("click", (e) => {
    if (e.target === infoModalOverlay) infoModalOverlay.classList.add("hidden");
});

// Close on Escape key
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") infoModalOverlay.classList.add("hidden");
});

// ── Leave button ──────────────────────────────────────────────
leaveBtn.addEventListener("click", () => {
    leaveChat();
});

function leaveChat() {
    // Stop session timer
    if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
    playSound("leave");
    // Close WebSocket
    disconnect();
    // Reset gamification state
    totalXP = 0; streakCount = 0; messagesSent = 0; currentLevel = 1;
    if (xpBarFill) xpBarFill.style.width = "0%";
    if (xpValue) xpValue.textContent = "0/50";
    if (rankNameEl) rankNameEl.textContent = "NEWBIE";
    if (msgCountEl) msgCountEl.textContent = "0";
    if (streakEl) streakEl.textContent = "0";
    if (sessionTimeEl) sessionTimeEl.textContent = "0M";
    // Clear chat messages
    messagesScroll.innerHTML = "";
    // Reset username & flags
    currentUsername = "";
    isJoined = false;
    isIntentionalClose = false;
    // Re-enable join button
    joinBtn.disabled = false;
    joinBtnText.textContent = "► START QUEST";
    loginError.textContent = "";
    // Flip screens
    chatScreen.classList.add("hidden");
    loginScreen.classList.remove("hidden");
    usernameInput.value = "";
    usernameInput.focus();
}

window.addEventListener("load", () => {
    usernameInput.focus();
    renderAvatarPicker();
    updateXPBar();
});
