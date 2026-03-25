import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  osascript,
  getCwd,
  listSessionsAS,
  readOutputAS,
  writeInputAS,
  sendControlAS,
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
      "Send text input to a specific iTerm2 session. By default presses Enter after the text.",
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
    }),
  },
  async ({ session_id, text, newline }) => {
    try {
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
