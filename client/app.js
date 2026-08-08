/**
 * Group Chat — WebSocket Client
 * ==============================
 * Handles WebSocket connection, message rendering, and UI state.
 */

// ── Configuration ────────────────────────────────────────────────
// Auto-detect the server URL from the page origin (no hardcoding needed)
const WS_PROTOCOL = window.location.protocol === "https:" ? "wss:" : "ws:";
const SERVER_URL = `${WS_PROTOCOL}//${window.location.host}/ws`;

// Reconnection settings
const RECONNECT_BASE_DELAY = 1000;  // 1 second
const RECONNECT_MAX_DELAY = 10000;  // 10 seconds

// Avatar colors for users (deterministic based on username)
const AVATAR_COLORS = [
    "#7c6aef", "#e94560", "#34d399", "#f59e0b",
    "#60a5fa", "#f472b6", "#a78bfa", "#fb7185",
    "#2dd4bf", "#c084fc", "#38bdf8", "#4ade80",
];

// ── State ─────────────────────────────────────────────────────────
let ws = null;
let currentUsername = "";
let reconnectAttempts = 0;
let reconnectTimer = null;
let isIntentionalClose = false;
let isJoined = false;
let typingTimeout = null;       // Timer for hiding typing indicator
let lastTypingSent = 0;         // Timestamp of last typing event sent
let isTabFocused = true;        // Track if the browser tab is active

// ── DOM Elements ─────────────────────────────────────────────────
const loginScreen     = document.getElementById("login-screen");
const chatScreen      = document.getElementById("chat-screen");
const usernameInput   = document.getElementById("username-input");
const joinBtn         = document.getElementById("join-btn");
const loginError      = document.getElementById("login-error");
const messagesScroll  = document.getElementById("messages-scroll");
const messageInput    = document.getElementById("message-input");
const sendBtn         = document.getElementById("send-btn");
const userList        = document.getElementById("user-list");
const statusDot       = document.querySelector(".status-dot");
const statusText      = document.querySelector(".status-text");
const headerSubtitle  = document.getElementById("header-subtitle");
const typingIndicator = document.getElementById("typing-indicator");
const typingTextEl    = document.getElementById("typing-text");
const emojiPicker     = document.getElementById("emoji-picker");
const emojiToggleBtn  = document.getElementById("emoji-toggle-btn");


// ══════════════════════════════════════════════════════════════════
//  WEBSOCKET CONNECTION
// ══════════════════════════════════════════════════════════════════

function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

    ws = new WebSocket(SERVER_URL);

    ws.onopen = () => {
        console.log("[WS] Connected to server");
        reconnectAttempts = 0;
        updateConnectionStatus("connected");

        // Send join message
        ws.send(JSON.stringify({
            type: "join",
            username: currentUsername
        }));
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleMessage(data);
        } catch (err) {
            console.error("[WS] Failed to parse message:", err);
        }
    };

    ws.onclose = (event) => {
        console.log(`[WS] Disconnected (code: ${event.code})`);
        updateConnectionStatus("disconnected");

        // If we haven't joined yet and got disconnected, show error on login
        if (loginScreen && !loginScreen.classList.contains("hidden")) {
            // Connection closed before joining — likely a validation error
            return;
        }

        // Auto-reconnect if not intentional
        if (!isIntentionalClose && currentUsername) {
            scheduleReconnect();
        }
    };

    ws.onerror = (error) => {
        console.error("[WS] Error:", error);
    };
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);

    const delay = Math.min(
        RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts),
        RECONNECT_MAX_DELAY
    );
    reconnectAttempts++;

    updateConnectionStatus("reconnecting");
    console.log(`[WS] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})`);

    reconnectTimer = setTimeout(() => {
        connect();
    }, delay);
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
            // If this is the welcome message, transition to chat screen
            if (!isJoined && data.message && data.message.includes("Welcome")) {
                isJoined = true;
                showChatScreen();
            }
            addSystemMessage(data.message, data.timestamp);
            break;

        case "join":
            addSystemMessage(data.message, data.timestamp, "join");
            break;

        case "leave":
            addSystemMessage(data.message, data.timestamp, "leave");
            hideTypingIndicator(data.username);
            break;

        case "message":
            addChatMessage(data.username, data.text, data.timestamp);
            hideTypingIndicator(data.username);
            // Play sound if message is from someone else and tab is not focused
            if (data.username !== currentUsername && !isTabFocused) {
                playNotificationSound();
            }
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
            // Show error on login screen if not joined yet
            if (!isJoined) {
                showLoginError(data.message);
                currentUsername = "";
                joinBtn.disabled = false;
                joinBtn.querySelector("span").textContent = "Join Chat";
            }
            break;

        default:
            console.warn("[WS] Unknown message type:", data.type);
    }
}


// ══════════════════════════════════════════════════════════════════
//  UI RENDERING
// ══════════════════════════════════════════════════════════════════

/**
 * Add a system message (join/leave/info) to the chat.
 */
function addSystemMessage(text, time, subtype = "") {
    const msgDiv = document.createElement("div");
    msgDiv.className = `message system ${subtype ? subtype + "-msg" : ""}`;

    msgDiv.innerHTML = `
        <div class="message-bubble">
            <p class="message-text">${escapeHtml(text)}</p>
            ${time ? `<span class="message-time">${escapeHtml(time)}</span>` : ""}
        </div>
    `;

    messagesScroll.appendChild(msgDiv);
    scrollToBottom();
}

/**
 * Add a chat message (own or other) to the chat.
 */
function addChatMessage(username, text, time) {
    const isOwn = username === currentUsername;
    const msgDiv = document.createElement("div");
    msgDiv.className = `message ${isOwn ? "own" : "other"}`;

    msgDiv.innerHTML = `
        <div class="message-bubble">
            <div class="message-meta">
                <span class="message-username">${escapeHtml(username)}</span>
                ${time ? `<span class="message-time">${escapeHtml(time)}</span>` : ""}
            </div>
            <p class="message-text">${escapeHtml(text)}</p>
        </div>
    `;

    messagesScroll.appendChild(msgDiv);
    scrollToBottom();
}

/**
 * Update the online users sidebar.
 */
function updateUserList(users) {
    userList.innerHTML = "";
    headerSubtitle.textContent = `${users.length} online`;

    users.forEach((user) => {
        const li = document.createElement("li");
        const isYou = user === currentUsername;

        if (isYou) li.classList.add("is-you");

        li.innerHTML = `
            <div class="user-avatar" style="background: ${getAvatarColor(user)}">
                ${user.charAt(0).toUpperCase()}
            </div>
            <span class="user-name">${escapeHtml(user)}</span>
            ${isYou ? '<span class="user-you-tag">You</span>' : ""}
        `;

        userList.appendChild(li);
    });
}

/**
 * Update the connection status indicator in the header.
 */
function updateConnectionStatus(status) {
    statusDot.className = "status-dot " + status;

    switch (status) {
        case "connected":
            statusText.textContent = "Connected";
            break;
        case "disconnected":
            statusText.textContent = "Disconnected";
            break;
        case "reconnecting":
            statusText.textContent = "Reconnecting...";
            break;
    }
}

/**
 * Show an error message on the login screen.
 */
function showLoginError(message) {
    loginError.textContent = message;
    joinBtn.disabled = false;
    joinBtn.querySelector("span").textContent = "Join Chat";
}

/**
 * Switch from login to chat screen.
 */
function showChatScreen() {
    loginScreen.classList.add("hidden");
    chatScreen.classList.remove("hidden");
    messageInput.focus();
}

/**
 * Auto-scroll the messages area to the bottom.
 */
function scrollToBottom() {
    messagesScroll.scrollTop = messagesScroll.scrollHeight;
}


// ══════════════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════════════════

/**
 * Escape HTML to prevent XSS.
 */
function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Get a deterministic avatar color for a username.
 */
function getAvatarColor(username) {
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
        hash = username.charCodeAt(i) + ((hash << 5) - hash);
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/**
 * Send a chat message to the server.
 */
function sendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: "message",
            text: text
        }));
        messageInput.value = "";
        messageInput.focus();
        // Close emoji picker after sending
        emojiPicker.classList.remove("open");
        emojiToggleBtn.classList.remove("active");
    }
}

/**
 * Render message history received on join.
 */
function renderHistory(messages) {
    if (!messages || messages.length === 0) return;

    // Add a separator
    const sep = document.createElement("div");
    sep.className = "message system";
    sep.innerHTML = `<div class="message-bubble"><p class="message-text">─── Previous Messages ───</p></div>`;
    messagesScroll.appendChild(sep);

    messages.forEach((msg) => {
        if (msg.type === "message") {
            addChatMessage(msg.username, msg.text, msg.timestamp);
        }
    });

    // Add another separator
    const sep2 = document.createElement("div");
    sep2.className = "message system";
    sep2.innerHTML = `<div class="message-bubble"><p class="message-text">─── New Messages ───</p></div>`;
    messagesScroll.appendChild(sep2);

    scrollToBottom();
}

/**
 * Show typing indicator for a specific user.
 */
function showTypingIndicator(username) {
    typingTextEl.textContent = `${username} is typing...`;
    typingIndicator.classList.add("active");

    // Clear previous timeout and set new one (hide after 3 seconds)
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        typingIndicator.classList.remove("active");
    }, 3000);
}

/**
 * Hide typing indicator (when user sends a message or leaves).
 */
function hideTypingIndicator(username) {
    if (typingTextEl.textContent.includes(username)) {
        typingIndicator.classList.remove("active");
        if (typingTimeout) clearTimeout(typingTimeout);
    }
}

/**
 * Send typing indicator to server (debounced — max once per 2 seconds).
 */
function sendTypingEvent() {
    const now = Date.now();
    if (now - lastTypingSent < 2000) return; // Debounce: 2 seconds
    lastTypingSent = now;

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "typing" }));
    }
}

/**
 * Play a notification ping sound using Web Audio API.
 */
function playNotificationSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();

        oscillator.connect(gain);
        gain.connect(ctx.destination);

        oscillator.frequency.value = 880;  // A5 note
        oscillator.type = "sine";

        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

        oscillator.start(ctx.currentTime);
        oscillator.stop(ctx.currentTime + 0.4);
    } catch (e) {
        // Audio API not available — silently fail
    }
}


// ══════════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════════════════════════════════════

// Join button
joinBtn.addEventListener("click", () => {
    const username = usernameInput.value.trim();
    if (!username) {
        showLoginError("Please enter a username.");
        return;
    }

    loginError.textContent = "";
    joinBtn.disabled = true;
    joinBtn.querySelector("span").textContent = "Connecting...";
    currentUsername = username;
    isIntentionalClose = false;
    isJoined = false;

    // Connect — the onopen handler sends the join message,
    // and handleMessage() takes care of transitioning to the chat screen
    connect();
});

// Username input — Enter key to join
usernameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        joinBtn.click();
    }
});

// Send button
sendBtn.addEventListener("click", sendMessage);

// Message input — Enter key to send
messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// Message input — Typing indicator (fires on every keystroke, debounced internally)
messageInput.addEventListener("input", () => {
    if (messageInput.value.trim().length > 0) {
        sendTypingEvent();
    }
});

// Emoji toggle button
emojiToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    emojiPicker.classList.toggle("open");
    emojiToggleBtn.classList.toggle("active");
});

// Emoji grid — click to insert emoji
document.getElementById("emoji-grid").addEventListener("click", (e) => {
    const target = e.target.closest(".emoji");
    if (target) {
        messageInput.value += target.textContent;
        messageInput.focus();
    }
});

// Close emoji picker when clicking outside
document.addEventListener("click", (e) => {
    if (!emojiPicker.contains(e.target) && e.target !== emojiToggleBtn) {
        emojiPicker.classList.remove("open");
        emojiToggleBtn.classList.remove("active");
    }
});

// Track tab focus for sound notifications
window.addEventListener("focus", () => { isTabFocused = true; });
window.addEventListener("blur",  () => { isTabFocused = false; });

// Focus username input on load
window.addEventListener("load", () => {
    usernameInput.focus();
});
