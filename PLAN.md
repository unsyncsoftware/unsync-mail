# Unsync Mail - Development Roadmap

## Phase 1: Local Foundation [X]
- [X] Initialize TypeScript config and folder structures.
- [X] Implement SQLite schema using `better-sqlite3`.
- [X] Write Full-Text Search (FTS5) utility functions.

## Phase 2: Cryptographic Engine [X]
- [X] Setup local user PGP keypair generation.
- [X] Create local text encryption/decryption utilities.
- [X] Write verification utility for 8-digit human safety numbers.

## Phase 3: Legacy Mail Protocols [X]
- [X] Implement IMAP sync runner to parse incoming streams.
- [X] Wire up mailparser to isolate incoming Unsync armor blocks.
- [X] Build SMTP outbound handler with an E2EE encryption toggle switch.

## Phase 4: Frontend Layout [X]
- [X] Structure the classic 3-pane minimalist UI layout.
- [X] Bind IPC channels to the backend database and crypto engine.

