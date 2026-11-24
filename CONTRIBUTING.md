# Contributing to FileTally

Thanks for helping improve FileTally. This document covers local setup, how we work on changes, and licensing notes.

## Build & run

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 20+
- Platform deps for Tauri 2 ([official guide](https://v2.tauri.app/start/prerequisites/))

### Frontend

```bash
npm install
npm run dev          # Vite only
npm run tauri:dev    # Desktop app with hot reload
npm run check        # TypeScript (tsc --noEmit)
npm run build        # Production frontend build
```

### Backend

```bash
cd src-tauri
cargo build
cargo test
```

Release builds:

```bash
npm run tauri:build
```

## Pull requests

1. Fork or branch from `main` (or the default integration branch).
2. Keep changes focused; match existing TypeScript/Rust style in touched files.
3. Run `npm run check` and relevant `cargo test` before opening a PR.
4. Describe **what** changed and **why**; note manual test steps for UI or Tauri commands.
5. Do not commit secrets, API keys, or machine-specific paths.
6. Prefer English or 中文 in commit messages and PR descriptions — be consistent within one PR.

## LGPL note

FileTally links against libraries under the **GNU Lesser General Public License (LGPL)** and related copyleft terms where applicable (see `src-tauri/Cargo.toml` and third-party notices in distributed builds).

If you distribute modified binaries:

- Comply with LGPL source/notice requirements for affected components.
- Document how users can obtain corresponding source and rebuild.
- Do not strip license files from release artifacts.

For questions about licensing in your environment, consult your legal counsel; this file is not legal advice.

## Code of conduct

Be respectful in issues and reviews. Report security issues privately to maintainers rather than in public issues when sensitive.