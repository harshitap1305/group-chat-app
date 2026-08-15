"""
Secure Persistent Group Chat — Server
======================================
Extends the original WebSocket group chat with:
  - SQLite-backed message persistence (encrypted at rest)
  - AES-GCM symmetric encryption (key served from .env via /group-key)
  - Per-user ECDSA-P256 signing key pairs (server verifies every message)
  - HMAC-SHA256 database tamper detection
"""

import json
import asyncio
import os
import uuid
import shutil
import base64
import hmac
import hashlib
import secrets
import sqlite3
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import bcrypt
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# cryptography library — ECDSA verification
from cryptography.hazmat.primitives.asymmetric.ec import (
    ECDSA,
    EllipticCurvePublicKey,
    SECP256R1,
    EllipticCurvePublicNumbers,
)
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.backends import default_backend
from cryptography.exceptions import InvalidSignature

import db  # local module — server/db.py


# ── Environment ───────────────────────────────────────────────────────────────

def _require_env(key: str) -> str:
    value = os.environ.get(key, "").strip()
    if not value:
        raise RuntimeError(
            f"Required environment variable '{key}' is not set in .env"
        )
    return value


AES_GROUP_KEY_HEX: str = _require_env("AES_GROUP_KEY")   # 64 hex chars = 32 bytes
HMAC_SECRET_HEX: str   = _require_env("HMAC_SECRET")     # 64 hex chars = 32 bytes


# ── ECDSA helpers ─────────────────────────────────────────────────────────────

def _jwk_to_public_key(jwk: dict) -> EllipticCurvePublicKey:
    """
    Convert a JWK (P-256, EC) dict exported by the browser's SubtleCrypto
    into a cryptography library EllipticCurvePublicKey.
    """
    def _b64url_to_int(b64url: str) -> int:
        # Add padding if needed
        padded = b64url + "=" * (-len(b64url) % 4)
        return int.from_bytes(base64.urlsafe_b64decode(padded), "big")

    x = _b64url_to_int(jwk["x"])
    y = _b64url_to_int(jwk["y"])
    numbers = EllipticCurvePublicNumbers(x=x, y=y, curve=SECP256R1())
    return numbers.public_key(default_backend())


def verify_ecdsa_signature(plaintext_bytes: bytes, sig_b64: str, jwk: dict) -> bool:
    """
    Verify an ECDSA-P256/SHA-256 signature.
    `sig_b64`  — base64-encoded DER signature produced by SubtleCrypto.sign()
    `plaintext_bytes` — the original bytes that were signed
    Returns True if valid, False on any error.
    """
    try:
        pub_key = _jwk_to_public_key(jwk)
        # SubtleCrypto outputs the signature in IEEE P1363 format (r||s, 64 bytes).
        # cryptography library expects DER, so we must convert.
        padded = sig_b64 + "=" * (-len(sig_b64) % 4)
        sig_bytes = base64.urlsafe_b64decode(padded)

        if len(sig_bytes) == 64:
            # P1363 → DER
            r = int.from_bytes(sig_bytes[:32], "big")
            s = int.from_bytes(sig_bytes[32:], "big")
            from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
            sig_der = encode_dss_signature(r, s)
        else:
            sig_der = sig_bytes  # already DER

        pub_key.verify(sig_der, plaintext_bytes, ECDSA(hashes.SHA256()))
        return True
    except (InvalidSignature, Exception):
        return False


# ── ConnectionManager ─────────────────────────────────────────────────────────

class ConnectionManager:
    """Manages active WebSocket connections and broadcasting."""

    def __init__(self):
        self.active_connections: dict[WebSocket, dict] = {}

    def add(self, websocket: WebSocket, username: str, avatar: str = "avatar-1"):
        self.active_connections[websocket] = {
            "username": username,
            "avatar": avatar,
        }

    def remove(self, websocket: WebSocket) -> str | None:
        info = self.active_connections.pop(websocket, None)
        return info["username"] if info else None

    def get_username(self, websocket: WebSocket) -> str | None:
        info = self.active_connections.get(websocket)
        return info["username"] if info else None

    def get_avatar(self, websocket: WebSocket) -> str:
        info = self.active_connections.get(websocket)
        return info["avatar"] if info else "avatar-1"

    def get_all_users(self) -> list[dict]:
        users = list(self.active_connections.values())
        return sorted(users, key=lambda x: x["username"].lower())

    def is_username_taken(self, username: str) -> bool:
        return username.lower() in [
            info["username"].lower() for info in self.active_connections.values()
        ]

    async def broadcast(self, message: dict, exclude: WebSocket | None = None) -> int:
        """Send JSON to all clients (optionally excluding one). Returns delivery count."""
        disconnected = []
        delivered = 0
        for ws in self.active_connections:
            if ws != exclude:
                try:
                    await ws.send_json(message)
                    delivered += 1
                except Exception:
                    disconnected.append(ws)
        for ws in disconnected:
            self.active_connections.pop(ws, None)
        return delivered

    async def send_to_all(self, message: dict) -> int:
        return await self.broadcast(message, exclude=None)


# ── FastAPI App ───────────────────────────────────────────────────────────────

app = FastAPI(title="Secure Group Chat Server")
manager = ConnectionManager()

# Uploads directory
UPLOAD_DIR = Path(__file__).resolve().parent / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

# CORS — allow all for lab purposes
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_PORT = int(os.environ.get("FRONTEND_PORT", 3000))
CLEANUP_TIMEOUT = int(os.environ.get("CLEANUP_TIMEOUT", 300))
cleanup_task: asyncio.Task | None = None

# ── Session store ──────────────────────────────────────────────────────────
# Maps one-time token → { username, avatar }
# Tokens are issued by /register and /login, consumed once by the WebSocket join.
active_sessions: dict[str, dict] = {}


# ── Request models ──────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    username: str
    password: str
    avatar:   str = "wizard"

class LoginRequest(BaseModel):
    username: str
    password: str


@app.on_event("startup")
async def startup():
    """Initialise the SQLite database on server start."""
    db.init_db()


# ── Auth Endpoints ────────────────────────────────────────────────────────────

@app.post("/register")
async def register(req: RegisterRequest):
    """
    Create a new user account.
    Hashes the password with bcrypt, saves to DB, returns a one-time session token.
    """
    username = req.username.strip()
    password = req.password
    avatar   = req.avatar

    if not username or len(username) > 20:
        raise HTTPException(status_code=400, detail="Username must be 1-20 characters.")
    if not username.replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Username may only contain letters, numbers, and underscores.")
    if not password or len(password) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters.")

    pw_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    try:
        db.create_user(username, pw_hash, avatar)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail=f"Username '{username}' is already taken.")

    token = secrets.token_hex(32)
    active_sessions[token] = {"username": username, "avatar": avatar}
    print(f"[Auth] Registered: {username} ({avatar})")
    return {"token": token, "avatar": avatar}


@app.post("/login")
async def login(req: LoginRequest):
    """
    Authenticate an existing user.
    Verifies bcrypt hash, returns a one-time session token.
    """
    username = req.username.strip()
    password = req.password

    user = db.get_user(username)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    if not bcrypt.checkpw(password.encode("utf-8"), user["password_hash"].encode("utf-8")):
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    token = secrets.token_hex(32)
    active_sessions[token] = {"username": user["username"], "avatar": user["avatar"]}
    print(f"[Auth] Login: {user['username']} ({user['avatar']})")
    return {"token": token, "avatar": user["avatar"]}


# ── REST Endpoints ────────────────────────────────────────────────────────────

@app.get("/group-key")
async def get_group_key():
    """
    Return the AES-GCM group key (hex string) loaded from .env.
    Clients fetch this once on load to initialise SubtleCrypto.
    In production this endpoint should be protected by authentication.
    """
    return {"key": AES_GROUP_KEY_HEX}


@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """Handle file upload and return attachment metadata."""
    try:
        ext = Path(file.filename).suffix if file.filename else ""
        unique_name = f"{uuid.uuid4().hex}{ext}"
        file_path = UPLOAD_DIR / unique_name

        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        file_size = file_path.stat().st_size
        return {
            "url": f"/uploads/{unique_name}",
            "fileName": file.filename or "file",
            "fileType": file.content_type or "application/octet-stream",
            "fileSize": file_size,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"File upload failed: {str(e)}")


# ── Helpers ───────────────────────────────────────────────────────────────────

def timestamp() -> str:
    return datetime.now().strftime("%H:%M:%S")


# ── WebSocket Endpoint ────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """Handle a single client's full lifecycle: join → chat → leave."""
    await websocket.accept()
    username = None

    try:
        # ── Wait for join message ────────────────────────────────────────
        data = await websocket.receive_json()

        if data.get("type") != "join":
            await websocket.send_json({
                "type": "error",
                "message": "First message must be a join request.",
            })
            await websocket.close(code=1008)
            return

        # ── Token-based auth (replaces bare username join) ─────────────────
        token   = data.get("token", "").strip()
        pub_key = data.get("public_key")

        session = active_sessions.pop(token, None)  # consume token (one-time use)
        if not session:
            await websocket.send_json({
                "type":    "error",
                "message": "Invalid or expired session token. Please log in again.",
            })
            await websocket.close(code=1008)
            return

        username = session["username"]
        avatar   = session["avatar"]

        # ── Register user ────────────────────────────────────────────────
        global cleanup_task
        if cleanup_task and not cleanup_task.done():
            cleanup_task.cancel()
            cleanup_task = None
            print("[*] User joined — cancelled room history cleanup timer.")

        manager.add(websocket, username, avatar)
        db.register_user_key(username, pub_key)
        print(f"[+] {username} ({avatar}) joined | Online: {len(manager.active_connections)}")

        # Welcome message to joiner
        await websocket.send_json({
            "type": "system",
            "message": f"Welcome to the chat, {username}!",
            "timestamp": timestamp(),
        })

        # Notify others
        await manager.broadcast({
            "type": "join",
            "username": username,
            "avatar": avatar,
            "message": f"{username} joined the chat",
            "timestamp": timestamp(),
        }, exclude=websocket)

        # Updated user list to everyone
        await manager.send_to_all({
            "type": "userList",
            "users": manager.get_all_users(),
        })

        # Send DB-backed history to the new joiner
        history = db.get_history(limit=50)
        if history:
            await websocket.send_json({
                "type": "history",
                "messages": history,
            })

        # ── Message loop ─────────────────────────────────────────────────
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            # ── Chat message ─────────────────────────────────────────────
            if msg_type == "message":
                ciphertext  = data.get("ciphertext", "")
                iv          = data.get("iv", "")
                signature   = data.get("signature", "")
                sender_key  = data.get("public_key") or db.get_user_key(username) or {}
                client_msg_id = data.get("client_msg_id", "")
                attachment  = data.get("attachment")

                if not ciphertext or not iv or not signature:
                    # Malformed message — skip
                    continue

                # ── Verify ECDSA signature server-side ───────────────────
                # The client signs the plaintext payload before encrypting.
                # We receive the signature and public key; the signed bytes
                # are the UTF-8 encoding of the canonical plaintext JSON.
                # Because we can't decrypt on the server (key is client-side),
                # we verify the signature over the ciphertext+iv concatenation
                # as the signed material (deterministic, available server-side).
                signed_material = (ciphertext + iv).encode("utf-8")
                sig_valid = verify_ecdsa_signature(signed_material, signature, sender_key)

                if not sig_valid:
                    print(f"[!] Invalid signature from {username}")

                # ── Persist to DB ─────────────────────────────────────────
                if ciphertext:
                    db.save_message(
                        username   = username,
                        avatar     = avatar,
                        ciphertext = ciphertext,
                        iv         = iv,
                        signature  = signature,
                        public_key = sender_key,
                        timestamp  = timestamp(),
                        sig_valid  = sig_valid,
                    )

                # ── Broadcast encrypted message ───────────────────────────
                msg = {
                    "type":       "message",
                    "username":   username,
                    "avatar":     avatar,
                    "ciphertext": ciphertext,
                    "iv":         iv,
                    "signature":  signature,
                    "public_key": sender_key,
                    "timestamp":  timestamp(),
                    "sig_valid":  sig_valid,
                    "attachment": attachment,
                }
                delivered = await manager.send_to_all(msg)

                # ── Delivery receipt ──────────────────────────────────────
                others_reached = delivered - 1
                total_others   = len(manager.active_connections) - 1
                if total_others <= 0:
                    receipt_status = "sent"
                elif others_reached >= total_others:
                    receipt_status = "delivered_all"
                else:
                    receipt_status = "partial"

                await websocket.send_json({
                    "type":   "receipt",
                    "msg_id": client_msg_id,
                    "status": receipt_status,
                })

            # ── Typing indicator ──────────────────────────────────────────
            elif msg_type == "typing":
                await manager.broadcast({
                    "type":     "typing",
                    "username": username,
                }, exclude=websocket)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[!] Error for {username or 'unknown'}: {e}")
    finally:
        if username and websocket in manager.active_connections:
            manager.remove(websocket)
            online = len(manager.active_connections)
            print(f"[-] {username} left | Online: {online}")

            if online == 0:
                async def _empty_room_cleanup():
                    try:
                        await asyncio.sleep(CLEANUP_TIMEOUT)
                        if len(manager.active_connections) == 0:
                            db.clear_history()
                            print(f"[!] Room empty for {CLEANUP_TIMEOUT}s — message history auto-cleared.")
                    except asyncio.CancelledError:
                        pass

                if cleanup_task and not cleanup_task.done():
                    cleanup_task.cancel()
                cleanup_task = asyncio.create_task(_empty_room_cleanup())
                print(f"[*] Room is empty — scheduled {CLEANUP_TIMEOUT}s history cleanup timer.")

            await manager.broadcast({
                "type":     "leave",
                "username": username,
                "message":  f"{username} left the chat",
                "timestamp": timestamp(),
            })
            await manager.send_to_all({
                "type":  "userList",
                "users": manager.get_all_users(),
            })


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("BACKEND_PORT", 5000))

    print("=" * 50)
    print("  Secure Group Chat Server")
    print(f"  WebSocket : wss://0.0.0.0:{port}/ws")
    print(f"  Group Key : GET https://0.0.0.0:{port}/group-key")
    print(f"  Frontend  : https://localhost:{FRONTEND_PORT}")
    print("=" * 50)
    BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        ssl_keyfile=os.path.join(BASE_DIR, "key.pem"),
        ssl_certfile=os.path.join(BASE_DIR, "cert.pem")
    )
