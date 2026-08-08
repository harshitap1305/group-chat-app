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

## Tech Stack

| Layer      | Technology                  |
|------------|-----------------------------|
| Backend    | Python 3 + FastAPI + Uvicorn |
| Frontend   | HTML + CSS + JavaScript      |
| Protocol   | WebSockets (RFC 6455)        |

## Project Structure

```
group-chat-app/
├── server/
│   ├── requirements.txt    # Python dependencies
│   └── server.py           # FastAPI WebSocket server
├── client/
│   ├── index.html          # Chat UI
│   ├── style.css           # Dark theme styles
│   └── app.js              # WebSocket client logic
└── README.md               # This file
```

## Quick Start

### 1. Install Dependencies

```bash
cd server
pip install -r requirements.txt
```

### 2. Start the Server

```bash
python server.py
```

The server starts on `http://0.0.0.0:8000` and serves both the WebSocket endpoint and the frontend.

### 3. Open in Browser

Open `http://localhost:8000` (or `http://<server-ip>:8000` from other machines on the same network).

## Lab Deployment (4 Machines)

1. **Machine 1** (Server): Run `python server.py` — note its IP address (`ipconfig` on Windows, `ip addr` on Linux)
2. **Machines 1–4** (Clients): Open `http://<machine-1-ip>:8000` in a browser
3. Each user enters a unique username and joins the chat

## Architecture

```
┌──────────────────────────────────────────────┐
│          FastAPI Server (Machine 1)          │
│                                              │
│  ┌──────────────┐    ┌───────────────────┐   │
│  │  Static File  │    │  WebSocket /ws    │   │
│  │  Serving      │    │                   │   │
│  │  (HTML/CSS/JS)│    │  ConnectionManager│   │
│  └──────────────┘    │  ├─ broadcast()   │   │
│                       │  ├─ add/remove()  │   │
│                       │  └─ user tracking │   │
│                       └───────────────────┘   │
└──────────┬───────────────────┬────────────────┘
           │                   │
     HTTP GET /          WS /ws
           │                   │
    ┌──────┴──────┐     ┌──────┴──────┐
    │  Browser 1  │     │  Browser 2  │  ... (up to 4)
    │  (Client)   │     │  (Client)   │
    └─────────────┘     └─────────────┘
```

## Message Protocol

All messages are JSON with a `type` field:

### Client → Server
| Type      | Fields     | Description              |
|-----------|------------|--------------------------|
| `join`    | `username` | Register with a username |
| `message` | `text`     | Send a chat message      |

### Server → Client
| Type       | Fields                       | Description                |
|------------|------------------------------|----------------------------|
| `system`   | `message`, `timestamp`       | System notification        |
| `join`     | `username`, `message`, `timestamp` | User joined notification |
| `leave`    | `username`, `message`, `timestamp` | User left notification   |
| `message`  | `username`, `text`, `timestamp`    | Chat message broadcast   |
| `userList` | `users`                      | Current online users list  |
| `error`    | `message`                    | Error (e.g., username taken) |

## Team

| Member | Role |
|--------|------|
| Member 1 | Group Head / Backend |
| Member 2 | Frontend |
| Member 3 | Testing |
| Member 4 | Documentation |
