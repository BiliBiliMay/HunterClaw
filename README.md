<p align="center">
  <img src="./public/hunterclaw-logo.svg" alt="HunterClaw logo" width="220" />
</p>

<h1 align="center">HunterClaw</h1>

<p align="center">
  A local-first coding agent MVP with a Next.js UI, shared SQLite memory, approval-gated tools, and a matching terminal CLI.
</p>

## Overview

HunterClaw is a lightweight agent app for inspecting repositories, running local tools, and making controlled code changes on your machine.

It exposes the same core agent loop through:

- a web chat UI
- a terminal CLI
- direct HTTP endpoints

Messages, summaries, approval requests, and tool execution history are stored locally in SQLite so every interface can continue the same conversation.

## Highlights

- Local-first workflow with SQLite-backed persistence
- Next.js App Router UI with streaming responses and approval cards
- Terminal CLI that shares the same conversations and memory as the web app
- Tooling for files, code edits, shell access, and browser automation
- Approval flow for medium and high-risk actions
- OpenAI-compatible provider integration through the `openai` SDK

## Stack

- Next.js 15
- React 19
- TypeScript
- Tailwind CSS
- SQLite
- Drizzle ORM
- Playwright
- Zod

## Requirements

- Node.js 20+
- npm
- A machine that can run Playwright Chromium
- An API key for an OpenAI-compatible provider if you use `LLM_PROVIDER=api`

## Quick Start

```bash
npm install
cp .env.example .env.local
npm run db:setup
npm run playwright:install
npm run dev
```

Open the local URL printed by Next.js, usually `http://localhost:3000`.

## Configuration

The working provider path today is `api`.

Minimal `.env.local` example:

```bash
AGENT_DB_PATH=./data/agent.db
AGENT_FS_ROOT=.
AUTO_APPROVE_FILE_WRITES=false
LLM_PROVIDER=api
LLM_API_KEY=your_key_here
LLM_API_MODEL=qwen3-max-2026-01-23
LLM_API_BASE_URL=
```

Notes:

- `AGENT_FS_ROOT` controls the default workspace for relative file access and shell commands.
- Reads inside `AGENT_FS_ROOT` are low risk.
- Writes usually require approval unless `AUTO_APPROVE_FILE_WRITES=true`.
- A `codex` provider stub exists in the codebase, but it is not implemented yet.

## Run Modes

### Web UI

```bash
npm run dev
```

Use the browser UI for streaming responses, approval cards, conversation switching, and token usage tracking.

### Terminal CLI

```bash
npm run agent:cli
```

Useful commands inside the CLI:

- `/new`
- `/conversations`
- `/switch <index|conversation-id>`
- `/retry <toolExecutionId>`
- `/help`
- `/exit`

One-shot usage is also supported:

```bash
npm run agent:cli -- --conversation bugfix "inspect this repo and explain the architecture"
```

### HTTP API

Start the app first, then call the routes directly.

Streaming chat example:

```bash
curl -N -X POST http://localhost:3000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"default","message":"inspect this repo and explain how the agent loop works"}'
```

Core routes:

- `GET /api/conversations`
- `POST /api/conversations`
- `GET /api/history`
- `POST /api/chat`
- `POST /api/chat/stream`
- `POST /api/approve`
- `POST /api/approve/stream`
- `GET /api/preferences`

## Scripts

- `npm run dev` - start the Next.js dev server
- `npm run build` - create a production build
- `npm run start` - run the production server
- `npm test` - run the test suite
- `npm run typecheck` - run TypeScript checks
- `npm run db:setup` - create the SQLite database and sample workspace content
- `npm run agent:cli` - launch the terminal agent
- `npm run playwright:install` - install Chromium for the browser tool

## Safety Model

- Low-risk reads inside `AGENT_FS_ROOT` can run automatically.
- File writes are approval-gated by default.
- Shell access is read-only and dangerous commands are blocked.
- Browser `click` and `type` actions require approval.
- Access outside `AGENT_FS_ROOT` is treated as higher risk.

## Project Layout

```text
app/                 Next.js app router, UI, and API routes
components/chat/     Chat UI rendering and code preview components
lib/agent/           Agent loop, memory, safety, and presentation logic
lib/llm/             Provider integration and decision parsing
lib/tools/           File, code, shell, and browser tools
lib/db/              SQLite client and schema
scripts/             CLI and database setup scripts
tests/               Focused tests for tools, safety, DB, and agent flow
data/                SQLite database and optional sample workspace files
public/              Static assets, including the repo logo
```

## Persistence

- Database: `data/agent.db`
- Optional sample content: `data/workspace/welcome.txt`
- Web UI, CLI, and HTTP API all share the same conversation state

## Development Notes

- `lib/llm/apiProvider.ts` is the active provider path.
- `lib/llm/codexProvider.ts` is a stub for future integration work.
- The browser session is ephemeral and process-local.
- This repo is intentionally small and local-first; there is no user auth or cloud dependency built in.
