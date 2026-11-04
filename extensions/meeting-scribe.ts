// meeting-scribe.ts
// Records a call (Teams, Zoom, Meet, anything that makes sound) and writes a
// speaker-labelled transcript to .think/meetings/<timestamp>.md — fully local,
// no cloud, nothing leaves the machine.
//
//   /scribe setup    install deps + models, check the audio route
//   /scribe start    begin recording (add --no-mic to capture only the far end)
//   /scribe stop     finish, drain the queue, print the transcript path
//   /scribe status   what is running, for how long, how many lines so far
//
// TWO STREAMS. macOS cannot record its own output, so system audio is captured
// through the BlackHole virtual device (the call) and the mic is captured
// separately (you). BOTH are diarized by scribe-worker.py against one shared
// identity store, so a person keeps a single label whichever stream carries
// them. Which voice is yours is decided at /scribe stop from how much each was
// heard on the mic vs the system stream, and the transcript is relabelled "Me"
// in place — live lines say "Speaker N" because it is not knowable from the
// first chunk. Nothing is assumed about how many people the mic can hear, so an
// in-person meeting or a speakerphone is separated just like a call.
//
// LONG CALLS ARE FINE. ffmpeg's segment muxer writes CHUNK_SECONDS-long wavs and
// a pump transcribes each one as it is finalized, while recording continues, so
// memory and latency stay flat whether the call is 5 minutes or 3 hours. The
// transcript file is appended as it goes — kill the terminal mid-call and
// everything up to that point is already on disk. Processing need not keep up
// in real time; the tail drains after /scribe stop.
//
// SETUP (one time, needs your password so it cannot be done silently):
//   1. brew install --cask blackhole-2ch
//   2. Audio MIDI Setup → + → Create Multi-Output Device → tick your speakers/
//      headphones AND BlackHole 2ch
//   3. During calls, set that Multi-Output Device as the system output — you
//      still hear everything, and a copy reaches BlackHole for capture.
//   /scribe setup checks all three and tells you which step is missing.
//
// Everything BlackHole receives is captured, i.e. all system audio, not just the
// call — so mute or quit anything else making noise.
//
// Consent: recording a call is regulated in the EU and in two-party-consent US
// states. Knowing whether you may record this call is on you.
//
// Install: copy to ~/.pi/agent/extensions/meeting-scribe.ts
//          (needs extensions/scribe-worker.py alongside it)

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, execFile, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

const CHUNK_SECONDS = 30;            // transcription granularity; 30s validated for diarization quality
const SAMPLE_RATE = 16000;           // parakeet + sherpa both want 16kHz mono
const MAX_MEETING_MS = 4 * 3600_000; // safety net so a forgotten session cannot fill the disk
const SYSTEM_DEVICE_MATCH = /blackhole/i;
const HAL_DRIVER = "/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver"; // on disk but maybe not loaded
const SETUP_TIMEOUT = 900000;
const WORKER_READY_TIMEOUT = 300000; // first run downloads the parakeet model

const VENV_DIR = path.join(os.homedir(), ".pi", "stt-venv"); // shared with voice-input.ts
const VENV_BIN = path.join(VENV_DIR, "bin");
const MODEL_DIR = path.join(os.homedir(), ".pi", "scribe-models");
const SETUP_LOG = path.join(os.homedir(), ".pi", "scribe-setup.log");
const PY_DEPS = ["parakeet-mlx", "sherpa-onnx", "soundfile", "numpy"];

// Speaker segmentation ships as a tarball; the embedding model is a bare .onnx.
// titanet-small won on real 4-speaker audio (100% agreement with offline global
// clustering, vs 87% for eres2net) — see bench/functional/test-scribe-worker.mjs.
const SEG_TARBALL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2";
const SEG_INNER = "sherpa-onnx-pyannote-segmentation-3-0/model.onnx";
const EMB_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx";
const SEG_PATH = path.join(MODEL_DIR, "segmentation.onnx");
const EMB_PATH = path.join(MODEL_DIR, "speaker-embedding.onnx");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("meeting-scribe");
  } catch {
    return true;
  }
}

// Pi may run with a slim PATH; check the usual install locations too.
function resolveBin(name: string): string | undefined {
  const dirs = [VENV_BIN, ...(process.env.PATH || "").split(":"), path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of dirs) if (dir && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  return undefined;
}

function logSetup(line: string): void {
  try {
    fs.appendFileSync(SETUP_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

function run(bin: string, args: string[], timeout: number, cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}\n${String(stderr).slice(-500)}`));
      else resolve({ stdout, stderr });
    });
  });
}

// ffmpeg prints avfoundation devices to stderr as "[N] Device Name" under an
// "AVFoundation audio devices:" header, then exits non-zero (listing is not a
// real input). We need indices, not names, because avfoundation input is
// addressed as ":<index>".
//
// Read stderr from the pipe rather than from the rejection message: execFile's
// error message ALREADY embeds stderr, so run()'s "message + stderr tail" gave
// a doubled log whose second copy started mid-way — the parser stayed in "audio"
// mode across the seam and reported the video device "Capture screen 0" as an
// audio input.
function listAudioDevices(ffmpeg: string): Promise<{ index: number; name: string }[]> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]);
    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    const finish = () => {
      const devices: { index: number; name: string }[] = [];
      const seen = new Set<number>();
      let inAudio = false;
      for (const line of stderr.split("\n")) {
        if (/AVFoundation video devices:/i.test(line)) inAudio = false;
        else if (/AVFoundation audio devices:/i.test(line)) inAudio = true;
        else if (inAudio) {
          const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
          if (m && !seen.has(Number(m[1]))) {
            seen.add(Number(m[1]));
            devices.push({ index: Number(m[1]), name: m[2] });
          }
        }
      }
      resolve(devices);
    };
    proc.on("close", finish);
    proc.on("error", finish);
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      finish();
    }, 20000);
  });
}

function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

interface Utt {
  t0: number;
  speaker: string;
  text: string;
  stream: string;
}

// ── Worker: one persistent python process, JSON Lines in/out ──
// Models load once and stay resident for the meeting, so per-chunk cost is
// inference only. Jobs are strictly sequential — output order is transcript
// order, and two chunks never compete for the GPU.
class Worker {
  private proc: ChildProcess;
  private buf = "";
  private onLine: ((obj: any) => void)[] = [];
  private exited = false;

  constructor(python: string, script: string, onError: (msg: string) => void) {
    this.proc = spawn(python, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SCRIBE_MODEL_DIR: MODEL_DIR },
    });
    this.proc.stdout?.on("data", (d) => {
      this.buf += d.toString();
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          this.onLine.forEach((fn) => fn(obj));
        } catch {}
      }
    });
    let stderr = "";
    this.proc.stderr?.on("data", (d) => {
      stderr += d.toString();
      logSetup(`worker stderr: ${d.toString().trim()}`);
    });
    this.proc.on("close", (code) => {
      this.exited = true;
      if (code !== 0 && code !== null) onError(`transcription worker exited (${code}): ${stderr.slice(-300)}`);
    });
  }

  private wait(pred: (obj: any) => boolean, timeout: number, what: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const collected: any[] = [];
      const timer = setTimeout(() => {
        this.onLine = this.onLine.filter((f) => f !== handler);
        reject(new Error(`timed out waiting for ${what}`));
      }, timeout);
      const handler = (obj: any) => {
        collected.push(obj);
        if (pred(obj)) {
          clearTimeout(timer);
          this.onLine = this.onLine.filter((f) => f !== handler);
          resolve(collected);
        }
      };
      this.onLine.push(handler);
    });
  }

  ready(): Promise<void> {
    return this.wait((o) => o.type === "ready", WORKER_READY_TIMEOUT, "worker startup (first run downloads the ASR model)").then(() => {});
  }

  async job(wav: string, stream: "system" | "mic", t0: number): Promise<Utt[]> {
    if (this.exited) throw new Error("transcription worker is not running");
    const done = this.wait((o) => o.type === "done", MAX_MEETING_MS, "chunk transcription");
    this.proc.stdin?.write(JSON.stringify({ wav, stream, t0 }) + "\n");
    const lines = await done;
    const err = lines.find((o) => o.type === "error");
    if (err) logSetup(`worker chunk error: ${err.message}`);
    return lines.filter((o) => o.type === "utt") as Utt[];
  }

  // Who owns the mic — only answerable once the whole meeting has been heard.
  // Register the waiter before writing, or a fast reply races past it.
  async summary(): Promise<{ me: string | null; speakers: Record<string, Record<string, number>> } | undefined> {
    if (this.exited) return undefined;
    try {
      const pending = this.wait((o) => o.type === "summary", 30000, "speaker summary");
      this.proc.stdin?.write(JSON.stringify({ cmd: "summary" }) + "\n");
      return (await pending).find((o) => o.type === "summary");
    } catch {
      return undefined; // a missing summary just means labels stay Speaker N
    }
  }

  quit(): void {
    try {
      this.proc.stdin?.write(JSON.stringify({ cmd: "quit" }) + "\n");
      this.proc.stdin?.end();
    } catch {}
    setTimeout(() => {
      if (!this.exited) this.proc.kill("SIGKILL");
    }, 5000);
  }
}

interface Meeting {
  dir: string;                 // temp dir holding the wav segments
  transcript: string;          // absolute path of the .md being appended
  started: number;             // Date.now() at start
  procs: ChildProcess[];       // the ffmpeg recorders
  ended: boolean[];            // per-stream: has its ffmpeg exited
  streams: ("system" | "mic")[];
  worker: Worker;
  stopped: boolean;
  lines: number;               // utterances written so far
  speakers: Set<string>;
  pump?: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  ticker?: ReturnType<typeof setInterval>;
}

export default function meetingScribe(pi: ExtensionAPI) {
  let meeting: Meeting | undefined;
  let idleStatus = "";

  const segDir = (m: Meeting, stream: string) => path.join(m.dir, stream);
  const segPath = (m: Meeting, stream: string, i: number) => path.join(segDir(m, stream), `seg-${String(i).padStart(4, "0")}.wav`);

  function status(ctx: ExtensionContext, text: string, idle = true): void {
    if (idle) idleStatus = text;
    ctx.ui.setStatus("meeting-scribe", text);
  }

  // ── one-time setup: python deps + models ──
  async function ensureDeps(ctx: ExtensionContext): Promise<void> {
    const python = path.join(VENV_BIN, "python");
    if (!fs.existsSync(python)) {
      status(ctx, "🎙 setup: creating venv…", false);
      logSetup(`python3 -m venv ${VENV_DIR}`);
      await run(resolveBin("python3") || "python3", ["-m", "venv", VENV_DIR], SETUP_TIMEOUT);
    }
    // Cheap import probe — pip install is slow, so only run it when something is missing.
    let missing = true;
    try {
      await run(python, ["-c", "import parakeet_mlx, sherpa_onnx, soundfile, numpy"], 60000);
      missing = false;
    } catch {}
    if (missing) {
      status(ctx, `🎙 setup: installing ${PY_DEPS.join(", ")}…`, false);
      logSetup(`pip install ${PY_DEPS.join(" ")}`);
      await run(path.join(VENV_BIN, "pip"), ["install", "-U", ...PY_DEPS], SETUP_TIMEOUT);
    }
  }

  async function ensureModels(ctx: ExtensionContext): Promise<void> {
    fs.mkdirSync(MODEL_DIR, { recursive: true });
    if (!fs.existsSync(EMB_PATH)) {
      status(ctx, "🎙 setup: downloading speaker embedding model (38MB)…", false);
      logSetup(`curl ${EMB_URL}`);
      await run("curl", ["-fsSL", "-o", EMB_PATH, EMB_URL], SETUP_TIMEOUT);
    }
    if (!fs.existsSync(SEG_PATH)) {
      status(ctx, "🎙 setup: downloading speaker segmentation model…", false);
      const tar = path.join(MODEL_DIR, "seg.tar.bz2");
      logSetup(`curl ${SEG_TARBALL}`);
      await run("curl", ["-fsSL", "-o", tar, SEG_TARBALL], SETUP_TIMEOUT);
      await run("tar", ["xjf", tar], SETUP_TIMEOUT, MODEL_DIR);
      fs.copyFileSync(path.join(MODEL_DIR, SEG_INNER), SEG_PATH);
      try {
        fs.unlinkSync(tar);
      } catch {}
    }
  }

  // Reports what is missing rather than throwing — /scribe setup prints it all.
  async function checkAudioRoute(): Promise<{ ok: boolean; system?: number; mic?: number; report: string[] }> {
    const report: string[] = [];
    const ffmpeg = resolveBin("ffmpeg");
    if (!ffmpeg) return { ok: false, report: ["✗ ffmpeg not found — brew install ffmpeg"] };
    const devices = await listAudioDevices(ffmpeg);
    const black = devices.find((d) => SYSTEM_DEVICE_MATCH.test(d.name));
    const mic = devices.find((d) => !SYSTEM_DEVICE_MATCH.test(d.name));
    report.push(`  audio inputs: ${devices.map((d) => `[${d.index}] ${d.name}`).join(", ") || "(none)"}`);
    if (black) report.push(`✓ BlackHole found — [${black.index}] ${black.name}`);
    else if (fs.existsSync(HAL_DRIVER)) {
      // Installed but invisible: coreaudiod only scans /Library/Audio/Plug-Ins/HAL
      // at startup, so a driver added since the daemon launched does not exist as
      // far as ffmpeg is concerned. The cask says "reboot"; restarting the daemon
      // is enough and takes a second.
      report.push("✗ BlackHole IS installed but Core Audio has not loaded it yet.");
      report.push("  Run:  sudo killall coreaudiod     (restarts instantly; brief audio dropout, not mid-call)");
      report.push("  A reboot works too — the driver is only picked up when coreaudiod starts.");
    } else {
      report.push("✗ BlackHole not installed. Run:  brew install --cask blackhole-2ch");
      report.push("  (needs your password, so it cannot be installed automatically)");
      report.push("  Then:  sudo killall coreaudiod   to make Core Audio pick it up.");
    }
    if (mic) report.push(`✓ mic — [${mic.index}] ${mic.name}`);
    else report.push("✗ no microphone input found");
    if (black) {
      report.push("  Then, once: Audio MIDI Setup → + → Create Multi-Output Device →");
      report.push("  tick your headphones/speakers AND BlackHole 2ch.");
      report.push("  During a call, select that Multi-Output Device as system output.");
    }
    return { ok: !!black, system: black?.index, mic: mic?.index, report };
  }

  // Normally sits next to this extension — but under dev-link.sh the extension
  // is a symlink into the repo, so resolve that too before falling back.
  function workerScript(): string {
    const candidates: string[] = [];
    try {
      const self = fileURLToPath(import.meta.url);
      candidates.push(path.join(path.dirname(self), "scribe-worker.py"));
      try {
        const real = fs.realpathSync(self); // dev-link.sh symlink -> repo checkout
        candidates.push(path.join(path.dirname(real), "scribe-worker.py"));
      } catch {}
    } catch {}
    candidates.push(path.join(os.homedir(), ".pi", "agent", "extensions", "scribe-worker.py"));
    const found = candidates.find((c) => fs.existsSync(c));
    if (!found) throw new Error(`scribe-worker.py not found (looked in: ${candidates.join(", ")}) — re-run install.sh`);
    return found;
  }

  // ── the pump: chunk i of every stream -> worker -> merged transcript lines ──
  // Segment i is safe to read once segment i+1 exists (ffmpeg has moved on) or
  // its recorder exited. Both streams are cut on the same clock, so chunk i of
  // "system" and chunk i of "mic" cover the same wall-clock window and can be
  // merged on their in-chunk timestamps.
  async function pump(m: Meeting, ctx: ExtensionContext): Promise<void> {
    for (let i = 0; ; i++) {
      // Wait until chunk i is finalized on EVERY still-running stream. A stream
      // that has not written seg i yet must be waited for unless its recorder
      // already exited — otherwise the mic's copy of chunk i gets orphaned when
      // the system stream happens to finalize first.
      while (true) {
        const st = m.streams.map((s, si) => ({
          exists: fs.existsSync(segPath(m, s, i)),
          finalized: fs.existsSync(segPath(m, s, i + 1)) || m.ended[si],
        }));
        const anyHasIt = st.some((x) => x.exists);
        const allSettled = st.every((x, si) => (x.exists ? x.finalized : m.ended[si]));
        if (!anyHasIt && m.ended.every(Boolean)) return; // recorders done, queue drained
        if (anyHasIt && allSettled) break;
        await sleep(300);
      }

      const t0 = i * CHUNK_SECONDS;
      const utts: Utt[] = [];
      for (let si = 0; si < m.streams.length; si++) {
        const wav = segPath(m, m.streams[si], i);
        if (!fs.existsSync(wav)) continue;
        try {
          if (fs.statSync(wav).size >= 1000) utts.push(...(await m.worker.job(wav, m.streams[si], t0)));
        } catch (err: any) {
          ctx.ui.notify(`meeting-scribe: ${err.message ?? err}`, "error");
          logSetup(`pump error: ${err.message ?? err}`);
        } finally {
          try {
            fs.unlinkSync(wav);
          } catch {}
        }
      }

      if (utts.length) {
        utts.sort((a, b) => a.t0 - b.t0);
        const md = utts.map((u) => `**[${fmtClock(u.t0)}] ${u.speaker}:** ${u.text}`).join("\n\n");
        fs.appendFileSync(m.transcript, md + "\n\n");
        m.lines += utts.length;
        utts.forEach((u) => m.speakers.add(u.speaker));
      }
      if (!m.stopped) {
        status(ctx, `● REC ${fmtClock((Date.now() - m.started) / 1000)} · ${m.lines} lines · ${m.speakers.size} speakers`, false);
      }
    }
  }

  function startRecorder(m: Meeting, stream: "system" | "mic", device: number, ctx: ExtensionContext): ChildProcess {
    const ffmpeg = resolveBin("ffmpeg")!;
    fs.mkdirSync(segDir(m, stream), { recursive: true });
    const proc = spawn(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "avfoundation", "-i", `:${device}`,
      "-ar", String(SAMPLE_RATE), "-ac", "1",
      "-f", "segment", "-segment_time", String(CHUNK_SECONDS),
      "-segment_format", "wav", "-reset_timestamps", "1",
      "-y", path.join(segDir(m, stream), "seg-%04d.wav"),
    ]);
    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += d));
    const idx = m.streams.indexOf(stream);
    proc.on("close", (code) => {
      m.ended[idx] = true;
      if (m.stopped) return;
      logSetup(`${stream} recorder died (code ${code}): ${stderr.slice(-500)}`);
      ctx.ui.notify(
        `meeting-scribe: the ${stream} recorder died (exit ${code}) — RECORDING HAS STOPPED.\n` +
          `  ${stderr.slice(-300) || "ffmpeg produced no output"}\n` +
          `  Check microphone permission for your terminal (System Settings > Privacy & Security > Microphone).`,
        "error",
      );
      // Never leave "● REC" on screen when nothing is being captured.
      if (m.ended.every(Boolean) && meeting === m) {
        if (m.ticker) clearInterval(m.ticker);
        ctx.ui.setStatus("meeting-scribe", undefined);
        void stopMeeting(ctx);
      }
    });
    return proc;
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!isEnabled()) return;
    ctx.ui.notify("meeting-scribe active (/scribe setup → /scribe start to record a call)", "info");
  });

  pi.registerCommand("scribe", {
    description: "Record + transcribe a call with speaker labels: /scribe setup|start|stop|status",
    handler: async (args, ctx) => {
      if (!isEnabled()) {
        ctx.ui.notify("meeting-scribe disabled (use /piforge enable meeting-scribe)", "info");
        return;
      }
      const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const action = argv[0] || "status";

      // ── status ──
      if (action === "status") {
        if (!meeting) {
          ctx.ui.notify("meeting-scribe: idle. /scribe start to begin recording.", "info");
          return;
        }
        const elapsed = fmtClock((Date.now() - meeting.started) / 1000);
        const live = meeting.procs.filter((p) => p.exitCode === null && !p.killed);
        const segs = meeting.streams
          .map((st) => {
            const dir = segDir(meeting!, st);
            let n = 0;
            try { n = fs.readdirSync(dir).length; } catch {}
            return `${st}: ${n} pending segment${n === 1 ? "" : "s"}`;
          })
          .join(", ");
        ctx.ui.notify(
          `meeting-scribe: ${live.length}/${meeting.procs.length} recorders alive · ${elapsed} · ` +
            `${meeting.lines} lines · ${meeting.speakers.size} speakers\n  ${segs}\n  ${meeting.transcript}` +
            (live.length === 0 ? "\n  NO RECORDER IS RUNNING — /scribe stop, then start again." : ""),
          live.length === 0 ? "error" : "info",
        );
        return;
      }

      // ── setup ──
      if (action === "setup") {
        try {
          status(ctx, "🎙 setup: checking…", false);
          await ensureDeps(ctx);
          await ensureModels(ctx);
          const route = await checkAudioRoute();
          status(ctx, route.ok ? "🎙 /scribe ready" : "🎙 setup incomplete — see notice");
          ctx.ui.notify(
            ["meeting-scribe setup:", "✓ python deps installed", "✓ diarization models present", ...route.report].join("\n"),
            route.ok ? "info" : "warning",
          );
        } catch (err: any) {
          logSetup(`SETUP FAILED: ${err.message ?? err}`);
          status(ctx, "🎙 setup failed");
          ctx.ui.notify(`meeting-scribe setup failed: ${String(err.message ?? err).split("\n")[0]}\n  details: ${SETUP_LOG}`, "error");
        }
        return;
      }

      // ── start ──
      if (action === "start") {
        if (meeting) {
          ctx.ui.notify("meeting-scribe: already recording — /scribe stop first", "warning");
          return;
        }
        const withMic = !argv.includes("--no-mic");
        try {
          await ensureDeps(ctx);
          await ensureModels(ctx);
          const route = await checkAudioRoute();
          if (!route.ok || route.system === undefined) {
            ctx.ui.notify(["meeting-scribe: cannot start — system audio capture unavailable.", ...route.report].join("\n"), "error");
            return;
          }
          if (withMic && route.mic === undefined) {
            ctx.ui.notify("meeting-scribe: no mic found — starting with --no-mic (far end only)", "warning");
          }

          const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scribe-"));
          const meetingsDir = path.join(process.cwd(), ".think", "meetings");
          fs.mkdirSync(meetingsDir, { recursive: true });
          const now = new Date();
          const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
          const transcript = path.join(meetingsDir, `${stamp}.md`);

          status(ctx, "🎙 loading models…", false);
          const worker = new Worker(path.join(VENV_BIN, "python"), workerScript(), (msg) => ctx.ui.notify(`meeting-scribe: ${msg}`, "error"));
          await worker.ready();

          const streams: ("system" | "mic")[] = withMic && route.mic !== undefined ? ["system", "mic"] : ["system"];
          const m: Meeting = {
            dir,
            transcript,
            started: Date.now(),
            procs: [],
            ended: streams.map(() => false),
            streams,
            worker,
            stopped: false,
            lines: 0,
            speakers: new Set(),
            timer: setTimeout(() => {
              if (meeting) {
                ctx.ui.notify(`meeting-scribe: auto-stopped after ${MAX_MEETING_MS / 3600_000}h`, "warning");
                void stopMeeting(ctx);
              }
            }, MAX_MEETING_MS),
          };

          fs.writeFileSync(
            transcript,
            `# Meeting — ${now.toLocaleString()}\n\n` +
              `Recorded locally by PiForge meeting-scribe. System audio via BlackHole` +
              `${withMic && route.mic !== undefined ? " + microphone" : " (far end only, no mic)"}.\n` +
              `Speakers are separated by voice across both streams; the one heard mostly on the\n` +
              `microphone is relabelled "Me" when the recording stops.\n\n---\n\n`,
          );

          m.procs.push(startRecorder(m, "system", route.system, ctx));
          if (streams.includes("mic")) m.procs.push(startRecorder(m, "mic", route.mic!, ctx));
          meeting = m;
          m.pump = pump(m, ctx);
          // Tick every second. The status used to be refreshed only when a chunk
          // finished, so with 30s chunks (or dead recorders) it sat at
          // "REC 00:00 · 0 lines" indefinitely and looked like nothing had started.
          m.ticker = setInterval(() => {
            if (meeting !== m) return;
            const live = m.procs.filter((p) => p.exitCode === null && !p.killed).length;
            if (live === 0) return; // death handler owns the message
            status(ctx, `● REC ${fmtClock((Date.now() - m.started) / 1000)} · ${m.lines} lines`
              + (m.speakers.size ? ` · ${m.speakers.size} speakers` : ""), false);
          }, 1000);
          status(ctx, "● REC 00:00 · 0 lines", false);
          ctx.ui.notify(`meeting-scribe: recording → ${transcript}\n  /scribe stop when the call ends`, "info");
        } catch (err: any) {
          logSetup(`START FAILED: ${err.message ?? err}`);
          ctx.ui.notify(`meeting-scribe: could not start — ${String(err.message ?? err).split("\n")[0]}\n  details: ${SETUP_LOG}`, "error");
          status(ctx, idleStatus || "");
        }
        return;
      }

      // ── stop ──
      if (action === "stop") {
        if (!meeting) {
          ctx.ui.notify("meeting-scribe: not recording", "info");
          return;
        }
        await stopMeeting(ctx);
        return;
      }

      ctx.ui.notify("usage: /scribe setup | /scribe start [--no-mic] | /scribe stop | /scribe status", "info");
    },
  });

  async function stopMeeting(ctx: ExtensionContext): Promise<void> {
    const m = meeting;
    if (!m) return;
    meeting = undefined;
    m.stopped = true;
    clearTimeout(m.timer);
    if (m.ticker) clearInterval(m.ticker);
    // SIGINT lets ffmpeg finalize the segment it is mid-way through.
    m.procs.forEach((p) => {
      try {
        p.kill("SIGINT");
      } catch {}
    });
    status(ctx, "⏳ transcribing the last chunks…", false);
    try {
      await m.pump; // drains whatever was recorded but not yet transcribed
    } catch (err: any) {
      ctx.ui.notify(`meeting-scribe: ${err.message ?? err}`, "error");
    }
    // Resolve which voice is the user, now that the whole meeting has been heard,
    // and rewrite the labels in place. Live lines say "Speaker N" because this
    // cannot be known from the first chunk.
    const summary = await m.worker.summary();
    m.worker.quit();
    let meNote = "";
    if (summary?.me) {
      const label = summary.me;
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const body = fs
        .readFileSync(m.transcript, "utf-8")
        .replace(new RegExp(`(\\*\\*\\[[\\d:]+\\] )${escaped}(:\\*\\*)`, "g"), "$1Me$2");
      fs.writeFileSync(m.transcript, body);
      m.speakers.delete(label);
      m.speakers.add("Me");
      meNote = `\n_${label} was heard mostly on the microphone and has been relabelled "Me"._\n`;
    }
    const mins = fmtClock((Date.now() - m.started) / 1000);
    fs.appendFileSync(m.transcript, `\n---\n\n_Recording ended after ${mins} — ${m.lines} utterances, ${m.speakers.size} speakers._\n${meNote}`);
    try {
      fs.rmSync(m.dir, { recursive: true, force: true });
    } catch {}
    idleStatus = "";
    ctx.ui.setStatus("meeting-scribe", undefined);
    ctx.ui.notify(
      m.lines === 0
        ? `meeting-scribe: stopped, but nothing was transcribed.\n  Was the Multi-Output Device selected as system output?\n  ${m.transcript}`
        : `meeting-scribe: stopped after ${mins} — ${m.lines} utterances, ${m.speakers.size} speakers\n  ${m.transcript}`,
      m.lines === 0 ? "warning" : "info",
    );
  }
}
