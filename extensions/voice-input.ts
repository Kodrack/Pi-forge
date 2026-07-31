// voice-input.ts
// Push-to-talk voice input for Pi. Press the TRIGGER_KEY (è) to start recording
// the mic, press it again to stop — audio is transcribed LOCALLY (no cloud) and
// the text is appended to the input editor. Press Enter to send, as usual.
//
// STREAMING: recording is segmented into CHUNK_SECONDS-long WAV files (ffmpeg
// segment muxer). A sequential queue transcribes each chunk as soon as it is
// finalized — WHILE recording continues — and appends its text to the input
// editor, so long dictation fills the prompt gradually. There is no practical
// length limit beyond MAX_RECORD_MS. Tradeoff: chunks are cut at fixed times
// (no VAD), so a word straddling a boundary can occasionally come out mangled.
//
// ZERO-SETUP: on session start the extension provisions itself in the
// background — creates a private venv at ~/.pi/stt-venv, pip-installs the
// selected engine into it, and pre-downloads the model (transcribes 1s of
// silence) so the first real use is instant. Footer status live-reports each
// step (🎤 setting up… → 🎤 è · parakeet ready). Setup output is logged to
// ~/.pi/stt-setup.log. Nothing runs between transcriptions — the engine is
// spawned per use and exits immediately (no daemon, no container, zero idle
// RAM). Models are cached on disk in ~/.cache/huggingface.
//
// Two selectable STT engines, both fully offline after first model download:
//   parakeet  — NVIDIA Parakeet TDT 0.6B v3 via parakeet-mlx (Apple Silicon).
//               Best accuracy, 25 European languages, Apache 2.0. ~600MB model.
//   moonshine — Useful Sensors Moonshine base (~57MB ONNX). Lightest + fastest.
//
// Engine selection (first match wins):
//   1. CLI flag              pi --stt moonshine
//   2. /stt command          /stt parakeet | /stt moonshine   (this session only)
//   3. DEFAULT_ENGINE const below
//
// The trigger is a bare accented character, which pi-tui's registerShortcut
// key matcher can't represent (ASCII-only KeyId) — so this extension wraps the
// input editor via ctx.ui.setEditorComponent/CustomEditor and intercepts the
// raw character in handleInput. Consequence: you can no longer TYPE è into the
// prompt (paste still works, and é/shift is unaffected). Composes with other
// extensions that wrap the editor the same way, whatever the load order.
//
// Recording uses ffmpeg avfoundation (auto-installed via brew if missing).
// The terminal app needs microphone permission — macOS prompts on first use.
//
// Install: copy to ~/.pi/agent/extensions/voice-input.ts

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, execFile, type ChildProcess } from "child_process";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

const TRIGGER_KEY = "è";             // record / stop toggle (raw char, intercepted in the editor)
// Kitty keyboard protocol may deliver the key as a CSI-u sequence instead of
// the raw char: ESC [ <codepoint> u — accept press/repeat, ignore release (:3).
const TRIGGER_CSI = new RegExp(`^\\x1b\\[${TRIGGER_KEY.codePointAt(0)}(;1(:[12])?)?u$`);
function isTrigger(data: string): boolean {
  return data === TRIGGER_KEY || TRIGGER_CSI.test(data);
}

// ---------- AUDIO DEVICE RESOLUTION ----------
// Resolved once per session and reported in the banner, so "which device am I
// recording?" is never an invisible question again.
type AudioDevice = { index: number; name: string };
let resolvedDevice: AudioDevice | null = null;
let deviceNote = "";

async function listAudioDevices(ffmpeg: string): Promise<AudioDevice[]> {
  // execFile directly, NOT the run() helper: ffmpeg exits nonzero on a
  // device-list query (there is no input file) and prints the list to stderr,
  // and run() rejects with only the last 500 chars of stderr folded into a
  // message string. The device list can exceed that, so use the raw stderr.
  const out: string = await new Promise((resolve) => {
    execFile(ffmpeg, ["-f", "avfoundation", "-list_devices", "true", "-i", ""],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
      (_err, _stdout, stderr) => resolve(String(stderr ?? "")));
  });
  const devices: AudioDevice[] = [];
  const audioPart = out.slice(out.indexOf("AVFoundation audio devices"));
  for (const line of audioPart.split("\n")) {
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (m) devices.push({ index: parseInt(m[1], 10), name: m[2] });
  }
  return devices;
}

function isVirtual(name: string): boolean {
  const n = name.toLowerCase();
  return VIRTUAL_DEVICE_PATTERNS.some((p) => n.includes(p));
}

async function resolveAudioDevice(ffmpeg: string): Promise<string> {
  if (AUDIO_DEVICE) return AUDIO_DEVICE.startsWith(":") ? AUDIO_DEVICE : `:${AUDIO_DEVICE}`;
  if (resolvedDevice) return `:${resolvedDevice.index}`;

  const devices = await listAudioDevices(ffmpeg);
  if (devices.length === 0) {
    deviceNote = "could not enumerate devices — falling back to :0";
    return ":0";
  }

  const real = devices.filter((d) => !isVirtual(d.name));
  if (real.length === 0) {
    // Everything looks virtual. Recording anyway beats refusing, but say so:
    // this is the exact state that produced silent audio and an empty transcript.
    resolvedDevice = devices[0];
    deviceNote = `WARNING: every input looks virtual (${devices.map((d) => d.name).join(", ")}) — audio may be silent`;
    return `:${resolvedDevice.index}`;
  }

  const preferred =
    real.find((d) => PREFERRED_DEVICE_PATTERNS.some((p) => d.name.toLowerCase().includes(p))) ?? real[0];
  resolvedDevice = preferred;

  const skipped = devices.filter((d) => d.index !== preferred.index && isVirtual(d.name));
  deviceNote = skipped.length ? `skipped virtual: ${skipped.map((d) => d.name).join(", ")}` : "";
  return `:${preferred.index}`;
}

const DEFAULT_ENGINE: Engine = "parakeet";

// Capture device. null = resolve BY NAME at runtime (recommended); set a literal
// ":<idx>" or a device name substring to pin it.
//
// This used to be a hardcoded ":0" — "the default mic". avfoundation indices are
// not stable: they are positions in an enumeration that changes whenever an audio
// device is added or removed. Installing a virtual audio device (BlackHole,
// Loopback, an Aggregate/Multi-Output, etc.) can insert it at index 0 and push
// the real mic to 1, so voice-input starts recording a
// virtual loopback device. That fails in the worst possible way — BlackHole
// carries system audio, so with nothing playing it yields perfectly valid SILENT
// audio. Segments were produced (no "check mic permission" error) and the
// transcript came back empty, with nothing pointing at the cause.
const AUDIO_DEVICE: string | null = null;

// Virtual / loopback devices: never a microphone, always silence when idle.
// Matched case-insensitively against the avfoundation device name.
const VIRTUAL_DEVICE_PATTERNS = [
  "blackhole", "soundflower", "loopback", "aggregate", "multi-output",
  "teams audio", "airbeamtv", "zoomaudio", "krisp", "vb-cable", "ishowu",
];

// Preferred when several real devices exist.
const PREFERRED_DEVICE_PATTERNS = ["macbook", "built-in", "internal", "microphone", "mic"];
const SAMPLE_RATE = 16000;           // both engines want 16kHz mono
const CHUNK_SECONDS = 30;            // streaming segment length — each chunk is transcribed while recording continues
const MAX_RECORD_MS = 600000;        // auto-stop safety net (10 min; streaming keeps up regardless of length)
const TRANSCRIBE_TIMEOUT = 300000;
const INSTALL_TIMEOUT = 900000;      // venv + pip (mlx wheels are chunky)
const WARMUP_TIMEOUT = 1800000;      // first model download from HuggingFace
const PARAKEET_MODEL = "mlx-community/parakeet-tdt-0.6b-v3";
const MOONSHINE_MODEL = "moonshine/base"; // or moonshine/tiny (26MB, faster, less accurate)

type Engine = "parakeet" | "moonshine";

const PKG: Record<Engine, string> = {
  parakeet: "parakeet-mlx",
  moonshine: "useful-moonshine-onnx",
};

// Self-contained toolchain — never touches the system python.
const VENV_DIR = path.join(os.homedir(), ".pi", "stt-venv");
const VENV_BIN = path.join(VENV_DIR, "bin");
const SETUP_LOG = path.join(os.homedir(), ".pi", "stt-setup.log");

// Per-process chunk directory — each Pi tab records into its own set of
// seg-NNN.wav files; segment i is finalized once seg i+1 exists (or ffmpeg exited).
const SEG_DIR = path.join(os.tmpdir(), `pi-voice-${process.pid}`);
const segPath = (i: number) => path.join(SEG_DIR, `seg-${String(i).padStart(3, "0")}.wav`);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("voice-input");
  } catch {
    return true;
  }
}

// Pi may run with a slim PATH; check the usual install locations too.
function resolveBin(name: string): string | undefined {
  const dirs = [
    VENV_BIN, // our venv wins
    ...(process.env.PATH || "").split(":"),
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    if (dir && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return undefined;
}

function sttPython(): string {
  const venvPy = path.join(VENV_BIN, "python");
  if (fs.existsSync(venvPy)) return venvPy;
  return resolveBin("python3") || "python3";
}

function logSetup(line: string): void {
  try {
    fs.appendFileSync(SETUP_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

function run(bin: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}\n${stderr.slice(-500)}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function transcribeParakeet(wav: string): Promise<string> {
  const bin = resolveBin("parakeet-mlx");
  if (!bin) throw new Error("parakeet-mlx missing — setup should have installed it, see " + SETUP_LOG);
  const outDir = os.tmpdir();
  await run(bin, [wav, "--model", PARAKEET_MODEL, "--output-format", "txt", "--output-dir", outDir], TRANSCRIBE_TIMEOUT);
  const txtPath = path.join(outDir, path.basename(wav, ".wav") + ".txt");
  const text = fs.readFileSync(txtPath, "utf-8").trim();
  fs.unlinkSync(txtPath);
  return text;
}

async function transcribeMoonshine(wav: string): Promise<string> {
  const script =
    "import sys\n" +
    "import moonshine_onnx\n" +
    `print(' '.join(moonshine_onnx.transcribe(sys.argv[1], '${MOONSHINE_MODEL}')).strip())\n`;
  const { stdout } = await run(sttPython(), ["-c", script, wav], TRANSCRIBE_TIMEOUT);
  return stdout.trim();
}

async function transcribe(engine: Engine, wav: string): Promise<string> {
  return engine === "parakeet" ? transcribeParakeet(wav) : transcribeMoonshine(wav);
}

async function engineReady(engine: Engine): Promise<boolean> {
  if (engine === "parakeet") return !!resolveBin("parakeet-mlx");
  try {
    await run(sttPython(), ["-c", "import moonshine_onnx"], 20000);
    return true;
  } catch {
    return false;
  }
}

export default function voiceInput(pi: ExtensionAPI) {
  let engineOverride: Engine | undefined; // set by /stt, session-only
  let rec: Recording | undefined;
  let busy = false; // transcription in flight
  let idleStatus = ""; // footer text when not recording
  const setups = new Map<Engine, Promise<boolean>>(); // serialized auto-setup per engine

  pi.registerFlag("stt", { description: "Voice input STT engine: parakeet | moonshine", type: "string" });

  function currentEngine(): Engine {
    if (engineOverride) return engineOverride;
    const flag = pi.getFlag("stt");
    if (flag === "parakeet" || flag === "moonshine") return flag;
    return DEFAULT_ENGINE;
  }

  function status(ctx: ExtensionContext, text: string, idle = true): void {
    if (idle) idleStatus = text;
    ctx.ui.setStatus("voice-input", text);
  }

  // ── Background auto-setup: venv → pip install → model pre-download ──
  // Fire-and-forget from session_start; awaited (already-resolved) in toggle().
  // On failure the cached promise is dropped so the next use retries.
  function ensureEngine(ctx: ExtensionContext, engine: Engine): Promise<boolean> {
    let p = setups.get(engine);
    if (!p) {
      p = doSetup(ctx, engine);
      setups.set(engine, p);
      p.then((ok) => {
        if (!ok) setups.delete(engine);
      });
    }
    return p;
  }

  async function doSetup(ctx: ExtensionContext, engine: Engine): Promise<boolean> {
    try {
      // 1. ffmpeg (recording + parakeet CLI decoding)
      if (!resolveBin("ffmpeg")) {
        const brew = resolveBin("brew");
        if (!brew) {
          status(ctx, "🎤 ffmpeg missing and no homebrew found — cannot auto-install");
          return false;
        }
        status(ctx, "🎤 setting up: installing ffmpeg (brew)…");
        logSetup("brew install ffmpeg");
        await run(brew, ["install", "ffmpeg"], INSTALL_TIMEOUT);
      }

      // 2. engine package (skipped when already importable/on PATH)
      if (!(await engineReady(engine))) {
        const venvPy = path.join(VENV_BIN, "python");
        if (!fs.existsSync(venvPy)) {
          status(ctx, `🎤 setting up ${engine}: creating venv…`);
          logSetup(`python3 -m venv ${VENV_DIR}`);
          await run(resolveBin("python3") || "python3", ["-m", "venv", VENV_DIR], INSTALL_TIMEOUT);
        }
        status(ctx, `🎤 setting up ${engine}: installing ${PKG[engine]}…`);
        logSetup(`pip install -U ${PKG[engine]}`);
        const pipOut = await run(path.join(VENV_BIN, "pip"), ["install", "-U", PKG[engine]], INSTALL_TIMEOUT);
        logSetup(pipOut.stdout.slice(-1000));
      }

      // 3. model pre-download: transcribe 1s of silence end-to-end. Validates
      // the whole pipeline and pulls the model so first real use is instant.
      status(ctx, `🎤 setting up ${engine}: downloading model (first time only)…`);
      const warmWav = path.join(os.tmpdir(), `pi-voice-warm-${process.pid}.wav`);
      const ffmpeg = resolveBin("ffmpeg")!;
      await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `anullsrc=r=${SAMPLE_RATE}:cl=mono`, "-t", "1", "-y", warmWav], 30000);
      logSetup(`warmup transcribe (${engine})`);
      await runWarmup(engine, warmWav);
      try { fs.unlinkSync(warmWav); } catch {}

      status(ctx, `🎤 ${TRIGGER_KEY} · ${engine} ready`);
      logSetup(`${engine} ready`);
      return true;
    } catch (err: any) {
      logSetup(`SETUP FAILED (${engine}): ${err.message ?? err}`);
      status(ctx, `🎤 ${engine} setup failed — see ${SETUP_LOG}`);
      ctx.ui.notify(`voice-input: ${engine} auto-setup failed (${String(err.message ?? err).split("\n")[0]}) — details in ${SETUP_LOG}`, "error");
      return false;
    }
  }

  // Same as transcribe() but with the long first-download timeout.
  async function runWarmup(engine: Engine, wav: string): Promise<void> {
    if (engine === "parakeet") {
      const bin = resolveBin("parakeet-mlx")!;
      await run(bin, [wav, "--model", PARAKEET_MODEL, "--output-format", "txt", "--output-dir", os.tmpdir()], WARMUP_TIMEOUT);
      try { fs.unlinkSync(path.join(os.tmpdir(), path.basename(wav, ".wav") + ".txt")); } catch {}
    } else {
      const script = `import sys, moonshine_onnx; moonshine_onnx.transcribe(sys.argv[1], '${MOONSHINE_MODEL}')`;
      await run(sttPython(), ["-c", script, wav], WARMUP_TIMEOUT);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!isEnabled()) return;
    // Compose with any editor factory another extension installed, so every
    // raw-char trigger keeps working regardless of load order.
    const prev = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = prev ? prev(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
      const baseHandleInput = editor.handleInput.bind(editor);
      editor.handleInput = (data: string) => {
        if (isTrigger(data)) {
          void toggle(ctx);
          return; // swallow the char — it never reaches the text buffer
        }
        baseHandleInput(data);
      };
      return editor;
    });
    ctx.ui.notify(`voice-input active (${currentEngine()}, press ${TRIGGER_KEY} to record/stop, /stt to switch engine)`, "info");

    // Resolve and REPORT the mic up front. The failure this prevents is silent
    // by nature — a virtual device records fine and just has nothing in it — so
    // the only defence is saying out loud which input is armed.
    void (async () => {
      try {
        const ffmpeg = resolveBin("ffmpeg");
        if (!ffmpeg) return; // setup path installs it and reports its own errors
        await resolveAudioDevice(ffmpeg);
        if (resolvedDevice) {
          ctx.ui.notify(
            `voice-input: mic → "${resolvedDevice.name}" (:${resolvedDevice.index})${deviceNote ? ` · ${deviceNote}` : ""}`,
            deviceNote.startsWith("WARNING") ? "warning" : "info",
          );
        }
      } catch { /* setup path already reports its own failures */ }
    })();
    void ensureEngine(ctx, currentEngine()); // background auto-setup, footer shows progress
  });

  pi.registerCommand("stt", {
    description: "Show or switch the voice input engine: /stt [parakeet|moonshine]",
    handler: async (args, ctx) => {
      if (!isEnabled()) {
        ctx.ui.notify("voice-input disabled (use /piforge enable voice-input)", "info");
        return;
      }
      const arg = (args ?? "").trim();
      if (arg === "parakeet" || arg === "moonshine") {
        engineOverride = arg;
        ctx.ui.notify(`voice input engine → ${arg} (this session)`, "info");
        void ensureEngine(ctx, arg); // auto-setup the newly selected engine too
      } else if (arg) {
        ctx.ui.notify(`unknown engine "${arg}" — use: /stt parakeet | /stt moonshine`, "error");
      } else {
        ctx.ui.notify(`voice input engine: ${currentEngine()} (switch: /stt parakeet | /stt moonshine)`, "info");
      }
    },
  });

  pi.registerCommand("stt-device", {
    description: "List audio inputs and show which one voice-input records. Usage: /stt-device [<index|name substring>]",
    handler: async (args: any, ctx: any) => {
      const ffmpeg = resolveBin("ffmpeg");
      if (!ffmpeg) {
        ctx.ui.notify("voice-input: ffmpeg not installed yet — press the trigger key once to run setup", "error");
        return;
      }
      const devices = await listAudioDevices(ffmpeg);
      const pick = String(args ?? "").trim();

      if (pick) {
        const byIndex = devices.find((d) => String(d.index) === pick);
        const byName = devices.find((d) => d.name.toLowerCase().includes(pick.toLowerCase()));
        const chosen = byIndex ?? byName;
        if (!chosen) {
          ctx.ui.notify(`voice-input: no input matches "${pick}". Run /stt-device with no argument to list them.`, "error");
          return;
        }
        resolvedDevice = chosen;
        deviceNote = "set manually this session";
        ctx.ui.notify(
          `voice-input: mic → "${chosen.name}" (:${chosen.index}) for this session.\n` +
          `To make it permanent, set AUDIO_DEVICE = ":${chosen.index}" in voice-input.ts and /reload.`,
          isVirtual(chosen.name) ? "warning" : "info",
        );
        return;
      }

      if (devices.length === 0) {
        ctx.ui.notify("voice-input: could not enumerate audio inputs", "error");
        return;
      }
      await resolveAudioDevice(ffmpeg);
      ctx.ui.notify(
        `voice-input inputs (● = in use):\n` +
        devices
          .map((d) => `  ${resolvedDevice?.index === d.index ? "●" : " "} [${d.index}] ${d.name}${isVirtual(d.name) ? "   (virtual — skipped)" : ""}`)
          .join("\n") +
        `\nOverride with /stt-device <index|name>.`,
        "info",
      );
    },
  });

  async function toggle(ctx: ExtensionContext): Promise<void> {
    if (!isEnabled()) return;
    if (busy) {
      ctx.ui.notify("voice-input: still transcribing previous recording…", "warning");
      return;
    }

    // ── Second press: stop recording, drain the remaining chunks ──
    // Chunks recorded so far were already transcribed and appended by the pump
    // while recording — only the tail (current partial segment) is left here.
    if (rec) {
      const current = rec;
      rec = undefined;
      clearTimeout(current.timer);
      current.stopped = true;
      busy = true;
      try {
        // SIGINT lets ffmpeg finalize the last segment cleanly (no-op if already exited).
        current.proc.kill("SIGINT");
        await current.done;
        status(ctx, "⏳ transcribing…", false);
        const drained = (await current.pump) ?? { audioSegs: 0, textChunks: 0 };
        if (drained.audioSegs === 0) {
          throw new Error("no audio captured — check mic permission for your terminal (System Settings → Privacy → Microphone)");
        }
        if (drained.textChunks === 0) {
          // Audio WAS captured (else the throw above fired), so the recording
          // was silent or unintelligible. By far the most common cause is
          // recording the wrong input — name the device rather than making the
          // user guess, which is what cost an afternoon on 2026-07-31.
          const dev = resolvedDevice ? `"${resolvedDevice.name}" (:${resolvedDevice.index})` : AUDIO_DEVICE ?? ":0";
          ctx.ui.notify(
            `voice-input: transcription came back empty — ${drained.audioSegs} segment(s) recorded from ${dev}, ` +
            `but no speech in them. Check you spoke into THAT device (/stt-device lists them), or that it is not muted.`,
            "warning",
          );
        }
      } catch (err: any) {
        ctx.ui.notify(`voice-input: ${err.message ?? err}`, "error");
      } finally {
        busy = false;
        ctx.ui.setStatus("voice-input", idleStatus || undefined);
        try { fs.rmSync(SEG_DIR, { recursive: true, force: true }); } catch {}
      }
      return;
    }

    // ── First press: start recording (segmented for streaming transcription) ──
    const ffmpeg = resolveBin("ffmpeg");
    if (!ffmpeg) {
      ctx.ui.notify("voice-input: ffmpeg not ready yet — auto-setup is running (see footer status)", "warning");
      return;
    }
    try { fs.rmSync(SEG_DIR, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(SEG_DIR, { recursive: true });
    const device = await resolveAudioDevice(ffmpeg);
    const proc = spawn(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "avfoundation", "-i", device,
      "-ar", String(SAMPLE_RATE), "-ac", "1",
      "-f", "segment", "-segment_time", String(CHUNK_SECONDS),
      "-segment_format", "wav", "-reset_timestamps", "1",
      "-y", path.join(SEG_DIR, "seg-%03d.wav"),
    ]);
    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += d));

    const recording: Recording = {
      proc,
      stopped: false,
      ended: false,
      done: new Promise<void>((resolve) => {
        proc.on("close", (code) => {
          recording.ended = true; // lets the pump finalize the last segment
          // Unsolicited exit (bad device, missing mic permission) — we did NOT
          // stop it, so report and reset. SIGINT stops exit non-zero too, hence
          // the stopped flag rather than the exit code.
          if (!recording.stopped) {
            rec = undefined;
            clearTimeout(recording.timer);
            ctx.ui.setStatus("voice-input", idleStatus || undefined);
            ctx.ui.notify(`voice-input: recorder died (code ${code}): ${stderr.slice(-300) || "no output"}`, "error");
          }
          resolve();
        });
      }),
      timer: setTimeout(() => {
        if (rec === recording) {
          recording.stopped = true;
          proc.kill("SIGINT");
          status(ctx, `■ auto-stopped after ${MAX_RECORD_MS / 1000}s — press ${TRIGGER_KEY} to finish`, false);
        }
      }, MAX_RECORD_MS),
    };
    rec = recording;
    recording.pump = drainSegments(recording, ctx);
    status(ctx, `● REC — press ${TRIGGER_KEY} to stop`, false);
  }

  // ── Streaming pump: sequential transcription queue over finished segments ──
  // Runs for the whole life of a recording. Segment i is safe to read once
  // seg i+1 exists (ffmpeg moved on) or ffmpeg exited. Each transcript is
  // appended to the editor immediately, so the prompt fills while recording.
  // Segments run strictly one at a time — no parallel engine spawns.
  async function drainSegments(recording: Recording, ctx: ExtensionContext): Promise<PumpResult> {
    const result: PumpResult = { audioSegs: 0, textChunks: 0 };
    let i = 0;
    while (true) {
      const cur = segPath(i);
      const curExists = fs.existsSync(cur);
      if (curExists && (fs.existsSync(segPath(i + 1)) || recording.ended)) {
        try {
          // < 1000 bytes = WAV header only (e.g. instant stop) — skip silently.
          if (fs.statSync(cur).size >= 1000) {
            result.audioSegs++;
            const engine = currentEngine();
            // Normally resolved long ago by session_start; first-ever use may
            // wait here while background setup finishes (footer shows progress).
            if (!(await ensureEngine(ctx, engine))) {
              throw new Error(`${engine} is not available — auto-setup failed, see ${SETUP_LOG}`);
            }
            const text = await transcribe(engine, cur);
            if (text) {
              result.textChunks++;
              const existing = ctx.ui.getEditorText();
              ctx.ui.setEditorText(existing ? `${existing.replace(/\s+$/, "")} ${text}` : text);
              if (rec === recording) {
                status(ctx, `● REC — press ${TRIGGER_KEY} to stop · ${result.textChunks} chunk${result.textChunks === 1 ? "" : "s"} transcribed`, false);
              }
            }
          }
        } catch (err: any) {
          // Notify once and stop draining — later chunks would hit the same
          // failure (engine missing) and spam errors. Files are cleaned up by
          // the stop handler / next recording start.
          ctx.ui.notify(`voice-input: ${err.message ?? err}`, "error");
          break;
        } finally {
          try { fs.unlinkSync(cur); } catch {}
        }
        i++;
        continue;
      }
      if (recording.ended && !curExists) break; // recorder done, queue drained
      await sleep(250);
    }
    return result;
  }
}

interface Recording {
  proc: ChildProcess;
  done: Promise<void>;   // resolves when ffmpeg has exited (all segments finalized)
  stopped: boolean;      // we asked it to stop (user press or auto-stop timer)
  ended: boolean;        // ffmpeg has exited — pump may consume the last segment
  timer: ReturnType<typeof setTimeout>;
  pump?: Promise<PumpResult>; // streaming transcription queue; resolves when drained
}

interface PumpResult {
  audioSegs: number;     // segments that contained real audio (0 → mic problem)
  textChunks: number;    // segments that produced non-empty text
}
