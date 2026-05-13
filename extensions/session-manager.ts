// session-manager.ts
// Isolates .think/ per Pi terminal instance via symlinks.
// Each new Pi session gets its own directory under .think-sessions/.
// The model always writes to .think/ — the symlink is transparent.
//
// Commands:
//   /resume          — list all sessions
//   /resume <id>     — switch .think/ to that session and inject a steer
//   /sessions        — list all sessions (alias)
//
// Install: copy to ~/.pi/agent/extensions/session-manager.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";

const SESSIONS_DIR = ".think-sessions";
const THINK_LINK = ".think";
const INDEX_FILE = "sessions.json";

interface Session {
  id: string;
  created: string;
  lastActive: string;
  task: string;
}

interface SessionsIndex {
  sessions: Session[];
  active: string | null;
}

function sessionsDir(): string {
  return path.resolve(process.cwd(), SESSIONS_DIR);
}

function thinkLink(): string {
  return path.resolve(process.cwd(), THINK_LINK);
}

function indexPath(): string {
  return path.join(sessionsDir(), INDEX_FILE);
}

function readIndex(): SessionsIndex {
  const p = indexPath();
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return { sessions: [], active: null };
    }
  }
  return { sessions: [], active: null };
}

function writeIndex(index: SessionsIndex): void {
  fs.writeFileSync(indexPath(), JSON.stringify(index, null, 2));
}

function nextId(index: SessionsIndex): string {
  const nums = index.sessions
    .map((s) => parseInt(s.id.replace("session-", ""), 10))
    .filter((n) => !isNaN(n));
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `session-${String(next).padStart(3, "0")}`;
}

function taskFromState(dir: string): string {
  const p = path.join(dir, "_state.md");
  if (!fs.existsSync(p)) return "(no state yet)";
  try {
    const content = fs.readFileSync(p, "utf-8");
    const match = content.match(/##\s*Task:\s*(.+)/);
    return match ? match[1].trim() : "(no task defined)";
  } catch {
    return "(unreadable)";
  }
}

function ensureGitignore(): void {
  const gitignorePath = path.resolve(process.cwd(), ".gitignore");
  const entries = [SESSIONS_DIR + "/", THINK_LINK + "/"];

  let content = "";
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf-8");
  }

  const missing = entries.filter((e) => !content.includes(e));
  if (missing.length > 0) {
    const append = (content.endsWith("\n") || content === "" ? "" : "\n") + missing.join("\n") + "\n";
    fs.appendFileSync(gitignorePath, append);
  }
}

function migrateRealDir(index: SessionsIndex): void {
  const link = thinkLink();
  if (!fs.existsSync(link)) return;

  const stat = fs.lstatSync(link);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;

  // .think/ is a real directory — migrate it to a session
  const id = nextId(index);
  const dest = path.join(sessionsDir(), id);
  fs.renameSync(link, dest);
  index.sessions.push({
    id,
    created: new Date().toISOString(),
    lastActive: new Date().toISOString(),
    task: taskFromState(dest),
  });
}

function activate(index: SessionsIndex, id: string): void {
  const link = thinkLink();
  const target = path.join(sessionsDir(), id);

  // Remove existing symlink
  if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) {
    fs.unlinkSync(link);
  }

  // Create relative symlink so the project is portable
  const rel = path.relative(process.cwd(), target);
  fs.symlinkSync(rel, link);

  index.active = id;
  const session = index.sessions.find((s) => s.id === id);
  if (session) session.lastActive = new Date().toISOString();
  writeIndex(index);
}

function formatSessionList(index: SessionsIndex): string {
  if (index.sessions.length === 0) return "No sessions.";
  return index.sessions
    .map((s) => {
      const marker = s.id === index.active ? " ← active" : "";
      const date = s.lastActive.slice(0, 16).replace("T", " ");
      return `  ${s.id}  |  ${s.task}  |  ${date}${marker}`;
    })
    .join("\n");
}

// ---------- EXTENSION ----------
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    ensureGitignore();

    const index = readIndex();

    // If .think/ is a real directory from before this extension, migrate it
    migrateRealDir(index);

    // Create new session
    const id = nextId(index);
    const dir = path.join(sessionsDir(), id);
    fs.mkdirSync(dir, { recursive: true });
    index.sessions.push({
      id,
      created: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      task: "(new session)",
    });

    activate(index, id);

    ctx.ui.notify(`session-manager: ${id} — .think/ ready`, "info");
  });

  // /switch-session [session-id] — list or switch sessions
  pi.registerCommand("switch-session", {
    description: "Switch to a previous session. Usage: /switch-session or /switch-session session-001",
    handler: async (args: string, ctx: any) => {
      const index = readIndex();

      // Refresh tasks from _state.md
      for (const s of index.sessions) {
        s.task = taskFromState(path.join(sessionsDir(), s.id));
      }
      writeIndex(index);

      const target = args?.trim();
      if (!target) {
        ctx.ui.notify(
          `Sessions:\n${formatSessionList(index)}\n\nUse /resume <id> to switch.`,
          "info"
        );
        return;
      }

      const session = index.sessions.find((s) => s.id === target);
      if (!session) {
        ctx.ui.notify(`Session "${target}" not found.`, "error");
        return;
      }

      activate(index, target);
      ctx.ui.notify(`Resumed ${target}: ${session.task}`, "info");

      await pi.sendMessage(
        {
          customType: "session_resume",
          content: `[session-manager] Resumed session ${target}. Read .think/_state.md now and continue from where you left off.`,
          display: { label: "session-manager", content: `Resumed ${target}` },
        },
        { deliverAs: "steer" }
      );
    },
  });

  // /sessions — list only
  pi.registerCommand("sessions", {
    description: "List all .think/ sessions",
    handler: async (_args: string, ctx: any) => {
      const index = readIndex();
      for (const s of index.sessions) {
        s.task = taskFromState(path.join(sessionsDir(), s.id));
      }
      writeIndex(index);
      ctx.ui.notify(`Sessions:\n${formatSessionList(index)}`, "info");
    },
  });
}
