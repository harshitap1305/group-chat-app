# Group Chat Application

A real-time group chat application built with **FastAPI WebSockets** (Python) and **Vanilla HTML/CSS/JS**.

## Features

- ✅ Real-time message broadcasting to all connected users
- ✅ User join/leave notifications
- ✅ Unique usernames for identifying participants
- ✅ Graceful handling of client disconnections
- ✅ Auto-reconnect with exponential backoff
- ✅ Online users sidebar (live-updating)
- ✅ Connection status indicator
- ✅ Premium dark-themed UI with animations
- ✅ Separated frontend & backend servers with configurable ports

## Tech Stack

| Layer      | Technology                  |
|------------|------------------------------|
| Backend    | Python 3 + FastAPI + Uvicorn |
| Frontend   | HTML + CSS + JavaScript      |
| Protocol   | WebSockets (RFC 6455)        |

## Project Structure

```
group-chat-app/
├── .env                    # Local port configuration (not committed)
├── .env.example            # Template — copy this to create .env
├── server/
│   ├── requirements.txt    # Python dependencies
│   └── server.py           # FastAPI WebSocket server (port 8000)
├── client/
│   ├── index.html          # Chat UI
│   ├── style.css           # Dark theme styles
│   ├── app.js              # WebSocket client logic
│   └── serve.py            # Static file server for frontend (port 5000)
└── README.md               # This file
```

## Environment Configuration

The app uses a `.env` file at the project root to configure ports separately for the frontend and backend.

### 1. Create your `.env` file

Copy the provided example and adjust ports if needed:

```bash
cp .env.example .env
```

The default `.env.example` looks like:

```env
# Backend (FastAPI WebSocket server)
BACKEND_PORT=8000

# Frontend (static file server)
FRONTEND_PORT=5000
```

> **Note:** Never commit your `.env` file — it is already listed in `.gitignore`.

---

## Quick Start

### 1. Install Dependencies

```bash
cd server
pip install -r requirements.txt
```

### 2. Set Up Environment

```bash
# From the project root
cp .env.example .env
```

Edit `.env` if you need different ports.

### 3. Start the Backend (Terminal 1)

```bash
cd server
python3 server.py
```

The backend starts on `ws://0.0.0.0:8000/ws` and handles all WebSocket connections.

### 4. Start the Frontend (Terminal 2)

```bash
cd client
python3 serve.py
```

The frontend server starts on `http://0.0.0.0:5000` and serves the static HTML/CSS/JS files.

### 5. Open in Browser

```
http://localhost:5000
```

The frontend automatically connects to the backend WebSocket at `ws://localhost:8000/ws`.

---

## Lab Deployment (4 Machines)

1. **Machine 1** (Server): Run both `server.py` and `serve.py` — note its IP address (`ip addr` on Linux)
2. **Machines 1–4** (Clients): Open `http://<machine-1-ip>:5000` in a browser
3. Each user enters a unique username and joins the chat

> The WebSocket in `app.js` uses `window.location.hostname` + backend port `8000`, so clients will automatically connect to the correct backend host.

---

## Architecture

```
┌───────────────────────────────────────────────────────┐
│                  Machine 1 (Server)                   │
│                                                       │
│  ┌──────────────────────┐  ┌────────────────────────┐ │
│  │  Frontend Server     │  │  Backend Server         │ │
│  │  client/serve.py     │  │  server/server.py       │ │
│  │  http://0.0.0.0:5000 │  │  ws://0.0.0.0:8000/ws  │ │
│  │                      │  │                        │ │
│  │  Serves:             │  │  ConnectionManager:    │ │
│  │  index.html          │  │  ├─ broadcast()        │ │
│  │  style.css           │  │  ├─ add/remove()       │ │
│  │  app.js              │  │  └─ user tracking      │ │
│  └──────────────────────┘  └────────────────────────┘ │
└───────────────┬──────────────────────┬────────────────┘
                │                      │
         HTTP :5000              WS :8000/ws
                │                      │
        ┌───────┴───────┐      ┌───────┴───────┐
        │   Browser 1   │      │   Browser 2   │  ...
        │   (Client)    │      │   (Client)    │
        └───────────────┘      └───────────────┘
```

---

## Message Protocol

All messages are JSON with a `type` field:

### Client → Server
| Type      | Fields     | Description              |
|-----------|------------|--------------------------|
| `join`    | `username` | Register with a username |
| `message` | `text`     | Send a chat message      |
| `typing`  | —          | Signal that user is typing |

### Server → Client
| Type       | Fields                             | Description                   |
|------------|------------------------------------|-------------------------------|
| `system`   | `message`, `timestamp`             | System notification           |
| `join`     | `username`, `message`, `timestamp` | User joined notification      |
| `leave`    | `username`, `message`, `timestamp` | User left notification        |
| `message`  | `username`, `text`, `timestamp`    | Chat message broadcast        |
| `userList` | `users`                            | Current online users list     |
| `history`  | `messages`                         | Recent message history        |
| `error`    | `message`                          | Error (e.g., username taken)  |

---

## Team

| Member | Role |
|--------|------|
| Member 1 | Group Head / Backend |
| Member 2 | Frontend |
| Member 3 | Testing |
| Member 4 | Documentation |
