// dory-board.ts
// Press the TRIGGER_KEY (ù) anywhere in the Pi input editor to open the Dory
// kanban board in the browser. If the board server (organizer/board/server.mjs)
// isn't running yet, it is auto-started against MIND_DIR (created and
// git-initialized on first use) and the page opens once it responds.
//
// Key interception works like voice-input.ts: a bare accented char can't be
// represented by registerShortcut's ASCII-only KeyId, so we wrap the editor
// component and intercept the raw character (plus its Kitty CSI-u form) in
// handleInput. COMPOSES with an already-installed custom editor factory
// (e.g. voice-input's) instead of replacing it — load order doesn't matter.
// Consequence: you can no longer TYPE ù into the prompt (paste still works).
//
// Also registers /board [open|status] as a keyboard-free fallback.
//
// Install: copy to ~/.pi/agent/extensions/dory-board.ts
//          (server + UI: organizer/board/* → ~/.pi/organizer/board/)

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, execFile } from "child_process";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

const TRIGGER_KEY = "ù";             // open the board (raw char, intercepted in the editor)
// Kitty keyboard protocol may deliver the key as a CSI-u sequence instead of
// the raw char: ESC [ <codepoint> u — accept press/repeat, ignore release (:3).
const TRIGGER_CSI = new RegExp(`^\\x1b\\[${TRIGGER_KEY.codePointAt(0)}(;1(:[12])?)?u$`);
function isTrigger(data: string): boolean {
  return data === TRIGGER_KEY || TRIGGER_CSI.test(data);
}

const PORT = Number(process.env.DORY_BOARD_PORT || 4747);
const BOARD_URL = `http://localhost:${PORT}`;
const SERVER_MJS = path.join(os.homedir(), ".pi", "organizer", "board", "server.mjs");
const MIND_DIR = process.env.DORY_MIND_DIR || path.join(os.homedir(), "dev-mind");
const START_TIMEOUT_MS = 15000;      // opening a Terminal window + node startup takes a few seconds

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("dory-board");
  } catch {
    return true;
  }
}

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BOARD_URL}/api/board`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

function openInBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
}

function gitInit(dir: string): Promise<void> {
  return new Promise((resolve) => execFile("git", ["-C", dir, "init", "-q"], () => resolve()));
}

export default function doryBoard(pi: ExtensionAPI) {
  let opening = false; // debounce — starting the server takes a moment

  // Every ù press points Dory at THIS Pi session's project (cwd) — "the
  // folder where I typed pi". config.json's project_dir is updated to match.
  async function retargetProject(): Promise<void> {
    try {
      await fetch(`${BOARD_URL}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_dir: process.cwd() }),
        signal: AbortSignal.timeout(2000),
      });
    } catch {} // board still works; Dory falls back to its spawn cwd
  }

  async function openBoard(ctx: ExtensionContext): Promise<void> {
    if (opening) return;
    opening = true;
    try {
      if (await serverUp()) {
        await retargetProject();
        openInBrowser(BOARD_URL);
        ctx.ui.notify(`dory board → ${BOARD_URL} · project: ${process.cwd()} · type /dory to run tasks in this session`, "info");
        return;
      }
      if (!fs.existsSync(SERVER_MJS)) {
        ctx.ui.notify(`dory-board: server not found at ${SERVER_MJS} — run install.sh or dev-link.sh from the PiForge repo`, "error");
        return;
      }
      // First use: provision the mind repo, then start the orchestrator
      // detached (it's a silent queue manager — Dory's actual work runs in
      // YOUR Pi session once you type /dory, or headless until then).
      if (!fs.existsSync(MIND_DIR)) {
        fs.mkdirSync(MIND_DIR, { recursive: true });
        await gitInit(MIND_DIR);
      } else if (!fs.existsSync(path.join(MIND_DIR, ".git"))) {
        await gitInit(MIND_DIR);
      }
      ctx.ui.notify(`dory-board: starting the orchestrator (mind: ${MIND_DIR}, project: ${process.cwd()})…`, "info");
      spawn(process.execPath, [SERVER_MJS, MIND_DIR], {
        detached: true,
        stdio: "ignore",
        cwd: process.cwd(),
        env: { ...process.env, PORT: String(PORT), DORY_PROJECT_DIR: process.cwd() },
      }).unref();
      const deadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await serverUp()) {
          await retargetProject();
          openInBrowser(BOARD_URL);
          ctx.ui.notify(`dory board → ${BOARD_URL} · project: ${process.cwd()} · type /dory to run tasks in this session`, "info");
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      ctx.ui.notify(`dory-board: server did not come up on port ${PORT} — try: node ${SERVER_MJS} ${MIND_DIR}`, "error");
    } finally {
      opening = false;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!isEnabled()) return;
    // Compose with any editor factory another extension installed (voice-input).
    const prev = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = prev ? prev(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
      const baseHandleInput = editor.handleInput.bind(editor);
      editor.handleInput = (data: string) => {
        if (isTrigger(data)) {
          void openBoard(ctx);
          return; // swallow the char — it never reaches the text buffer
        }
        baseHandleInput(data);
      };
      return editor;
    });
    ctx.ui.notify(`dory-board active (press ${TRIGGER_KEY} or /board to open the kanban)`, "info");
  });

  pi.registerCommand("board", {
    description: "Open the Dory kanban board: /board [open|status]",
    handler: async (args, ctx) => {
      if (!isEnabled()) {
        ctx.ui.notify("dory-board disabled (use /piforge enable dory-board)", "info");
        return;
      }
      if ((args ?? "").trim() === "status") {
        const up = await serverUp();
        ctx.ui.notify(`dory board: ${up ? `running at ${BOARD_URL}` : "not running"} (mind: ${MIND_DIR})`, "info");
        return;
      }
      await openBoard(ctx);
    },
  });
}
