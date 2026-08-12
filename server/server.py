"""
Real-Time Group Chat Server
============================
FastAPI WebSocket server that handles:
- User join/leave notifications
- Real-time message broadcasting
- Username validation (uniqueness)
- Graceful disconnection handling
- Message history for new joiners
- Typing indicators
"""

import json
import asyncio
import os
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from .env at project root
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware


# ---------------------------------------------------------------------------
# Connection Manager — tracks all active WebSocket connections
# ---------------------------------------------------------------------------

class ConnectionManager:
    """Manages WebSocket connections and message broadcasting."""

    def __init__(self):
        # Maps WebSocket objects to dict with username and avatar
        self.active_connections: dict[WebSocket, dict] = {}
        # Store last N messages for new joiners
        self.message_history: list[dict] = []
        self.MAX_HISTORY = 50
        # Timer handle for clearing history after the room empties
        self._cleanup_timer: asyncio.TimerHandle | None = None
        self.HISTORY_CLEAR_DELAY = 60  # seconds

    def add(self, websocket: WebSocket, username: str, avatar: str = "avatar-1"):
        """Register a new connection with a username and avatar."""
        # Someone joined — cancel the pending history-clear if any
        self._cancel_cleanup_timer()
        self.active_connections[websocket] = {
            "username": username,
            "avatar": avatar
        }

    def remove(self, websocket: WebSocket) -> str | None:
        """Remove a connection and return its username (or None)."""
        info = self.active_connections.pop(websocket, None)
        return info["username"] if info else None

    def get_username(self, websocket: WebSocket) -> str | None:
        """Get the username for a given WebSocket."""
        info = self.active_connections.get(websocket)
        return info["username"] if info else None

    def get_avatar(self, websocket: WebSocket) -> str:
        """Get the avatar for a given WebSocket."""
        info = self.active_connections.get(websocket)
        return info["avatar"] if info else "avatar-1"

    def get_all_users(self) -> list[dict]:
        """Return a sorted list of all connected user dicts."""
        users = list(self.active_connections.values())
        return sorted(users, key=lambda x: x["username"].lower())

    def is_username_taken(self, username: str) -> bool:
        """Check if a username is already in use (case-insensitive)."""
        return username.lower() in [
            info["username"].lower() for info in self.active_connections.values()
        ]

    async def broadcast(self, message: dict, exclude: WebSocket | None = None):
        """Send a JSON message to all connected clients (optionally excluding one)."""
        disconnected = []
        for ws in self.active_connections:
            if ws != exclude:
                try:
                    await ws.send_json(message)
                except Exception:
                    disconnected.append(ws)
        # Clean up any broken connections
        for ws in disconnected:
            self.active_connections.pop(ws, None)

    async def send_to_all(self, message: dict):
        """Send a JSON message to ALL connected clients (no exclusions)."""
        await self.broadcast(message, exclude=None)

    def add_to_history(self, message: dict):
        """Store a message in the history buffer (capped at MAX_HISTORY)."""
        self.message_history.append(message)
        if len(self.message_history) > self.MAX_HISTORY:
            self.message_history.pop(0)

    # ── Room-empty cleanup ──────────────────────────────────────────

    def start_cleanup_timer(self):
        """Start a timer to clear chat history after HISTORY_CLEAR_DELAY seconds.
        Called when the last user leaves the room."""
        self._cancel_cleanup_timer()
        loop = asyncio.get_event_loop()
        self._cleanup_timer = loop.call_later(
            self.HISTORY_CLEAR_DELAY, self._clear_history
        )
        print(f"[⏱] Room empty — history will clear in {self.HISTORY_CLEAR_DELAY}s")

    def _cancel_cleanup_timer(self):
        """Cancel the pending history-clear timer (e.g. someone joined back)."""
        if self._cleanup_timer is not None:
            self._cleanup_timer.cancel()
            self._cleanup_timer = None
            print("[⏱] Cleanup timer cancelled — someone rejoined")

    def _clear_history(self):
        """Wipe the message history (called by the timer callback)."""
        self._cleanup_timer = None
        self.message_history.clear()
        print("[🗑] Chat history cleared — new session starts")


# ---------------------------------------------------------------------------
# FastAPI Application
# ---------------------------------------------------------------------------

app = FastAPI(title="Group Chat Server")
manager = ConnectionManager()

# Allow requests from the frontend dev server
FRONTEND_PORT = int(os.environ.get("FRONTEND_PORT", 5000))
app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"http://localhost:{FRONTEND_PORT}", f"http://127.0.0.1:{FRONTEND_PORT}"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def timestamp() -> str:
    """Return the current time as an ISO format string."""
    return datetime.now().strftime("%H:%M:%S")


# ---------------------------------------------------------------------------
# WebSocket Endpoint
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """Handle a single client's full lifecycle: join → chat → leave."""
    await websocket.accept()
    username = None

    try:
        # ── Phase 1: Wait for the join message ──────────────────────────
        data = await websocket.receive_json()

        if data.get("type") != "join":
            await websocket.send_json({
                "type": "error",
                "message": "First message must be a join request."
            })
            await websocket.close(code=1008)
            return

        username = data.get("username", "").strip()
        avatar = data.get("avatar", "avatar-1")

        # Validate: non-empty
        if not username:
            await websocket.send_json({
                "type": "error",
                "message": "Username cannot be empty."
            })
            await websocket.close(code=1008)
            return

        # Validate: unique
        if manager.is_username_taken(username):
            await websocket.send_json({
                "type": "error",
                "message": f"Username '{username}' is already taken. Please choose another."
            })
            await websocket.close(code=1008)
            return

        # ── Phase 2: Register the user ──────────────────────────────────
        manager.add(websocket, username, avatar)
        print(f"[+] {username} ({avatar}) joined  |  Online: {len(manager.active_connections)}")

        # Send welcome to the joiner only
        await websocket.send_json({
            "type": "system",
            "message": f"Welcome to the chat, {username}!",
            "timestamp": timestamp()
        })

        # Notify all OTHER users about the new join
        await manager.broadcast({
            "type": "join",
            "username": username,
            "avatar": avatar,
            "message": f"{username} joined the chat",
            "timestamp": timestamp()
        }, exclude=websocket)

        # Send updated user list to EVERYONE (including the joiner)
        await manager.send_to_all({
            "type": "userList",
            "users": manager.get_all_users()
        })

        # Send message history to the new joiner only
        if manager.message_history:
            await websocket.send_json({
                "type": "history",
                "messages": manager.message_history
            })

        # ── Phase 3: Listen for chat messages ───────────────────────────
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "message":
                text = data.get("text", "").strip()
                if text:
                    msg = {
                        "type": "message",
                        "username": username,
                        "avatar": avatar,
                        "text": text,
                        "timestamp": timestamp()
                    }
                    # Store in history and broadcast to ALL
                    manager.add_to_history(msg)
                    await manager.send_to_all(msg)

            elif msg_type == "typing":
                # Relay typing indicator to all OTHER users
                await manager.broadcast({
                    "type": "typing",
                    "username": username
                }, exclude=websocket)

    except WebSocketDisconnect:
        # Client closed the connection normally
        pass
    except Exception as e:
        print(f"[!] Error for {username or 'unknown'}: {e}")
    finally:
        # ── Cleanup: remove user and notify others ──────────────────────
        if username and websocket in manager.active_connections:
            manager.remove(websocket)
            online = len(manager.active_connections)
            print(f"[-] {username} left    |  Online: {online}")

            # Notify remaining users
            await manager.broadcast({
                "type": "leave",
                "username": username,
                "message": f"{username} left the chat",
                "timestamp": timestamp()
            })

            # Send updated user list
            await manager.send_to_all({
                "type": "userList",
                "users": manager.get_all_users()
            })

            # If the room is now empty, start the history-clear countdown
            if online == 0:
                manager.start_cleanup_timer()




# ---------------------------------------------------------------------------
# Run with: python server.py
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("BACKEND_PORT", 8000))

    print("=" * 50)
    print("  Group Chat Server (Backend Only)")
    print(f"  WebSocket: ws://0.0.0.0:{port}/ws")
    print(f"  Frontend:  http://localhost:{FRONTEND_PORT} (separate server)")
    print("=" * 50)
    uvicorn.run(app, host="0.0.0.0", port=port)
