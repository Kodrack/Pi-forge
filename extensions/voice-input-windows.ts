// voice-input-windows.ts
// Push-to-talk voice input for Pi on WINDOWS. Press the TRIGGER_KEY (è) to start
// recording the mic, press it again to stop — audio is transcribed LOCALLY (no
// cloud) and appended to the input editor. Press Enter to send, as usual.
//
// This is a sibling of voice-input.ts, not a port of it. That extension cannot
// run here at all: it transcribes through parakeet-mlx, and MLX is Apple
// Silicon only. Three things therefore differ, and each is a forced move:
//
//   1. ENGINE — Parakeet TDT 0.6B v3 via onnx-asr / ONNX Runtime instead of
//      parakeet-mlx. Same model generation, a runtime that exists on Windows.
//      CPU by default; set PROVIDER to DmlExecutionProvider for a DirectML GPU
//      (AMD/Intel/NVIDIA alike) if you want to trade reliability for speed.
//
//   2. CAPTURE — Python sounddevice instead of ffmpeg avfoundation. The mac
//      build can auto-install ffmpeg through homebrew; Windows has no package
//      manager we can assume. Since a Python venv is needed for the engine
//      regardless, capture and transcription share one toolchain instead of
//      making the user install a second one by hand.
//
//   3. PERSISTENT WORKER — the mac build spawns parakeet-mlx per chunk. ONNX
//      Runtime re-reads and graph-optimises the model on every load, and that
//      is not free. Measured on this box (Ryzen-class CPU, quantised v3 repo):
//        warm model load   4.1s
//        transcribe        ~0.55s for 7.4s of speech (~12x realtime)
//      A per-chunk spawn would therefore pay 4.1s to do 1.5s of work on a 20s
//      chunk — the transcript would land ~4s after each segment closed, and
//      the stall would repeat all the way through a long dictation. So the
//      engine is a long-lived process that loads once and takes WAV paths on
//      stdin. Cost of that choice: unlike the mac build, this holds model
//      memory between chunks — so the worker starts lazily on the first
//      recording and is shut down after WORKER_IDLE_MS of no dictation.
//
// STREAMING: recording is segmented into CHUNK_SECONDS WAV files. A sequential
// queue transcribes each segment as soon as it is finalized — WHILE recording
// continues — and appends the text to the editor, so long dictation fills the
// prompt gradually. CHUNK_SECONDS is 20, not the mac build's 30: onnx-asr
// documents a 20–30s ceiling for these models, and 30 sits on the edge of it.
//
// STOPPING: the recorder is stopped by writing "stop" to its stdin, NOT by a
// signal. On Windows, Node's child.kill("SIGINT") hard-terminates rather than
// delivering a catchable signal, which would truncate the final segment.
//
// ZERO-SETUP: on session start the extension provisions itself in the
// background — creates a venv at ~/.pi/stt-venv-win, pip-installs onnx-asr and
// sounddevice, writes its two Python helpers to ~/.pi/stt-win/, and pre-loads
// the model so first real use is instant. Footer reports each step. Setup
// output is logged to ~/.pi/stt-setup-win.log. Model files are cached by
// HuggingFace in ~/.cache/huggingface (~115MB for this quantised repo).
//
// The trigger is a bare accented character, which pi-tui's registerShortcut key
// matcher can't represent (ASCII-only KeyId) — so this extension wraps the
// input editor via ctx.ui.setEditorComponent/CustomEditor and intercepts the
// raw character in handleInput. Consequence: you can no longer TYPE è into the
// prompt (paste still works). Composes with other extensions that wrap the
// editor the same way, whatever the load order.
//
// Commands are deliberately named /stt-win and /stt-win-device rather than
// reusing the mac build's /stt and /stt-device. Both files may sit in the
// extensions directory together, and an extension should not depend on its
// sibling's platform guard being correct in order to avoid a name collision.
//
// Install: copy to ~/.pi/agent/extensions/voice-input-windows.ts
// Toggle:  /piforge disable voice-input-windows

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, execFile, type ChildProcess } from "child_process";

const EXT_NAME = "voice-input-windows";
const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

// ---------- TRIGGER ----------
const TRIGGER_KEY = "è"; // record / stop toggle (raw char, intercepted in the editor)
// Kitty keyboard protocol may deliver the key as a CSI-u sequence instead of
// the raw char: ESC [ <codepoint> u — accept press/repeat, ignore release (:3).
const TRIGGER_CSI = new RegExp(`^\\x1b\\[${TRIGGER_KEY.codePointAt(0)}(;1(:[12])?)?u$`);
function isTrigger(data: string): boolean {
  return data === TRIGGER_KEY || TRIGGER_CSI.test(data);
}

// ---------- TUNABLES ----------
const MODEL_ID = "nemo-parakeet-tdt-0.6b-v3";
// "" = CPU (onnxruntime). "DmlExecutionProvider" = DirectML GPU, which needs
// `pip install onnxruntime-directml` in the venv. CPU is the default because a
// wrong/unavailable provider fails at model load, and dictation that silently
// stops working is worse than dictation that is a little slower.
const PROVIDER = "";
const CHUNK_SECONDS = 20;          // segment length; onnx-asr caps these models at 20–30s
const MAX_RECORD_MS = 600000;      // auto-stop safety net (10 min)
const WORKER_IDLE_MS = 300000;     // shut the engine down after 5 min of no dictation
const WORKER_READY_TIMEOUT = 1800000; // first run downloads the model
const TRANSCRIBE_TIMEOUT = 300000;
const INSTALL_TIMEOUT = 1800000;

// ---------- PATHS ----------
const VENV_DIR = path.join(os.homedir(), ".pi", "stt-venv-win");
const VENV_PY = path.join(VENV_DIR, "Scripts", "python.exe");
const SCRIPT_DIR = path.join(os.homedir(), ".pi", "stt-win");
const RECORD_PY = path.join(SCRIPT_DIR, "stt_record.py");
const WORKER_PY = path.join(SCRIPT_DIR, "stt_worker.py");
const SETUP_LOG = path.join(os.homedir(), ".pi", "stt-setup-win.log");
const SEG_DIR = path.join(os.tmpdir(), `pi-voice-${process.pid}`);
const segPath = (i: number) => path.join(SEG_DIR, `seg-${String(i).padStart(3, "0")}.wav`);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------- EMBEDDED PYTHON ----------
// Written to SCRIPT_DIR at setup so the extension stays a single installable
// file. Both sources are kept free of backslashes and of the dollar-brace
// sequence precisely so they can live inside these template literals unharmed.
const RECORDER_SOURCE = String.raw`"""Segmented microphone recorder for pi voice-input (Windows).

Replaces the macOS build's ffmpeg avfoundation + segment-muxer pipeline.
Rationale: Windows has no guaranteed package manager to auto-install ffmpeg,
and we already need a Python venv for the STT engine, so capture and
transcription share one toolchain instead of two.

Writes 16 kHz mono 16-bit WAV segments named seg-000.wav, seg-001.wav, ... into
OUT_DIR. Segment i is complete once seg-(i+1) exists, or once this process has
exited - the same contract the TypeScript pump relies on.

Stop protocol: the parent writes the line "stop" to stdin, or closes stdin.
We deliberately do NOT use SIGINT: on Windows, Node's child.kill("SIGINT")
hard-terminates rather than delivering a catchable signal, which would truncate
the final segment mid-write.

NOTE: this source is embedded verbatim in voice-input-windows.ts and written to
disk at setup. Keep it free of backslashes and of the dollar-brace sequence, so
it survives being carried inside a TypeScript template literal.

Usage: python stt_record.py OUT_DIR CHUNK_SECONDS [DEVICE_INDEX]
"""

import json
import os
import queue
import sys
import threading
import wave

NL = chr(10)
RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2  # int16


def emit(**kw):
    sys.stdout.write(json.dumps(kw) + NL)
    sys.stdout.flush()


def list_devices():
    """--list mode: report input devices as one JSON line for the extension.

    Windows exposes the same physical mic once per host API (MME, DirectSound,
    WASAPI, WDM-KS), plus virtual inputs from Steam, Oculus, SteelSeries and the
    like. The extension needs the host API and the default flag to present a
    sane list, so both are included here rather than guessed on the far side.
    """
    try:
        import sounddevice as sd
    except Exception as e:
        emit(event="error", message="sounddevice import failed: %s" % e)
        return 1
    try:
        default_in = sd.default.device[0]
    except Exception:
        default_in = -1
    out = []
    for i, d in enumerate(sd.query_devices()):
        if d.get("max_input_channels", 0) <= 0:
            continue
        try:
            api = sd.query_hostapis(d["hostapi"])["name"]
        except Exception:
            api = "?"
        out.append({
            "index": i,
            "name": str(d.get("name", "?")),
            "channels": int(d.get("max_input_channels", 0)),
            "api": api,
            "default": (i == default_in),
        })
    emit(event="devices", devices=out)
    return 0


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--list":
        return list_devices()

    if len(sys.argv) < 3:
        emit(event="error", message="usage: stt_record.py OUT_DIR CHUNK_SECONDS [DEVICE_INDEX] | --list")
        return 2

    out_dir = sys.argv[1]
    chunk_seconds = float(sys.argv[2])
    device = None
    if len(sys.argv) > 3 and sys.argv[3].strip() != "":
        try:
            device = int(sys.argv[3])
        except ValueError:
            device = sys.argv[3]

    try:
        import sounddevice as sd
    except Exception as e:
        emit(event="error", message="sounddevice import failed: %s" % e)
        return 1

    os.makedirs(out_dir, exist_ok=True)

    probe = device
    if probe is None:
        try:
            probe = sd.default.device[0]
        except Exception:
            probe = None
    try:
        info = sd.query_devices(probe, "input")
        emit(event="device", name=str(info.get("name", "?")))
    except Exception as e:
        emit(event="error", message="no usable input device: %s" % e)
        return 1

    stop = threading.Event()

    def watch_stdin():
        # The parent closes stdin (or sends "stop") to request a clean finish.
        try:
            for line in sys.stdin:
                if line.strip() == "stop":
                    break
        except Exception:
            pass
        stop.set()

    threading.Thread(target=watch_stdin, daemon=True).start()

    frames_per_segment = int(RATE * chunk_seconds)
    audio_q = queue.Queue()

    def callback(indata, _frames, _time, status):
        if status:
            # Overflows are recoverable: report and keep going.
            emit(event="warn", message=str(status))
        audio_q.put(bytes(indata))

    seg_index = 0

    try:
        with sd.RawInputStream(
            samplerate=RATE,
            channels=CHANNELS,
            dtype="int16",
            device=device,
            callback=callback,
            blocksize=int(RATE * 0.1),
        ):
            emit(event="recording")
            while not stop.is_set():
                seg_path = os.path.join(out_dir, "seg-%03d.wav" % seg_index)
                frames_written = 0
                wf = wave.open(seg_path, "wb")
                wf.setnchannels(CHANNELS)
                wf.setsampwidth(SAMPLE_WIDTH)
                wf.setframerate(RATE)
                try:
                    while frames_written < frames_per_segment and not stop.is_set():
                        try:
                            data = audio_q.get(timeout=0.2)
                        except queue.Empty:
                            continue
                        wf.writeframes(data)
                        frames_written += len(data) // (SAMPLE_WIDTH * CHANNELS)
                finally:
                    wf.close()

                if frames_written == 0:
                    # Nothing captured in this slot (instant stop): drop the
                    # header-only file so the pump sees no phantom segment.
                    try:
                        os.unlink(seg_path)
                    except OSError:
                        pass
                    break

                emit(event="segment", index=seg_index, frames=frames_written)
                seg_index += 1
    except Exception as e:
        emit(event="error", message="capture failed: %s" % e)
        return 1

    emit(event="done", segments=seg_index)
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;
const WORKER_SOURCE = String.raw`"""Persistent Parakeet transcription worker for pi voice-input (Windows).

The macOS build spawns parakeet-mlx fresh for every audio chunk and relies on
MLX's fast model load to make that cheap. The ONNX Runtime path used here has a
much heavier cold start (the 0.6B model is read and graph-optimised on every
load), so a per-chunk spawn would cost more than the chunk itself and streaming
transcription would fall behind the speaker.

So this is a long-lived process instead: load the model once, then read one WAV
path per line on stdin and write one JSON result per line on stdout. The parent
starts it lazily on the first recording and shuts it down after an idle period,
so memory is only held while dictation is actually in use.

Protocol
  stdout: {"event": "ready"}                  once the model is loaded
          {"ok": true, "text": "..."}         per transcribed path
          {"ok": false, "error": "..."}       per failed path
          {"event": "fatal", "message": ...}  load failure, then exit 1
  stdin : one absolute WAV path per line, or __quit__ to exit

NOTE: this source is embedded verbatim in voice-input-windows.ts and written to
disk at setup. Keep it free of backslashes and of the dollar-brace sequence, so
it survives being carried inside a TypeScript template literal.

Usage: python stt_worker.py MODEL_ID [PROVIDER]
  PROVIDER is an optional ONNX Runtime execution provider, e.g.
  DmlExecutionProvider for AMD/Intel GPUs on Windows. Omit for CPU.
"""

import json
import sys

NL = chr(10)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + NL)
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        emit({"event": "fatal", "message": "usage: stt_worker.py MODEL_ID [PROVIDER]"})
        return 2

    model_id = sys.argv[1]
    provider = sys.argv[2].strip() if len(sys.argv) > 2 else ""

    try:
        import onnx_asr
    except Exception as e:
        emit({"event": "fatal", "message": "onnx_asr import failed: %s" % e})
        return 1

    try:
        if provider:
            model = onnx_asr.load_model(model_id, providers=[provider])
        else:
            model = onnx_asr.load_model(model_id)
    except Exception as e:
        emit({"event": "fatal", "message": "model load failed: %s" % e})
        return 1

    emit({"event": "ready"})

    for line in sys.stdin:
        wav = line.strip()
        if not wav:
            continue
        if wav == "__quit__":
            break
        try:
            text = model.recognize(wav)
            emit({"ok": True, "text": (text or "").strip()})
        except Exception as e:
            emit({"ok": False, "error": str(e)})

    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes(EXT_NAME);
  } catch {
    return true;
  }
}

function logSetup(line: string): void {
  try {
    fs.appendFileSync(SETUP_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

// Pi may run with a slim PATH; Windows needs the .exe suffix and ';' splitting.
function resolveBin(name: string): string | undefined {
  const exe = name.toLowerCase().endsWith(".exe") ? name : `${name}.exe`;
  for (const dir of (process.env.PATH || "").split(";")) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    // WindowsApps holds the Microsoft Store *alias* stubs: launching that
    // "python.exe" opens the Store instead of running an interpreter. Skipping
    // it here is what keeps venv creation from hanging on a GUI nobody sees.
    if (dir.toLowerCase().includes(path.join("microsoft", "windowsapps").toLowerCase())) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return undefined;
}

function run(bin: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}\n${String(stderr).slice(-600)}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// Base interpreter used ONLY to create the venv. The `py` launcher is preferred
// because it is the one Windows install that is never a Store alias stub.
function baseInterpreter(): { bin: string; args: string[] } | undefined {
  const py = resolveBin("py");
  if (py) return { bin: py, args: ["-3"] };
  const python = resolveBin("python");
  if (python) return { bin: python, args: [] };
  return undefined;
}

function venvReady(): boolean {
  return fs.existsSync(VENV_PY);
}

function materializeScripts(): void {
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  // Rewritten every setup so an upgraded extension ships upgraded helpers.
  fs.writeFileSync(RECORD_PY, RECORDER_SOURCE, "utf-8");
  fs.writeFileSync(WORKER_PY, WORKER_SOURCE, "utf-8");
}

interface AudioDevice {
  index: number;
  name: string;
  channels: number;
  api: string;
  default: boolean;
}

// Virtual inputs are abundant on Windows (Steam, Oculus, SteelSeries, VB-Cable,
// Bigscreen). They record silence perfectly happily, which is the failure mode
// that wastes an afternoon, so they are named as suspect rather than hidden.
const VIRTUAL_PATTERNS = [
  "steam", "oculus", "virtual", "vb-audio", "vb-cable", "cable", "voicemeeter",
  "bigscreen", "sonar", "sound mapper", "primary sound", "primario", "stereo mix",
  "missaggio", "wave speaker", "streaming",
];
function isVirtual(name: string): boolean {
  const n = name.toLowerCase();
  return VIRTUAL_PATTERNS.some((p) => n.includes(p));
}

async function listDevices(): Promise<AudioDevice[]> {
  const { stdout } = await run(VENV_PY, [RECORD_PY, "--list"], 30000);
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.event === "devices") return obj.devices as AudioDevice[];
    } catch {}
  }
  return [];
}

export default function voiceInputWindows(pi: ExtensionAPI) {
  // Hard platform guard. Installing this alongside the macOS build must be
  // harmless, so on any other platform it registers nothing at all.
  if (process.platform !== "win32") return;
  if (!isEnabled()) return;

  let rec: Recording | undefined;
  let busy = false;
  let idleStatus = "";
  let setupPromise: Promise<boolean> | undefined;
  let worker: Worker | undefined;
  let deviceOverride: number | undefined;
  let reportedDevice = "";

  function status(ctx: ExtensionContext, text: string, idle = true): void {
    if (idle) idleStatus = text;
    ctx.ui.setStatus(EXT_NAME, text);
  }

  // ── Background auto-setup: venv → pip → helpers → model preload ──
  function ensureSetup(ctx: ExtensionContext): Promise<boolean> {
    if (!setupPromise) {
      setupPromise = doSetup(ctx);
      setupPromise.then((ok) => {
        if (!ok) setupPromise = undefined; // let the next use retry
      });
    }
    return setupPromise;
  }

  async function doSetup(ctx: ExtensionContext): Promise<boolean> {
    try {
      materializeScripts();

      if (!venvReady()) {
        const base = baseInterpreter();
        if (!base) {
          status(ctx, "🎤 no Python found — install Python 3.10+ and /reload");
          logSetup("no python interpreter on PATH");
          return false;
        }
        status(ctx, "🎤 setting up: creating venv…");
        logSetup(`${base.bin} ${base.args.join(" ")} -m venv ${VENV_DIR}`);
        await run(base.bin, [...base.args, "-m", "venv", VENV_DIR], INSTALL_TIMEOUT);
      }

      // pip is cheap to re-run once satisfied, and it repairs a half-built venv.
      status(ctx, "🎤 setting up: installing onnx-asr + sounddevice…");
      logSetup("pip install onnx-asr[cpu,hub] sounddevice");
      await run(VENV_PY, ["-m", "pip", "install", "--disable-pip-version-check", "-q",
        "onnx-asr[cpu,hub]", "sounddevice"], INSTALL_TIMEOUT);

      if (PROVIDER === "DmlExecutionProvider") {
        status(ctx, "🎤 setting up: installing onnxruntime-directml…");
        logSetup("pip install onnxruntime-directml");
        await run(VENV_PY, ["-m", "pip", "install", "--disable-pip-version-check", "-q",
          "onnxruntime-directml"], INSTALL_TIMEOUT);
      }

      // Preload: starting the worker downloads the model on first ever run and
      // proves the engine actually loads, rather than discovering it mid-speech.
      status(ctx, "🎤 setting up: loading model (first run downloads it)…");
      const w = await startWorker(ctx);
      if (!w) return false;

      status(ctx, `🎤 ${TRIGGER_KEY} · parakeet ready`);
      return true;
    } catch (err: any) {
      logSetup(`setup failed: ${err?.message ?? err}`);
      status(ctx, `🎤 setup failed — see ${SETUP_LOG}`);
      return false;
    }
  }

  // ── Persistent transcription worker ──
  function killWorker(): void {
    if (!worker) return;
    const w = worker;
    worker = undefined;
    clearTimeout(w.idleTimer);
    try { w.proc.stdin?.write("__quit__\n"); } catch {}
    try { w.proc.kill(); } catch {}
  }

  function touchWorker(): void {
    if (!worker) return;
    clearTimeout(worker.idleTimer);
    worker.idleTimer = setTimeout(killWorker, WORKER_IDLE_MS);
  }

  async function startWorker(ctx: ExtensionContext): Promise<Worker | undefined> {
    if (worker) return worker;
    if (!venvReady()) return undefined;

    const args = [WORKER_PY, MODEL_ID];
    if (PROVIDER) args.push(PROVIDER);
    const proc = spawn(VENV_PY, args, { windowsHide: true });

    const pending: Array<{ resolve: (t: string) => void; reject: (e: Error) => void }> = [];
    let stderrTail = "";
    let buf = "";
    let readyResolve!: (ok: boolean) => void;
    const ready = new Promise<boolean>((r) => (readyResolve = r));

    proc.stderr?.on("data", (d) => {
      stderrTail = (stderrTail + String(d)).slice(-800);
    });

    proc.stdout?.on("data", (d) => {
      buf += String(d);
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.event === "ready") { readyResolve(true); continue; }
        if (msg.event === "fatal") {
          logSetup(`worker fatal: ${msg.message}`);
          readyResolve(false);
          const waiting = pending.splice(0);
          waiting.forEach((p) => p.reject(new Error(msg.message)));
          continue;
        }
        const next = pending.shift();
        if (!next) continue;
        if (msg.ok) next.resolve(String(msg.text ?? ""));
        else next.reject(new Error(String(msg.error ?? "transcription failed")));
      }
    });

    proc.on("close", (code) => {
      if (worker && worker.proc === proc) worker = undefined;
      readyResolve(false);
      const waiting = pending.splice(0);
      waiting.forEach((p) =>
        p.reject(new Error(`engine exited (code ${code}): ${stderrTail.slice(-300) || "no output"}`)),
      );
    });

    const w: Worker = {
      proc,
      pending,
      idleTimer: setTimeout(killWorker, WORKER_IDLE_MS),
      transcribe(wav: string) {
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("transcription timed out")), TRANSCRIBE_TIMEOUT);
          pending.push({
            resolve: (t) => { clearTimeout(timer); resolve(t); },
            reject: (e) => { clearTimeout(timer); reject(e); },
          });
          try {
            proc.stdin?.write(wav + "\n");
          } catch (e: any) {
            clearTimeout(timer);
            pending.pop();
            reject(new Error(`engine not writable: ${e?.message ?? e}`));
          }
        });
      },
    };
    worker = w;

    const okTimer = setTimeout(() => readyResolve(false), WORKER_READY_TIMEOUT);
    const ok = await ready;
    clearTimeout(okTimer);
    if (!ok) {
      killWorker();
      ctx.ui.notify(`${EXT_NAME}: engine failed to start — see ${SETUP_LOG}`, "error");
      return undefined;
    }
    touchWorker();
    return w;
  }

  // ── Session wiring ──
  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    const prev = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => {
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
    ctx.ui.notify(
      `${EXT_NAME} active (parakeet/onnx, press ${TRIGGER_KEY} to record/stop, /stt-win-device to pick a mic)`,
      "info",
    );

    void (async () => {
      const ok = await ensureSetup(ctx);
      if (!ok) return;
      // Name the mic out loud. A virtual device records silence perfectly
      // happily, so the only defence against it is saying which input is armed.
      try {
        const devices = await listDevices();
        const chosen = pickDevice(devices);
        if (chosen) {
          reportedDevice = `"${chosen.name}" (:${chosen.index}, ${chosen.api})`;
          ctx.ui.notify(
            `${EXT_NAME}: mic → ${reportedDevice}` +
              (isVirtual(chosen.name) ? " · WARNING: looks like a virtual device — /stt-win-device to change" : ""),
            isVirtual(chosen.name) ? "warning" : "info",
          );
        }
      } catch {}
    })();
  });

  function pickDevice(devices: AudioDevice[]): AudioDevice | undefined {
    if (deviceOverride !== undefined) return devices.find((d) => d.index === deviceOverride);
    const def = devices.find((d) => d.default);
    if (def && !isVirtual(def.name)) return def;
    // System default is virtual (or absent) — prefer any real-looking input.
    return devices.find((d) => !isVirtual(d.name)) ?? def ?? devices[0];
  }

  pi.registerCommand("stt-win", {
    description: "Voice input (Windows) status: engine, model, setup log",
    handler: async (_args: any, ctx: any) => {
      ctx.ui.notify(
        `${EXT_NAME}\n` +
          `  model:   ${MODEL_ID}\n` +
          `  runtime: onnxruntime ${PROVIDER || "(CPU)"}\n` +
          `  venv:    ${VENV_DIR} ${venvReady() ? "✓" : "(not built yet)"}\n` +
          `  engine:  ${worker ? "loaded" : "idle (starts on first recording)"}\n` +
          `  mic:     ${reportedDevice || "(not resolved yet)"}\n` +
          `  log:     ${SETUP_LOG}`,
        "info",
      );
    },
  });

  pi.registerCommand("stt-win-device", {
    description: "List audio inputs and choose one. Usage: /stt-win-device [<index|name substring>]",
    handler: async (args: any, ctx: any) => {
      if (!venvReady()) {
        ctx.ui.notify(`${EXT_NAME}: setup has not finished yet — see the footer`, "warning");
        return;
      }
      let devices: AudioDevice[];
      try {
        devices = await listDevices();
      } catch (err: any) {
        ctx.ui.notify(`${EXT_NAME}: could not list inputs — ${err?.message ?? err}`, "error");
        return;
      }
      if (devices.length === 0) {
        ctx.ui.notify(`${EXT_NAME}: no input devices found`, "error");
        return;
      }

      const pick = String(args ?? "").trim();
      if (pick) {
        const byIndex = devices.find((d) => String(d.index) === pick);
        const byName = devices.find((d) => d.name.toLowerCase().includes(pick.toLowerCase()));
        const chosen = byIndex ?? byName;
        if (!chosen) {
          ctx.ui.notify(`${EXT_NAME}: no input matches "${pick}" — run /stt-win-device to list them`, "error");
          return;
        }
        deviceOverride = chosen.index;
        reportedDevice = `"${chosen.name}" (:${chosen.index}, ${chosen.api})`;
        ctx.ui.notify(
          `${EXT_NAME}: mic → ${reportedDevice} for this session.\n` +
            `To make it permanent, set deviceOverride via this command in each session, or edit the extension.`,
          isVirtual(chosen.name) ? "warning" : "info",
        );
        return;
      }

      const current = pickDevice(devices);
      const lines = devices.map((d) => {
        const mark = current && d.index === current.index ? "→" : " ";
        const tag = isVirtual(d.name) ? " [virtual?]" : "";
        const def = d.default ? " [system default]" : "";
        return `${mark} ${String(d.index).padStart(3)}  ${d.name}  (${d.api}, ${d.channels}ch)${def}${tag}`;
      });
      ctx.ui.notify(
        `${EXT_NAME} inputs (→ = in use):\n${lines.join("\n")}\n` +
          `Choose with: /stt-win-device <index>`,
        "info",
      );
    },
  });

  // ── Record / stop ──
  async function toggle(ctx: ExtensionContext): Promise<void> {
    if (busy) {
      ctx.ui.notify(`${EXT_NAME}: still transcribing previous recording…`, "warning");
      return;
    }

    // Second press: stop, then drain whatever the pump has not consumed yet.
    if (rec) {
      const current = rec;
      rec = undefined;
      clearTimeout(current.timer);
      current.stopped = true;
      busy = true;
      try {
        // stdin, not a signal — see the header note on kill("SIGINT").
        try { current.proc.stdin?.write("stop\n"); } catch {}
        try { current.proc.stdin?.end(); } catch {}
        await current.done;
        status(ctx, "⏳ transcribing…", false);
        const drained = (await current.pump) ?? { audioSegs: 0, textChunks: 0 };
        if (drained.audioSegs === 0) {
          throw new Error(
            "no audio captured — check Windows Settings → Privacy → Microphone allows desktop apps, " +
              "and that the armed input is not muted (/stt-win-device)",
          );
        }
        if (drained.textChunks === 0) {
          ctx.ui.notify(
            `${EXT_NAME}: transcription came back empty — ${drained.audioSegs} segment(s) recorded from ` +
              `${reportedDevice || "the default input"}, but no speech in them. Check you spoke into THAT ` +
              `device (/stt-win-device lists them), or that it is not muted.`,
            "warning",
          );
        }
      } catch (err: any) {
        ctx.ui.notify(`${EXT_NAME}: ${err?.message ?? err}`, "error");
      } finally {
        busy = false;
        ctx.ui.setStatus(EXT_NAME, idleStatus || undefined);
        try { fs.rmSync(SEG_DIR, { recursive: true, force: true }); } catch {}
      }
      return;
    }

    // First press: make sure the toolchain is there, then record.
    if (!venvReady()) {
      ctx.ui.notify(`${EXT_NAME}: setup still running — see the footer`, "warning");
      void ensureSetup(ctx);
      return;
    }

    try { fs.rmSync(SEG_DIR, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(SEG_DIR, { recursive: true });

    const args = [RECORD_PY, SEG_DIR, String(CHUNK_SECONDS)];
    if (deviceOverride !== undefined) args.push(String(deviceOverride));
    const proc = spawn(VENV_PY, args, { windowsHide: true });

    let stderrTail = "";
    proc.stderr?.on("data", (d) => (stderrTail = (stderrTail + String(d)).slice(-800)));

    let sawError = "";
    let outBuf = "";
    proc.stdout?.on("data", (d) => {
      outBuf += String(d);
      let nl: number;
      while ((nl = outBuf.indexOf("\n")) !== -1) {
        const line = outBuf.slice(0, nl).trim();
        outBuf = outBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.event === "device" && !reportedDevice) reportedDevice = `"${msg.name}"`;
          if (msg.event === "error") sawError = String(msg.message ?? "");
        } catch {}
      }
    });

    const recording: Recording = {
      proc,
      stopped: false,
      ended: false,
      done: new Promise<void>((resolve) => {
        proc.on("close", (code) => {
          recording.ended = true; // lets the pump finalize the last segment
          if (!recording.stopped) {
            rec = undefined;
            clearTimeout(recording.timer);
            ctx.ui.setStatus(EXT_NAME, idleStatus || undefined);
            ctx.ui.notify(
              `${EXT_NAME}: recorder died (code ${code}): ${sawError || stderrTail.slice(-300) || "no output"}`,
              "error",
            );
          }
          resolve();
        });
      }),
      timer: setTimeout(() => {
        if (rec === recording) {
          recording.stopped = true;
          try { proc.stdin?.write("stop\n"); proc.stdin?.end(); } catch {}
          status(ctx, `■ auto-stopped after ${MAX_RECORD_MS / 1000}s — press ${TRIGGER_KEY} to finish`, false);
        }
      }, MAX_RECORD_MS),
    };
    rec = recording;
    recording.pump = drainSegments(recording, ctx);
    status(ctx, `● REC — press ${TRIGGER_KEY} to stop`, false);
  }

  // ── Streaming pump: sequential transcription over finished segments ──
  // Segment i is safe to read once seg i+1 exists (the recorder moved on) or the
  // recorder exited. Each transcript is appended immediately, so the prompt
  // fills while recording. Strictly one at a time — no parallel engine calls.
  async function drainSegments(recording: Recording, ctx: ExtensionContext): Promise<PumpResult> {
    const result: PumpResult = { audioSegs: 0, textChunks: 0 };
    let i = 0;
    while (true) {
      const cur = segPath(i);
      const curExists = fs.existsSync(cur);
      if (curExists && (fs.existsSync(segPath(i + 1)) || recording.ended)) {
        try {
          // < 1000 bytes = header only (instant stop) — skip silently.
          if (fs.statSync(cur).size >= 1000) {
            result.audioSegs++;
            const w = worker ?? (await startWorker(ctx));
            if (!w) throw new Error(`engine unavailable — see ${SETUP_LOG}`);
            touchWorker();
            const text = await w.transcribe(cur);
            touchWorker();
            if (text) {
              result.textChunks++;
              const existing = ctx.ui.getEditorText();
              ctx.ui.setEditorText(existing ? `${existing.replace(/\s+$/, "")} ${text}` : text);
              if (rec === recording) {
                status(
                  ctx,
                  `● REC — press ${TRIGGER_KEY} to stop · ${result.textChunks} chunk${result.textChunks === 1 ? "" : "s"} transcribed`,
                  false,
                );
              }
            }
          }
        } catch (err: any) {
          // Notify once and stop draining — later chunks would hit the same
          // failure and spam identical errors.
          ctx.ui.notify(`${EXT_NAME}: ${err?.message ?? err}`, "error");
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

interface Worker {
  proc: ChildProcess;
  pending: Array<{ resolve: (t: string) => void; reject: (e: Error) => void }>;
  idleTimer: ReturnType<typeof setTimeout>;
  transcribe(wav: string): Promise<string>;
}

interface Recording {
  proc: ChildProcess;
  done: Promise<void>; // resolves when the recorder has exited
  stopped: boolean;    // we asked it to stop (user press or auto-stop timer)
  ended: boolean;      // recorder exited — pump may consume the last segment
  timer: ReturnType<typeof setTimeout>;
  pump?: Promise<PumpResult>;
}

interface PumpResult {
  audioSegs: number;  // segments containing real audio (0 → mic problem)
  textChunks: number; // segments that produced non-empty text
}
