"""
Database layer for the Secure Persistent Group Chat.

Uses Python's built-in sqlite3 module.
Handles:
  - Message persistence (encrypted, with HMAC for tamper detection)
  - User public key registry (for ECDSA signature verification)
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
"""

# ── Initialisation ────────────────────────────────────────────────────────────

def init_db() -> None:
    """Create tables if they don't exist. Call once at server startup."""
    with _connect() as conn:
        conn.executescript(_SCHEMA)
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


# ── Message CRUD ──────────────────────────────────────────────────────────────

def save_message(
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
                (username, avatar, ciphertext, iv, signature, public_key, timestamp, hmac_digest, sig_valid)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
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


def get_history(limit: int = 50) -> list[dict]:
    """
    Return the last `limit` messages from the DB.
    Each row is enriched with a `tampered` flag (True if HMAC mismatch).
    """
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT username, avatar, ciphertext, iv, signature, public_key,
                   timestamp, hmac_digest, sig_valid
            FROM messages
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
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


def clear_history() -> None:
    """Delete all messages and user keys. Called when the room has been empty for a while."""
    with _connect() as conn:
        conn.execute("DELETE FROM messages")
        conn.execute("DELETE FROM user_keys")
    print("[DB] Message history and user keys cleared.")




