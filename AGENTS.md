# Unsync Mail - Agent Rules

## System Architecture
- **Type:** Local-First Desktop App.
- **Backend:** Node.js / TypeScript.
- **Database:** Local SQLite (`better-sqlite3`) utilizing FTS5 for search.
- **Privacy Core:** End-to-End Encryption using OpenPGP (`openpgp`).

## Strict Boundaries
1. **Zero-Knowledge Data Policy:** Under no circumstances should the user's private keys, unencrypted email payloads, or raw credentials ever be exposed to external APIs or synchronized to a cloud server.
2. **Offline-First:** All emails must be cached locally in SQLite. The interface must load and allow searching completely offline.
3. **No File Overwrites:** Before rewriting an entire file, analyze the existing functions to preserve local progress.