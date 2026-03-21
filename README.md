# HunterClaw

HunterClaw is a local-first MVP for a personal coding agent inspired by OpenClaw-style workflows, but intentionally much smaller and simpler.

The app runs entirely on your machine for the MVP:
- Next.js web chat UI
- API-backed LLM provider using your own key and model
- SQLite-backed memory and tool logs
- approval flow for medium/high-risk actions
- local tools for files, shell, and browser automation

## Stack

- Next.js App Router
- TypeScript
- Tailwind CSS
- SQLite
- Drizzle ORM
- Zod
- Playwright

## Requirements

- Node.js 20+ recommended
- npm
- macOS, Linux, or another environment where Playwright Chromium can run
- network access if you use an external API-backed provider

## What works

- chat UI with inline messages, tool activity, and approval cards
- multiple isolated conversations in both the web UI and the CLI
- conversation token tracking with totals and latest-turn usage
- terminal CLI for agent-style conversations
- `GET /api/conversations`, `POST /api/conversations`, `POST /api/chat`, `POST /api/chat/stream`, `POST /api/approve`, `POST /api/approve/stream`, `GET /api/history`
- SQLite persistence for messages, summaries, preferences, tool executions, and approvals
- rolling summary memory for older messages
- multi-step agent loop that can chain tool calls before answering
- file tool with low-risk project access for reading and listing local files
- dedicated code tool for file creation, single-file patch application, and before/after diff previews
- safe shell tool with a readonly allowlist and blocked dangerous commands
- Playwright-backed browser tool with approval for `click` and `type`
- provider abstraction with a working API provider and a stubbed `codexProvider`

## Project structure

```text
app/
  api/conversations
  api/chat
  api/approve
  api/history
  page.tsx

components/chat/

lib/
  agent/
  db/
  llm/
  tools/

data/workspace/
scripts/
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create the database and workspace

```bash
npm run db:setup
```

This creates:
- `data/agent.db`
- `data/workspace/welcome.txt`

### 3. Install Playwright Chromium

```bash
npm run playwright:install
```

This is required for the browser tool, even if you mainly use file and shell tools.

### 4. Configure the provider

The app supports two provider modes:
- `api` for an external OpenAI-compatible API
- `codex` as a stub for future work

Use `.env.local` for local configuration. Example:

```bash
LLM_PROVIDER=api
```

For an external provider:

```bash
LLM_PROVIDER=api
LLM_API_KEY=your_key_here
LLM_API_MODEL=qwen3-max-2026-01-23
LLM_API_BASE_URL=https://dashscope-intl.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1
```

The app also accepts:
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_BASE_URL`

Other useful env vars:

```bash
AGENT_DB_PATH=./data/agent.db
AGENT_FS_ROOT=.
AUTO_APPROVE_FILE_WRITES=false
```

`AGENT_FS_ROOT` controls the primary project root for relative file paths and the shell tool working directory. By default it is the repo root.

Behavior with that setting:
- relative file paths are resolved from `AGENT_FS_ROOT`
- read/list access inside `AGENT_FS_ROOT` is low risk
- read/list access outside `AGENT_FS_ROOT` is allowed, but requires approval
- writes inside `AGENT_FS_ROOT` are medium risk
- writes outside `AGENT_FS_ROOT` are high risk
- shell commands still run with `AGENT_FS_ROOT` as the cwd and remain project-scoped

## Run modes

You can run HunterClaw in three ways:
- web UI
- terminal CLI
- direct HTTP API

### Web UI

Start the dev server:

```bash
npm run dev
```

Then open the local URL printed by Next.js, usually [http://localhost:3000](http://localhost:3000) or [http://localhost:3001](http://localhost:3001).

The web UI shows:
- a conversation list with new-thread creation and switching
- user and assistant messages with live token-by-token assistant streaming
- compact tool executions without raw payload dumps
- approval cards for medium/high-risk actions with live resume after approve/deny
- the active provider name
- conversation and last-turn token usage cards

Recommended use:
- ask the agent normal questions about the repo
- ask it to inspect code before answering
- ask it to make changes, then review the code diff preview before approving

### Terminal CLI

Run the interactive terminal agent:

```bash
npm run agent:cli
```

This opens a simple REPL on top of the same agent loop and SQLite database used by the web app.

Interactive CLI behavior:
- type a normal request and press Enter
- approvals are handled inline with `Approve? [y/n]`
- `/conversations` lists existing threads
- `/new` starts a fresh thread
- `/switch <index|conversation-id>` changes the active thread
- `/help` shows CLI help
- `/exit` or `/quit` exits

Example:

```bash
npm run agent:cli
```

Then:

```text
> inspect this repo and explain the architecture
> /new
> find the bug in the agent loop and explain it
> /conversations
> /switch 1
> update the README to better document the terminal workflow
> look through the relevant files and tell me what needs approval before changing anything
```

You can also run a single one-shot message:

```bash
npm run agent:cli -- --conversation bugfix "inspect this repo and explain what kind of app it is"
```

One-shot mode executes one turn and exits. If that turn requires approval, it stops at the approval boundary and tells you to use the interactive CLI or web UI.

### Direct HTTP API

Start the app first:

```bash
npm run dev
```

Then use the routes directly.

Send a non-streaming chat message:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"bugfix","message":"inspect this repo and explain how the agent loop works"}'
```

Stream a chat turn over SSE:

```bash
curl -N -X POST http://localhost:3000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"bugfix","message":"inspect this repo and explain how the agent loop works"}'
```

List conversations:

```bash
curl "http://localhost:3000/api/conversations"
```

Create an empty conversation:

```bash
curl -X POST http://localhost:3000/api/conversations
```

Load history:

```bash
curl "http://localhost:3000/api/history?conversationId=default"
```

Approve or deny a pending action without streaming:

```bash
curl -X POST http://localhost:3000/api/approve \
  -H "Content-Type: application/json" \
  -d '{"requestId":"approval_id_here","decision":"approve"}'
```

Resume a pending action over SSE:

```bash
curl -N -X POST http://localhost:3000/api/approve/stream \
  -H "Content-Type: application/json" \
  -d '{"requestId":"approval_id_here","decision":"approve"}'
```

The web UI uses the SSE endpoints so it can render assistant deltas and tool lifecycle updates in real time. The CLI and other simple clients can keep using the JSON endpoints.

If Next.js chooses a different port, replace `3000` with the actual printed port.

## Scripts

- `npm run dev` - start the local dev server
- `npm run build` - create a production build
- `npm run start` - run the production server after build
- `npm test` - run the focused code tool test suite
- `npm run typecheck` - run TypeScript checks
- `npm run db:setup` - create SQLite tables and seed `data/workspace/welcome.txt`
- `npm run agent:cli` - run the terminal agent REPL or one-shot CLI
- `npm run playwright:install` - install Chromium for Playwright

## How to talk to the agent

The intended experience is conversational, not command-driven.

Good prompts:
- `inspect this repository and explain the main architecture`
- `find where the approval flow is implemented and summarize it`
- `look through the agent loop and tell me why tool chaining is failing`
- `update the README so terminal usage is clearer`
- `check how the shell tool is sandboxed and explain any risks`

The API provider should decide on its own when to:
- list directories
- read files
- search with `rg`
- inspect git state
- browse a webpage
- ask for approval before writing

There is no local parser fallback anymore. This app expects a real LLM-backed provider.

## Safety model

- low-risk actions auto-run
- medium/high-risk actions pause for approval
- file writes require approval by default
- browser `click` and `type` require approval
- dangerous shell commands are blocked instead of queued for approval
- raw tool args/results stay in SQLite and are not shown in the main chat timeline
- relative file access is based on `AGENT_FS_ROOT`
- reading or listing local paths outside `AGENT_FS_ROOT` requires approval
- writing local paths outside `AGENT_FS_ROOT` is high risk and requires approval
- all shell commands run with `AGENT_FS_ROOT` as the cwd and remain project-scoped
- by default, `AGENT_FS_ROOT` is the repo root so the agent can inspect the codebase itself

Optional override:
- set `AUTO_APPROVE_FILE_WRITES=true` in your environment to skip approvals for file writes

## Persistence

- SQLite database: `data/agent.db`
- sample workspace folder: `data/workspace`
- the DB file is ignored by git

The same SQLite state is shared across:
- web UI
- terminal CLI
- direct API calls

That means a message sent in the terminal will appear in the web UI history, and vice versa.
The same is true per conversation id, so the web UI, CLI, and HTTP API can all continue the same thread.

## Common workflows

### Qwen API-backed mode

Use the OpenAI-compatible Qwen endpoint:

```bash
LLM_PROVIDER=api \
LLM_API_KEY=your_key_here \
LLM_API_MODEL=qwen3-max-2026-01-23 \
LLM_API_BASE_URL=https://dashscope-intl.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1 \
npm run agent:cli
```

### Production-style run

Build and run the server:

```bash
npm run build
npm run start
```

## Troubleshooting

### Browser tool fails to launch

Run:

```bash
npm run playwright:install
```

### API provider says credentials are missing

Check that your `.env.local` contains:
- `LLM_PROVIDER=api`
- `LLM_API_KEY=...`

If you are using shell one-liners, make sure the environment variables are exported into the process.

### You want a clean conversation history

Delete `data/agent.db` and then rerun:

```bash
npm run db:setup
```

### You expected repo-root file access

That is now the default. `AGENT_FS_ROOT` still defaults to the repo root, which keeps low-risk autonomous access focused on the current project. If you want a narrower sandbox, set `AGENT_FS_ROOT` to a subdirectory. If the agent needs to inspect another local path, it can request approval first.

## Provider status

### Working now

- `lib/llm/apiProvider.ts`
  - uses the OpenAI SDK against OpenAI or an OpenAI-compatible base URL
  - maps model output into the existing `ProviderDecision` contract
  - supports more autonomous multi-step tool use
  - keeps summaries and tool planning behind the same provider interface

### Stubbed for later

- `lib/llm/codexProvider.ts`
  - same provider interface as the working API provider
  - intentionally throws a clear not-implemented error today
  - includes TODOs for Codex/ChatGPT-auth-backed integration later

## Next steps for Codex auth/provider integration

1. Add a real authenticated session/client layer for Codex or ChatGPT-backed workflows.
2. Map provider tool-planning output into the existing `ProviderDecision` format.
3. Reuse the current approval layer and tool registry rather than rebuilding them.
4. Add richer model-specific prompting and response validation once auth is wired.
5. Add runtime provider switching in the UI if you want both API and Codex-backed modes later.

## Notes

- Conversation ids are lightweight strings. The default thread id is `default`, and the CLI/web UI can create additional threads on demand.
- There is no user auth system, multi-agent orchestration, or cloud dependency.
- The browser session is process-local and ephemeral.
- The API provider gives the closest experience to a Claude Code-style workflow.
