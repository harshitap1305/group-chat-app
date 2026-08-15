"""
Database layer for the Secure Persistent Group Chat.

Uses Python's built-in sqlite3 module.
Handles:
  - Message persistence (encrypted, with HMAC for tamper detection)
  - User public key registry (for ECDSA signature verification)
  - Chat room management (rooms identified by unique 6-char codes)
"""

import sqlite3
import hmac
import hashlib
import os
import json
from pathlib import Path
from datetime import datetime

# ── Config ────────────────────────────────────────────────────────────────────

DB_PATH = Path(__file__).resolve().parent / "chat.db"

# HMAC_SECRET loaded from environment (set in .env, never hardcoded)
def _get_hmac_secret() -> bytes:
    secret = os.environ.get("HMAC_SECRET", "")
    if not secret:
        raise RuntimeError(
            "HMAC_SECRET is not set in .env — cannot start server safely."
        )
    return bytes.fromhex(secret)


# ── Schema ────────────────────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id     TEXT    NOT NULL DEFAULT 'default',
    username    TEXT    NOT NULL,
    avatar      TEXT    NOT NULL DEFAULT 'wizard',
    ciphertext  TEXT    NOT NULL,   -- base64 AES-GCM ciphertext
    iv          TEXT    NOT NULL,   -- base64 12-byte IV
    signature   TEXT    NOT NULL,   -- base64 ECDSA-P256 signature
    public_key  TEXT    NOT NULL,   -- JSON JWK of sender's ECDSA public key
    timestamp   TEXT    NOT NULL,
    hmac_digest TEXT    NOT NULL,   -- HMAC-SHA256(ciphertext || iv) for tamper detection
    sig_valid   INTEGER NOT NULL DEFAULT 1  -- 1=valid, 0=invalid (recorded at receive time)
);

CREATE TABLE IF NOT EXISTS user_keys (
    username    TEXT PRIMARY KEY,
    public_key  TEXT NOT NULL        -- JSON JWK
);

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,   -- bcrypt hash
    avatar        TEXT    NOT NULL DEFAULT 'wizard',
    created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
    id          TEXT    PRIMARY KEY,              -- 6-char alphanumeric code e.g. "XKJ3P9"
    name        TEXT    NOT NULL,
    created_by  TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    is_public   INTEGER NOT NULL DEFAULT 1,       -- 1=public (browsable), 0=private (code-only)
    avatar      TEXT    NOT NULL DEFAULT '🏰'
);
"""

# ── Migration helpers ─────────────────────────────────────────────────────────

def _apply_migrations(conn: sqlite3.Connection) -> None:
    """Add columns that may not exist in older DB versions."""
    cursor = conn.execute("PRAGMA table_info(messages)")
    columns = {row[1] for row in cursor.fetchall()}
    if "room_id" not in columns:
        conn.execute("ALTER TABLE messages ADD COLUMN room_id TEXT NOT NULL DEFAULT 'default'")
        print("[DB] Migration: added room_id column to messages")

    cursor = conn.execute("PRAGMA table_info(rooms)")
    columns = {row[1] for row in cursor.fetchall()}
    if "avatar" not in columns:
        conn.execute("ALTER TABLE rooms ADD COLUMN avatar TEXT NOT NULL DEFAULT '🏰'")
        print("[DB] Migration: added avatar column to rooms")


# ── Initialisation ────────────────────────────────────────────────────────────

def init_db() -> None:
    """Create tables if they don't exist. Call once at server startup."""
    with _connect() as conn:
        conn.executescript(_SCHEMA)
        _apply_migrations(conn)
    print(f"[DB] Initialised — {DB_PATH}")


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


# ── HMAC helpers ──────────────────────────────────────────────────────────────

def _compute_hmac(ciphertext: str, iv: str) -> str:
    """
    Compute HMAC-SHA256 over (ciphertext + iv) using HMAC_SECRET from .env.
    Returns the hex digest.
    """
    secret = _get_hmac_secret()
    payload = (ciphertext + iv).encode("utf-8")
    return hmac.new(secret, payload, hashlib.sha256).hexdigest()


def _verify_hmac(ciphertext: str, iv: str, stored_digest: str) -> bool:
    """Re-compute HMAC and compare with stored digest. Returns True if intact."""
    expected = _compute_hmac(ciphertext, iv)
    return hmac.compare_digest(expected, stored_digest)


# ── Room CRUD ─────────────────────────────────────────────────────────────────

def create_room(room_id: str, name: str, created_by: str, is_public: bool = True, avatar: str = "🏰") -> None:
    """
    Insert a new room into the rooms table.
    Raises sqlite3.IntegrityError if the room_id already exists.
    """
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO rooms (id, name, created_by, created_at, is_public, avatar)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (room_id, name, created_by, datetime.now().strftime("%Y-%m-%d %H:%M:%S"), 1 if is_public else 0, avatar),
        )


def get_room(room_id: str) -> dict | None:
    """Retrieve a room by its code. Returns dict or None."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, name, created_by, created_at, is_public, avatar FROM rooms WHERE id = ?",
            (room_id,),
        ).fetchone()
    if row is None:
        return None
    return {
        "id":         row["id"],
        "name":       row["name"],
        "created_by": row["created_by"],
        "created_at": row["created_at"],
        "is_public":  bool(row["is_public"]),
        "avatar":     row["avatar"],
    }


def list_rooms() -> list[dict]:
    """Return all public rooms (ordered newest first)."""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT id, name, created_by, created_at, is_public, avatar
            FROM rooms
            WHERE is_public = 1
            ORDER BY created_at DESC
            """,
        ).fetchall()
    return [
        {
            "id":         row["id"],
            "name":       row["name"],
            "created_by": row["created_by"],
            "created_at": row["created_at"],
            "is_public":  bool(row["is_public"]),
            "avatar":     row["avatar"],
        }
        for row in rows
    ]


# ── Message CRUD ──────────────────────────────────────────────────────────────

def save_message(
    room_id: str,
    username: str,
    avatar: str,
    ciphertext: str,
    iv: str,
    signature: str,
    public_key: dict,
    timestamp: str,
    sig_valid: bool,
) -> int:
    """
    Persist an encrypted, signed message to the DB.
    Computes and stores HMAC for future tamper detection.
    Returns the new row id.
    """
    hmac_digest = _compute_hmac(ciphertext, iv)
    pub_key_json = json.dumps(public_key)

    with _connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO messages
                (room_id, username, avatar, ciphertext, iv, signature, public_key, timestamp, hmac_digest, sig_valid)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                room_id,
                username,
                avatar,
                ciphertext,
                iv,
                signature,
                pub_key_json,
                timestamp,
                hmac_digest,
                1 if sig_valid else 0,
            ),
        )
        return cur.lastrowid


def get_history(room_id: str, limit: int = 50) -> list[dict]:
    """
    Return the last `limit` messages for a given room.
    Each row is enriched with a `tampered` flag (True if HMAC mismatch).
    """
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT username, avatar, ciphertext, iv, signature, public_key,
                   timestamp, hmac_digest, sig_valid
            FROM messages
            WHERE room_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (room_id, limit),
        ).fetchall()

    messages = []
    for row in reversed(rows):  # chronological order
        tampered = not _verify_hmac(row["ciphertext"], row["iv"], row["hmac_digest"])
        messages.append(
            {
                "type": "message",
                "username": row["username"],
                "avatar": row["avatar"],
                "ciphertext": row["ciphertext"],
                "iv": row["iv"],
                "signature": row["signature"],
                "public_key": json.loads(row["public_key"]),
                "timestamp": row["timestamp"],
                "sig_valid": bool(row["sig_valid"]),
                "tampered": tampered,
            }
        )
    return messages


# ── User key registry ─────────────────────────────────────────────────────────

def register_user_key(username: str, public_key: dict) -> None:
    """Store or update a user's ECDSA public key (JWK dict)."""
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO user_keys (username, public_key)
            VALUES (?, ?)
            ON CONFLICT(username) DO UPDATE SET public_key = excluded.public_key
            """,
            (username, json.dumps(public_key)),
        )


def get_user_key(username: str) -> dict | None:
    """Retrieve a user's registered ECDSA public key, or None if not found."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT public_key FROM user_keys WHERE username = ?", (username,)
        ).fetchone()
    return json.loads(row["public_key"]) if row else None


# ── Persistent user accounts ───────────────────────────────────────────────────

def create_user(username: str, password_hash: str, avatar: str) -> None:
    """
    Insert a new user into the users table.
    Raises sqlite3.IntegrityError if the username is already taken (UNIQUE constraint).
    """
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO users (username, password_hash, avatar, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (username, password_hash, avatar, datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
        )


def get_user(username: str) -> dict | None:
    """
    Retrieve a user row by username (case-insensitive).
    Returns { id, username, password_hash, avatar } or None if not found.
    """
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, username, password_hash, avatar FROM users WHERE username = ? COLLATE NOCASE",
            (username,),
        ).fetchone()
    if row is None:
        return None
    return {
        "id":            row["id"],
        "username":      row["username"],
        "password_hash": row["password_hash"],
        "avatar":        row["avatar"],
    }


def clear_room_history(room_id: str) -> None:
    """Delete all messages for a specific room. Called when the room has been empty for a while."""
    with _connect() as conn:
        conn.execute("DELETE FROM messages WHERE room_id = ?", (room_id,))
    print(f"[DB] Room '{room_id}' message history cleared.")


def clear_history() -> None:
    """Delete ALL messages and user keys. Legacy fallback."""
    with _connect() as conn:
        conn.execute("DELETE FROM messages")
        conn.execute("DELETE FROM user_keys")
    print("[DB] All message history and user keys cleared.")
