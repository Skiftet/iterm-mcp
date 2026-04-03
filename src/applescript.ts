import { execFile } from "node:child_process";

/**
 * Run a command with execFile (no shell — immune to shell injection).
 */
export function run(cmd: string, args: string[], maxBuffer = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Execute an AppleScript string via osascript.
 */
export function osascript(script: string): Promise<string> {
  return run("osascript", ["-e", script]);
}

/**
 * Escape a string for use inside an AppleScript double-quoted string literal.
 */
export function escapeAS(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const UUID_RE =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * Validate that a string is a valid UUID (iTerm2 session ID format).
 * Throws if invalid — prevents AppleScript injection via session_id params.
 */
export function assertSessionId(id: string): void {
  if (!UUID_RE.test(id)) {
    throw new Error(`Invalid session ID: ${id}`);
  }
}

/**
 * Resolve a TTY path to the working directory of the process using it.
 */
export async function getCwd(tty: string): Promise<string | null> {
  try {
    const pids = (await run("lsof", ["-t", tty])).trim().split("\n");
    if (!pids[0]) return null;
    const out = await run("lsof", ["-a", "-p", pids[0], "-d", "cwd", "-Fn"]);
    const match = out.match(/\nn(.+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// --- AppleScript template builders ---

export function listSessionsAS(): string {
  return `
tell application "iTerm2"
  set output to ""
  repeat with w in windows
    set wId to id of w
    set wName to name of w
    set tabIdx to 0
    repeat with t in tabs of w
      set tabIdx to tabIdx + 1
      set sessIdx to 0
      repeat with s in sessions of t
        set sessIdx to sessIdx + 1
        set output to output & wId & "|||" & wName & "|||" & tabIdx & "|||" & sessIdx & "|||" & (unique ID of s) & "|||" & (name of s) & "|||" & (tty of s) & "|||" & (profile name of s) & "|||" & (columns of s) & "|||" & (rows of s) & linefeed
      end repeat
    end repeat
  end repeat
  return output
end tell`;
}

export function readOutputAS(sessionId: string): string {
  assertSessionId(sessionId);
  return `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if unique ID of s is "${escapeAS(sessionId)}" then
          return contents of s
        end if
      end repeat
    end repeat
  end repeat
  return "SESSION_NOT_FOUND"
end tell`;
}

export function writeInputAS(
  sessionId: string,
  text: string,
  newline: boolean
): string {
  assertSessionId(sessionId);
  const nl = newline ? "" : " newline NO";
  return `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if unique ID of s is "${escapeAS(sessionId)}" then
          tell s to write text "${escapeAS(text)}"${nl}
          return "OK"
        end if
      end repeat
    end repeat
  end repeat
  return "SESSION_NOT_FOUND"
end tell`;
}

export function createWindowAS(
  profile: string | null,
  command: string | null,
  cwd: string | null
): string {
  const profileClause = profile
    ? `with profile "${escapeAS(profile)}"`
    : `with default profile`;

  let body = `
tell application "iTerm2"
  set newWindow to (create window ${profileClause})
  tell current session of current tab of newWindow`;

  if (cwd) {
    body += `\n    write text "cd ${escapeAS(cwd)} && clear"`;
  }
  if (command) {
    body += `\n    write text "${escapeAS(command)}"`;
  }

  body += `
    set sid to unique ID
  end tell
  return sid
end tell`;
  return body;
}

export function createTabAS(
  sessionId: string,
  profile: string | null,
  command: string | null,
  cwd: string | null
): string {
  assertSessionId(sessionId);
  const profileClause = profile
    ? `with profile "${escapeAS(profile)}"`
    : `with default profile`;

  let body = `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if unique ID of s is "${escapeAS(sessionId)}" then
          tell w
            set newTab to (create tab ${profileClause})
            tell current session of newTab`;

  if (cwd) {
    body += `\n              write text "cd ${escapeAS(cwd)} && clear"`;
  }
  if (command) {
    body += `\n              write text "${escapeAS(command)}"`;
  }

  body += `
              set sid to unique ID
            end tell
          end tell
          return sid
        end if
      end repeat
    end repeat
  end repeat
  return "SESSION_NOT_FOUND"
end tell`;
  return body;
}

export function splitPaneAS(
  sessionId: string,
  vertical: boolean,
  profile: string | null,
  command: string | null,
  cwd: string | null
): string {
  assertSessionId(sessionId);
  const direction = vertical ? "vertically" : "horizontally";
  const profileClause = profile
    ? `with profile "${escapeAS(profile)}"`
    : `with default profile`;

  let body = `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if unique ID of s is "${escapeAS(sessionId)}" then
          tell s
            set newSession to (split ${direction} ${profileClause})
          end tell
          tell newSession`;

  if (cwd) {
    body += `\n            write text "cd ${escapeAS(cwd)} && clear"`;
  }
  if (command) {
    body += `\n            write text "${escapeAS(command)}"`;
  }

  body += `
            set sid to unique ID
          end tell
          return sid
        end if
      end repeat
    end repeat
  end repeat
  return "SESSION_NOT_FOUND"
end tell`;
  return body;
}

export function sendControlAS(sessionId: string, asciiCode: number): string {
  assertSessionId(sessionId);
  return `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if unique ID of s is "${escapeAS(sessionId)}" then
          tell s to write text (ASCII character ${asciiCode}) newline NO
          return "OK"
        end if
      end repeat
    end repeat
  end repeat
  return "SESSION_NOT_FOUND"
end tell`;
}
