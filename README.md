# iterm-mcp

MCP server that lets Claude Code agents control iTerm2 — discover terminal sessions, read their output, and send them input.

Built for a specific use case: running multiple Claude Code agents in different iTerm2 panes and having them coordinate with each other.

## Tools

**`list_sessions`** — Enumerate all windows, tabs, and panes. Returns session IDs, names, TTYs, working directories, profiles, and terminal dimensions. Use this first to find what you want to talk to.

**`read_output`** — Read the last N lines from a session. Pulls from the scrollback buffer, so you can see history, not just what's currently visible.

**`write_input`** — Type text into a session. Sends Enter by default, pass `newline: false` to type without submitting.

**`send_control`** — Send control characters (ctrl-c, ctrl-d, ctrl-z, etc.) to a session.

## How it works

AppleScript via `osascript`. No iTerm2 Python API to enable, no plugins to install. Working directory resolution uses `lsof` against the session's TTY.

All commands go through `execFile` (not `exec`), session IDs are validated as UUIDs before being interpolated, and text is escaped for AppleScript string literals.

## Setup

```bash
npm install
npm run build
```

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "iterm": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/iterm-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Code. The tools show up as `mcp__iterm__list_sessions`, etc.

## Requirements

- macOS (AppleScript)
- iTerm2
- Node.js 18+
