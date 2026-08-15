# Secure Persistent Group Chat — Implementation Details (Week 2)

This document details the security and persistence upgrades implemented in the group chat application to meet the mandatory lab requirements.

## 1. Features Available

- **Persistent Message Storage:** Messages are saved to a SQLite database and persist across server restarts.
- **Secure Chat History:** When joining, users receive the previous chat history loaded directly from the database.
- **End-to-End Encryption (AES-GCM):** Messages are never stored or transmitted in plaintext. The content is encrypted by the sender and decrypted by the receiver.
- **Tamper Detection (HMAC-SHA256):** The database is protected against modification. If a stored message is altered directly in the database, the server flags it as tampered when serving history, and a 🚨 TAMPERED badge is displayed on the client.
- **Non-Repudiation (Digital Signatures):** Every sender has a unique signing key pair. Messages are signed by the sender, and the signature is verified by both the server (before saving/broadcasting) and the receiving clients.
- **Security UI Badges:** Chat bubbles indicate the cryptographic status of messages (🔒 ✓ for verified, ⚠ for invalid signature, 🚨 for database tampering).

---

## 2. Technical Implementation & Logic

### A. SQLite Persistence & History
- **Library:** Python's built-in `sqlite3` module.
- **Logic:** We created a new abstraction layer (`server/db.py`). When a client joins, the server fetches the last 50 messages from the `messages` table and sends them down. When a user sends a message, it is inserted into the database. 
- **Database Schema:** We store the `username`, `ciphertext`, `iv`, `signature`, `public_key` (as a JSON string), `timestamp`, and `hmac_digest`.

### B. AES-GCM Encryption & Nonce Handling
- **Library:** Web Cryptography API (`crypto.subtle`) on the client frontend.
- **Key Management:** A single 256-bit AES symmetric key (`AES_GROUP_KEY`) is stored securely in the `.env` file. When the client loads, it performs a `GET /group-key` request to the server to fetch this key and imports it into SubtleCrypto.
- **Logic & Nonce:**
  - Before sending, the client generates a secure random 12-byte IV (nonce) using `crypto.getRandomValues()`.
  - The plaintext is encrypted using `AES-GCM` with the shared key and the generated IV.
  - The resulting ciphertext and IV are base64-encoded and sent over the WebSocket. No plaintext ever leaves the browser.
  - Upon receiving an encrypted message, clients use the same AES key and the provided IV to decrypt the ciphertext back into plaintext.

### C. Per-Sender Signing Keys & Digital Signatures
- **Library:** Web Cryptography API (`crypto.subtle`) on the client.
- **Logic:**
  - On startup, each client generates a unique, ephemeral ECDSA P-256 asymmetric key pair (`generateKey`).
  - The public key is exported in JWK (JSON Web Key) format and sent to the server in the initial `join` WebSocket payload.
  - When sending a message, the client creates a cryptographic signature over the concatenated string of `ciphertext + iv` using their ECDSA private key and SHA-256. This ensures the ciphertext hasn't been swapped or modified in transit.

### D. Signature Verification
- **Server-Side Library:** Python `cryptography` library.
- **Client-Side Library:** Web Cryptography API.
- **Logic:**
  - **Server:** When a message arrives, the server converts the sender's JWK public key into a format the Python `cryptography` library understands. It then verifies the ECDSA signature over the `ciphertext + iv`. If invalid, it logs a warning. (The validation result is also stored in the database).
  - **Client:** When a message is broadcast, receiving clients import the sender's public key (included in the payload) and verify the signature using `crypto.subtle.verify`. If valid, the message gets a 🔒 ✓ badge. If invalid or missing, it gets a ⚠ badge.

### E. Tamper Detection (Server-Side HMAC)
- **Library:** Python's built-in `hmac` and `hashlib` modules.
- **Key Management:** A 256-bit secret (`HMAC_SECRET`) is stored in the `.env` file.
- **Logic:**
  - When a message is saved to the SQLite database, the server computes an HMAC-SHA256 digest over the `ciphertext + iv` using the `HMAC_SECRET`. This digest is stored in the `hmac_digest` column.
  - When fetching history from the database, the server re-computes the HMAC for each row and compares it to the stored `hmac_digest`.
  - If they do not match (e.g., someone edited the `ciphertext` column using a DB browser), the server sets `tampered = True` in the history payload.
  - The frontend detects this flag and renders the message with a red border and a `🚨 TAMPERED` badge, warning users that the database integrity was compromised.
