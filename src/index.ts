import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  osascript,
  getCwd,
  getForegroundProcess,
  listSessionsAS,
  readOutputAS,
  writeInputAS,
  sendControlAS,
  createWindowAS,
  createTabAS,
  splitPaneAS,
} from "./applescript.js";

const server = new McpServer({
  name: "iterm-mcp",
  version: "1.0.0",
});

// --- list_sessions ---

interface Session {
  windowId: string;
  windowName: string;
  tabIndex: string;
  paneIndex: string;
  sessionId: string;
  name: string;
  tty: string;
  profile: string;
  cols: string;
  rows: string;
  cwd?: string | null;
}

server.registerTool(
  "list_sessions",
  {
    description:
      "List all iTerm2 windows, tabs, and panes with their session IDs, names, and working directories. Use this to discover which terminal is running which agent.",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const raw = await osascript(listSessionsAS());
      const lines = raw.trim().split("\n").filter(Boolean);

      if (lines.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No iTerm2 sessions found." }],
        };
      }

      const sessions: Session[] = lines.map((line) => {
        const parts = line.split("|||");
        return {
          windowId: parts[0],
          windowName: parts[1],
          tabIndex: parts[2],
          paneIndex: parts[3],
          sessionId: parts[4],
          name: parts[5],
          tty: parts[6],
          profile: parts[7],
          cols: parts[8],
          rows: parts[9],
        };
      });

      // Resolve CWDs in parallel
      const cwds = await Promise.all(sessions.map((s) => getCwd(s.tty)));
      sessions.forEach((s, i) => (s.cwd = cwds[i]));

      // Format grouped by window > tab > pane
      const windowMap = new Map<string, Session[]>();
      for (const s of sessions) {
        if (!windowMap.has(s.windowId)) windowMap.set(s.windowId, []);
        windowMap.get(s.windowId)!.push(s);
      }

      let output = "";
      for (const [, windowSessions] of windowMap) {
        const wName = windowSessions[0].windowName;
        const wId = windowSessions[0].windowId;
        output += `Window "${wName}" (id=${wId})\n`;

        const tabMap = new Map<string, Session[]>();
        for (const s of windowSessions) {
          if (!tabMap.has(s.tabIndex)) tabMap.set(s.tabIndex, []);
          tabMap.get(s.tabIndex)!.push(s);
        }

        for (const [tabIdx, tabSessions] of tabMap) {
          output += `  Tab ${tabIdx}:\n`;
          for (const s of tabSessions) {
            output += `    Pane ${s.paneIndex}: ${s.name}\n`;
            output += `      Session ID: ${s.sessionId}\n`;
            output += `      TTY: ${s.tty}\n`;
            output += `      CWD: ${s.cwd || "unknown"}\n`;
            output += `      Profile: ${s.profile}\n`;
            output += `      Size: ${s.cols}x${s.rows}\n`;
          }
        }
      }

      return { content: [{ type: "text" as const, text: output.trimEnd() }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// --- check_activity ---

interface ActivityInfo {
  sessionId: string;
  name: string;
  cwd: string | null;
  tty: string;
  foregroundProcess: string | null;
  lastLines: string[];
  idle: boolean;
  windowId: string;
  tabIndex: string;
}

server.registerTool(
  "check_activity",
  {
    description:
      "Scan all iTerm2 sessions and report which are active vs idle. Returns each session's foreground process, last few lines of output, and an idle/active assessment. Use this to discover which sessions are worth watching or placing in a layout grid.",
    inputSchema: z.object({
      tail_lines: z
        .number()
        .optional()
        .default(5)
        .describe(
          "Number of trailing output lines to include per session (default: 5)"
        ),
    }),
  },
  async ({ tail_lines }) => {
    try {
      const raw = await osascript(listSessionsAS());
      const lines = raw.trim().split("\n").filter(Boolean);

      if (lines.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No iTerm2 sessions found." },
          ],
        };
      }

      const sessions = lines.map((line) => {
        const parts = line.split("|||");
        return {
          windowId: parts[0],
          windowName: parts[1],
          tabIndex: parts[2],
          paneIndex: parts[3],
          sessionId: parts[4],
          name: parts[5],
          tty: parts[6],
        };
      });

      // Gather activity info in parallel
      const activities: ActivityInfo[] = await Promise.all(
        sessions.map(async (s) => {
          const [cwd, fgProc, output] = await Promise.all([
            getCwd(s.tty),
            getForegroundProcess(s.tty),
            osascript(readOutputAS(s.sessionId)).catch(() => ""),
          ]);

          const allLines = output.split("\n");
          // Strip trailing empty lines
          while (
            allLines.length > 0 &&
            allLines[allLines.length - 1].trim() === ""
          ) {
            allLines.pop();
          }
          const lastLines = allLines.slice(-tail_lines);

          // Heuristic: idle if fg process is a shell and last line looks like a prompt
          const shellNames = [
            "-zsh",
            "zsh",
            "-bash",
            "bash",
            "fish",
            "-fish",
          ];
          const isShell = fgProc
            ? shellNames.some((sh) => fgProc.includes(sh))
            : false;
          const lastLine = lastLines[lastLines.length - 1] || "";
          const looksLikePrompt =
            lastLine.match(/[$%#>➜❯]\s*$/) !== null ||
            lastLine.match(/[$%#>➜❯].*\s*$/) !== null ||
            lastLine.trim() === "";
          // Also detect Claude Code sessions waiting at prompt
          const isClaudeIdle =
            !isShell &&
            (lastLine.includes("accept edits on") ||
              lastLine.includes("new task?") ||
              lastLine.includes("esc to interrupt"));
          const idle = (isShell && looksLikePrompt) || isClaudeIdle;

          return {
            sessionId: s.sessionId,
            name: s.name,
            cwd,
            tty: s.tty,
            foregroundProcess: fgProc,
            lastLines,
            idle,
            windowId: s.windowId,
            tabIndex: s.tabIndex,
          };
        })
      );

      // Sort: active first, then by name
      activities.sort((a, b) => {
        if (a.idle !== b.idle) return a.idle ? 1 : -1;
        return a.name.localeCompare(b.name);
      });

      // Format output
      let output = `${activities.filter((a) => !a.idle).length} active, ${activities.filter((a) => a.idle).length} idle\n\n`;

      for (const a of activities) {
        const status = a.idle ? "IDLE" : "ACTIVE";
        output += `[${status}] ${a.name}\n`;
        output += `  Session: ${a.sessionId}\n`;
        output += `  CWD: ${a.cwd || "unknown"}\n`;
        output += `  Process: ${a.foregroundProcess || "unknown"}\n`;
        if (a.lastLines.length > 0) {
          output += `  Output:\n`;
          for (const line of a.lastLines) {
            output += `    ${line}\n`;
          }
        }
        output += `\n`;
      }

      return {
        content: [{ type: "text" as const, text: output.trimEnd() }],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// --- read_output ---

server.registerTool(
  "read_output",
  {
    description:
      "Read the last N lines of output from a specific iTerm2 session by its session ID.",
    inputSchema: z.object({
      session_id: z
        .string()
        .describe("The unique session ID (UUID) from list_sessions"),
      lines: z
        .number()
        .optional()
        .default(100)
        .describe("Number of lines to return from the end (default: 100)"),
    }),
  },
  async ({ session_id, lines }) => {
    try {
      const raw = await osascript(readOutputAS(session_id));
      if (raw === "SESSION_NOT_FOUND") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Session ${session_id} not found.`,
            },
          ],
          isError: true,
        };
      }

      const allLines = raw.split("\n");
      // Strip trailing empty lines
      while (
        allLines.length > 0 &&
        allLines[allLines.length - 1].trim() === ""
      ) {
        allLines.pop();
      }
      const sliced = allLines.slice(-lines);
      return { content: [{ type: "text" as const, text: sliced.join("\n") }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// --- write_input ---

server.registerTool(
  "write_input",
  {
    description:
      "Send text input to a specific iTerm2 session. By default presses Enter after the text. When sending to a Claude Code session, set submit: true — this writes the text without a trailing newline, then sends a separate Enter keystroke to trigger submission (Claude Code buffers pasted text and needs a distinct Enter to submit).",
    inputSchema: z.object({
      session_id: z
        .string()
        .describe("The unique session ID (UUID) from list_sessions"),
      text: z.string().describe("The text to send to the terminal"),
      newline: z
        .boolean()
        .optional()
        .default(true)
        .describe("Press Enter after the text (default: true)"),
      submit: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Set true when sending to a Claude Code prompt. Writes the text without newline first, then sends a separate Enter to trigger submission."
        ),
    }),
  },
  async ({ session_id, text, newline, submit }) => {
    try {
      if (submit) {
        // Two-step: paste text without newline, then send a bare Enter to submit
        const pasteResult = await osascript(writeInputAS(session_id, text, false));
        if (pasteResult === "SESSION_NOT_FOUND") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Session ${session_id} not found.`,
              },
            ],
            isError: true,
          };
        }
        await osascript(writeInputAS(session_id, "", true));
        return {
          content: [
            {
              type: "text" as const,
              text: `Sent to ${session_id} [submitted]: ${text}`,
            },
          ],
        };
      }

      const raw = await osascript(writeInputAS(session_id, text, newline));
      if (raw === "SESSION_NOT_FOUND") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Session ${session_id} not found.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Sent to ${session_id}: ${text}${newline ? " [Enter]" : ""}`,
          },
        ],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// --- send_control ---

const CONTROL_CHARS: Record<string, number> = {
  "ctrl-c": 3,
  "ctrl-d": 4,
  "ctrl-z": 26,
  "ctrl-l": 12,
  "ctrl-a": 1,
  "ctrl-e": 5,
  "ctrl-u": 21,
  "ctrl-k": 11,
  "ctrl-w": 23,
  "ctrl-r": 18,
};

server.registerTool(
  "send_control",
  {
    description:
      "Send a control character (e.g. ctrl-c to interrupt) to a specific iTerm2 session.",
    inputSchema: z.object({
      session_id: z
        .string()
        .describe("The unique session ID (UUID) from list_sessions"),
      character: z
        .enum([
          "ctrl-c",
          "ctrl-d",
          "ctrl-z",
          "ctrl-l",
          "ctrl-a",
          "ctrl-e",
          "ctrl-u",
          "ctrl-k",
          "ctrl-w",
          "ctrl-r",
        ])
        .describe("Control character to send"),
    }),
  },
  async ({ session_id, character }) => {
    const code = CONTROL_CHARS[character];
    try {
      const raw = await osascript(sendControlAS(session_id, code));
      if (raw === "SESSION_NOT_FOUND") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Session ${session_id} not found.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Sent ${character} to ${session_id}`,
          },
        ],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// --- create_window ---

server.registerTool(
  "create_window",
  {
    description:
      "Create a new iTerm2 window. Prefer create_tab over this — new windows clutter the workspace. Only use create_window when the task genuinely needs a separate window. Returns the session ID of the new session.",
    inputSchema: z.object({
      profile: z
        .string()
        .optional()
        .describe(
          "iTerm2 profile name to use (omit for default profile)"
        ),
      cwd: z
        .string()
        .optional()
        .describe("Working directory to cd into after creation"),
      command: z
        .string()
        .optional()
        .describe("Command to execute in the new window"),
    }),
  },
  async ({ profile, cwd, command }) => {
    try {
      const sessionId = (
        await osascript(
          createWindowAS(profile ?? null, command ?? null, cwd ?? null)
        )
      ).trim();
      return {
        content: [
          {
            type: "text" as const,
            text: `Created new window. Session ID: ${sessionId}`,
          },
        ],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// --- create_tab ---

server.registerTool(
  "create_tab",
  {
    description:
      "Create a new tab in the same window as an existing session. This is the preferred way to create new sessions — use this instead of create_window. Returns the session ID of the new tab's session.",
    inputSchema: z.object({
      session_id: z
        .string()
        .describe(
          "Session ID of any session in the target window (UUID from list_sessions)"
        ),
      profile: z
        .string()
        .optional()
        .describe("iTerm2 profile name to use (omit for default profile)"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory to cd into after creation"),
      command: z
        .string()
        .optional()
        .describe("Command to execute in the new tab"),
    }),
  },
  async ({ session_id, profile, cwd, command }) => {
    try {
      const raw = (
        await osascript(
          createTabAS(
            session_id,
            profile ?? null,
            command ?? null,
            cwd ?? null
          )
        )
      ).trim();
      if (raw === "SESSION_NOT_FOUND") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Session ${session_id} not found.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Created new tab. Session ID: ${raw}`,
          },
        ],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// --- split_pane ---

server.registerTool(
  "split_pane",
  {
    description:
      "Split an existing session's pane vertically or horizontally, creating a new pane. Returns the session ID of the new pane.",
    inputSchema: z.object({
      session_id: z
        .string()
        .describe(
          "Session ID of the pane to split (UUID from list_sessions)"
        ),
      vertical: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Split direction: true for vertical (side by side), false for horizontal (top/bottom). Default: true."
        ),
      profile: z
        .string()
        .optional()
        .describe("iTerm2 profile name to use (omit for default profile)"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory to cd into after creation"),
      command: z
        .string()
        .optional()
        .describe("Command to execute in the new pane"),
    }),
  },
  async ({ session_id, vertical, profile, cwd, command }) => {
    try {
      const raw = (
        await osascript(
          splitPaneAS(
            session_id,
            vertical,
            profile ?? null,
            command ?? null,
            cwd ?? null
          )
        )
      ).trim();
      if (raw === "SESSION_NOT_FOUND") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Session ${session_id} not found.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Split pane ${vertical ? "vertically" : "horizontally"}. New session ID: ${raw}`,
          },
        ],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// --- start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("iterm-mcp server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
