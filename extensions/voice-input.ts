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
//   parakeet  — NVIDIA Parakeet TDT 0.6B v3 via parakeet-mlx. APPLE SILICON ONLY
//               (mlx is a macOS/arm64 framework). Best accuracy, 25 European
//               languages, Apache 2.0. ~600MB model.
//   moonshine — Useful Sensors Moonshine base (~57MB ONNX). Lightest + fastest,
//               and CROSS-PLATFORM (macOS / Windows / Linux) — the default
//               everywhere parakeet can't run.
//
// Engine selection (first match wins):
//   1. CLI flag              pi --stt moonshine
//   2. /stt command          /stt parakeet | /stt moonshine   (this session only)
//   3. DEFAULT_ENGINE — auto-detected: parakeet on Apple Silicon, else moonshine.
//
// The trigger is a bare accented character, which pi-tui's registerShortcut
// key matcher can't represent (ASCII-only KeyId) — so this extension wraps the
// input editor via ctx.ui.setEditorComponent/CustomEditor and intercepts the
// raw character in handleInput. Consequence: you can no longer TYPE è into the
// prompt (paste still works, and é/shift is unaffected). Composes with other
// extensions that wrap the editor the same way, whatever the load order.
//
// CROSS-PLATFORM RECORDING (auto-detected from os.platform()):
//   macOS   — ffmpeg -f avfoundation, device ":<index>". ffmpeg auto-installed
//             via Homebrew. Terminal needs mic permission (macOS prompts).
//   Windows — ffmpeg -f dshow,       device "audio=<name>". ffmpeg auto-installed
//             via winget (per-user, no admin) → scoop → choco (elevated shell
//             only) → direct download from gyan.dev, else a manual command is
//             shown. Allow desktop-app mic access in Windows privacy settings.
//             When voice-input-windows.ts is installed and enabled, this build
//             registers nothing on win32.
//   Linux   — ffmpeg -f pulse,       device "default" (no enumeration).
// The self-contained venv lives at ~/.pi/stt-venv (bin/ on POSIX, Scripts/ on
// Windows); all tool lookups honor the platform's PATH separator and exe suffix.
//
// Install: copy to ~/.pi/agent/extensions/voice-input.ts

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";
import { spawn, execFile, type ChildProcess } from "child_process";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

// ---------- PLATFORM ----------
// Everything OS-specific (capture backend, ffmpeg installer, venv layout, PATH
// parsing, default engine) branches off these. macOS keeps its original paths.
const PLATFORM = os.platform();
const IS_WIN = PLATFORM === "win32";
const IS_MAC = PLATFORM === "darwin";
const IS_LINUX = !IS_WIN && !IS_MAC;
const IS_APPLE_SILICON = IS_MAC && os.arch() === "arm64";

// ffmpeg input format per OS. avfoundation and dshow enumerate devices; pulse
// (Linux) does not, so there we just record the "default" input.
const AUDIO_BACKEND = IS_WIN ? "dshow" : IS_MAC ? "avfoundation" : "pulse";
// Executable suffixes to try when resolving a binary by name.
const EXE_EXTS = IS_WIN ? [".exe", ".cmd", ".bat", ""] : [""];

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
// `spec` is the platform-specific value handed to ffmpeg's `-i` for this device
// (":<idx>" on avfoundation, "audio=<name>" on dshow).
type AudioDevice = { index: number; name: string; spec: string };
let resolvedDevice: AudioDevice | null = null;
let deviceNote = "";

// ffmpeg prints its device list to stderr and exits nonzero on a list query
// (there is no input file). Capture raw stderr directly, NOT via run(): run()
// rejects with only the last 500 chars folded into a message, and the list can
// exceed that.
function ffmpegListStderr(ffmpeg: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(ffmpeg, args, { timeout: 15000, maxBuffer: 1024 * 1024 },
      (_err, _stdout, stderr) => resolve(String(stderr ?? "")));
  });
}

async function listAudioDevices(ffmpeg: string): Promise<AudioDevice[]> {
  if (IS_MAC) return listAvfoundation(ffmpeg);
  if (IS_WIN) return listDshow(ffmpeg);
  return []; // Linux/pulse: enumeration unsupported — recording uses "default".
}

async function listAvfoundation(ffmpeg: string): Promise<AudioDevice[]> {
  const out = await ffmpegListStderr(ffmpeg, ["-f", "avfoundation", "-list_devices", "true", "-i", ""]);
  const devices: AudioDevice[] = [];
  const audioPart = out.slice(out.indexOf("AVFoundation audio devices"));
  for (const line of audioPart.split("\n")) {
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (m) devices.push({ index: parseInt(m[1], 10), name: m[2], spec: `:${parseInt(m[1], 10)}` });
  }
  return devices;
}

async function listDshow(ffmpeg: string): Promise<AudioDevice[]> {
  const out = await ffmpegListStderr(ffmpeg, ["-hide_banner", "-f", "dshow", "-list_devices", "true", "-i", "dummy"]);
  // dshow addresses inputs BY NAME ("audio=<name>"), not by index — the index
  // here is just enumeration order for display/selection convenience.
  return parseDshowAudioNames(out).map((name, i) => ({ index: i, name, spec: `audio=${name}` }));
}

// dshow's list format has shifted across ffmpeg releases:
//   old:  [dshow @ ..]  "Microphone (Realtek)" (audio)
//   new:  [dshow @ ..]  "Microphone (Realtek)"
//         [dshow @ ..]     (audio)
// Both name the device in quotes; the "(audio)" tag is either trailing or on the
// next line. "Alternative name" lines carry an opaque @device id — skip them.
function parseDshowAudioNames(stderr: string): string[] {
  const names: string[] = [];
  let pending: string | null = null;
  for (const line of stderr.split("\n")) {
    if (line.includes("Alternative name")) continue;
    const nameMatch = line.match(/"([^"]+)"/);
    const hasAudio = /\(audio\)/i.test(line);
    const hasVideo = /\(video\)/i.test(line);
    if (nameMatch) {
      if (hasAudio) { names.push(nameMatch[1]); pending = null; }
      else if (hasVideo) { pending = null; }
      else { pending = nameMatch[1]; }
    } else if (hasAudio && pending) {
      names.push(pending); pending = null;
    } else if (hasVideo) {
      pending = null;
    }
  }
  return names;
}

function isVirtual(name: string): boolean {
  const n = name.toLowerCase();
  return VIRTUAL_DEVICE_PATTERNS.some((p) => n.includes(p));
}

// Turn an AUDIO_DEVICE override into a valid `-i` value for this backend.
function normalizeOverride(v: string): string {
  if (IS_MAC) return v.startsWith(":") ? v : `:${v}`;
  if (IS_WIN) return v.startsWith("audio=") ? v : `audio=${v}`;
  return v; // pulse: pass through (e.g. "default", a source name)
}

// Empty-string sentinel = no device could be resolved; the caller reports it.
const NO_DEVICE = "";

async function resolveAudioDevice(ffmpeg: string): Promise<string> {
  if (AUDIO_DEVICE) return normalizeOverride(AUDIO_DEVICE);
  if (resolvedDevice) return resolvedDevice.spec;
  if (IS_LINUX) {
    deviceNote = "recording the default PulseAudio input (enumeration unsupported on Linux)";
    return "default";
  }

  const devices = await listAudioDevices(ffmpeg);
  if (devices.length === 0) {
    // avfoundation has a stable ":0" default; dshow has no positional default,
    // so there is nothing to fall back to — signal the caller to report it.
    deviceNote = "could not enumerate audio inputs";
    return IS_MAC ? ":0" : NO_DEVICE;
  }

  const real = devices.filter((d) => !isVirtual(d.name));
  if (real.length === 0) {
    // Everything looks virtual. Recording anyway beats refusing, but say so:
    // this is the exact state that produced silent audio and an empty transcript.
    resolvedDevice = devices[0];
    deviceNote = `WARNING: every input looks virtual (${devices.map((d) => d.name).join(", ")}) — audio may be silent`;
    return resolvedDevice.spec;
  }

  const preferred =
    real.find((d) => PREFERRED_DEVICE_PATTERNS.some((p) => d.name.toLowerCase().includes(p))) ?? real[0];
  resolvedDevice = preferred;

  const skipped = devices.filter((d) => d.index !== preferred.index && isVirtual(d.name));
  deviceNote = skipped.length ? `skipped virtual: ${skipped.map((d) => d.name).join(", ")}` : "";
  return preferred.spec;
}

// Auto-detected: parakeet needs Apple Silicon (mlx); everywhere else moonshine
// is the only engine that runs, so it is the default there.
const DEFAULT_ENGINE: Engine = IS_APPLE_SILICON ? "parakeet" : "moonshine";

// Capture device. null = resolve at runtime (recommended); pin it with a literal
// backend value (avfoundation ":<idx>" / dshow "audio=<name>") or a name/index
// substring, which normalizeOverride() adapts to the active backend.
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
// Matched case-insensitively against the device name. Covers macOS loopbacks
// and the common Windows dshow virtual inputs (Stereo Mix, VB-Audio/VoiceMeeter,
// "What U Hear", app-injected mixes).
const VIRTUAL_DEVICE_PATTERNS = [
  "blackhole", "soundflower", "loopback", "aggregate", "multi-output",
  "teams audio", "airbeamtv", "zoomaudio", "krisp", "vb-cable", "ishowu",
  "stereo mix", "wave out mix", "what u hear", "voicemeeter", "vb-audio",
  "cable output", "cable-a", "cable-b", "virtual audio", "nvidia broadcast",
];

// Preferred when several real devices exist.
const PREFERRED_DEVICE_PATTERNS = ["macbook", "built-in", "internal", "microphone", "mic", "headset", "array"];
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
// venv exposes its executables under Scripts/ on Windows, bin/ elsewhere.
const VENV_BIN = path.join(VENV_DIR, IS_WIN ? "Scripts" : "bin");
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
// True when voice-input-windows.ts sits next to this file and is not disabled
// in the piforge config. Used by the guard at the top of voiceInput(): both
// builds wrap the editor and intercept the SAME trigger char, swallowing it -
// whichever loads last steals every keypress from the other. On win32 the
// designated build is the Windows one, so it keeps the trigger key and this
// build registers nothing. (If the Windows build is disabled or absent, this
// build's dshow fallback still works.)
// win32 only. NOTE: new URL(import.meta.url).pathname yields "/C:/Users/…" on
// Windows, which fs.existsSync never matches — the guard silently never fired
// and both builds wrapped the editor. fileURLToPath() gives a real path; the
// ~/.pi/agent/extensions fallback covers a missing/odd import.meta.url.
function windowsSiblingActive(): boolean {
  if (!IS_WIN) return false;
  try {
    const candidates: string[] = [];
    try { candidates.push(path.dirname(fileURLToPath(import.meta.url))); } catch {}
    candidates.push(path.join(os.homedir(), ".pi", "agent", "extensions"));
    const sibling = candidates.map((d) => path.join(d, "voice-input-windows.ts")).find((p) => fs.existsSync(p));
    if (!sibling) return false;
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("voice-input-windows");
  } catch {
    return false;
  }
}

// Where the direct-download fallback unzips ffmpeg (win32 only).
const FFMPEG_WIN_DIR = path.join(os.homedir(), ".pi", "ffmpeg-win");

// win32 only. winget "portable" packages (Gyan.FFmpeg is one) unpack under
// %LOCALAPPDATA%\Microsoft\WinGet\Packages\<Id>_<Source>\<build>\bin and are
// exposed via symlinks in …\WinGet\Links. A non-elevated winget without
// Developer Mode cannot create symlinks; it then appends the bin dir to the
// USER PATH instead — which only fresh shells see. Scanning both finds ffmpeg
// in THIS session right after the install, so no restart is needed. Also scans
// FFMPEG_WIN_DIR/<build>/bin, where the direct-download fallback unzips.
function wingetPortableBinDirs(): string[] {
  if (!IS_WIN) return [];
  const dirs: string[] = [];
  try {
    for (const sub of fs.readdirSync(FFMPEG_WIN_DIR)) dirs.push(path.join(FFMPEG_WIN_DIR, sub, "bin"));
  } catch {}
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const root = path.join(local, "Microsoft", "WinGet");
  dirs.push(path.join(root, "Links"));
  try {
    const pkgs = path.join(root, "Packages");
    for (const pkg of fs.readdirSync(pkgs)) {
      const pkgDir = path.join(pkgs, pkg);
      dirs.push(pkgDir);
      try {
        for (const sub of fs.readdirSync(pkgDir)) dirs.push(path.join(pkgDir, sub), path.join(pkgDir, sub, "bin"));
      } catch {}
    }
  } catch {}
  return dirs;
}

// Pi may run with a slim PATH; check the usual install locations too. On Windows
// executables carry a suffix (.exe/.cmd/.bat) and PATH is ";"-separated, so try
// each suffix and search the package-manager shim dirs choco/scoop put on PATH.
function resolveBin(name: string): string | undefined {
  const winExtra = [
    path.join(process.env.ProgramData || "C:\\ProgramData", "chocolatey", "bin"),
    path.join(os.homedir(), "scoop", "shims"),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Microsoft", "WindowsApps"),
    ...wingetPortableBinDirs(),
  ];
  const posixExtra = [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const dirs = [
    VENV_BIN, // our venv wins
    ...(process.env.PATH || "").split(path.delimiter),
    ...(IS_WIN ? winExtra : posixExtra),
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of EXE_EXTS) {
      const p = path.join(dir, name + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

// Interpreter used to create the venv and to run moonshine when the venv is
// absent. Windows ships "python"/"py" (rarely "python3"); POSIX ships "python3".
const PYTHON_CANDIDATES = IS_WIN ? ["python", "py", "python3"] : ["python3", "python"];
function systemPython(): string {
  for (const c of PYTHON_CANDIDATES) {
    const bin = resolveBin(c);
    if (bin) return bin;
  }
  return IS_WIN ? "python" : "python3";
}

function sttPython(): string {
  const venvPy = path.join(VENV_BIN, IS_WIN ? "python.exe" : "python");
  if (fs.existsSync(venvPy)) return venvPy;
  return systemPython();
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

// win32 only: "net session" succeeds only in an elevated (Administrator) process.
async function isElevated(): Promise<boolean> {
  if (!IS_WIN) return false;
  try {
    await run(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "net.exe"), ["session"], 10000);
    return true;
  } catch {
    return false;
  }
}

// Manual command to show when ffmpeg can't be auto-installed.
function ffmpegInstallHint(): string {
  if (IS_MAC) return "brew install ffmpeg";
  if (IS_WIN) return "winget install --id Gyan.FFmpeg -e   (or: scoop install ffmpeg  /  choco install ffmpeg -y from an Administrator shell) — then /reload";
  return "sudo apt install ffmpeg   (or your distro's package manager)";
}

// Where the OS exposes microphone permission — surfaced in the empty-transcript
// diagnostic, the #1 cause of "recorded but got nothing".
const MIC_PERMISSION_HINT = IS_MAC
  ? "System Settings → Privacy & Security → Microphone"
  : IS_WIN
    ? "Settings → Privacy & security → Microphone (enable 'Let desktop apps access your microphone')"
    : "your system's microphone privacy settings";

// Best-effort ffmpeg auto-install; `report` streams progress to the footer.
// Returns the resolved ffmpeg path, or null if the user must install it by hand.
async function installFfmpeg(report: (msg: string) => void): Promise<string | null> {
  const found = () => resolveBin("ffmpeg");
  if (found()) return found()!;

  // (bin, args) install attempts, in preference order per platform.
  const attempts: Array<{ label: string; bin: string; args: string[] }> = [];
  if (IS_MAC) {
    const brew = resolveBin("brew");
    if (brew) attempts.push({ label: "brew", bin: brew, args: ["install", "ffmpeg"] });
  } else if (IS_WIN) {
    // winget first: Gyan.FFmpeg is a per-user portable package (no elevation),
    // and resolveBin() scans winget's package dir, so no fresh shell is needed.
    // scoop is per-user too. choco writes to ProgramData and only works from an
    // elevated shell — pi normally isn't, and a doomed attempt burns ~70s, so
    // it is skipped unless this process is actually elevated.
    const winget = resolveBin("winget");
    const scoop = resolveBin("scoop");
    const choco = resolveBin("choco");
    if (winget) attempts.push({ label: "winget", bin: winget, args: ["install", "--id", "Gyan.FFmpeg", "-e", "--source", "winget", "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity"] });
    if (scoop) attempts.push({ label: "scoop", bin: scoop, args: ["install", "ffmpeg"] });
    if (choco) {
      if (await isElevated()) attempts.push({ label: "choco", bin: choco, args: ["install", "ffmpeg", "-y", "--no-progress"] });
      else logSetup("ffmpeg install: skipping choco (needs an Administrator shell)");
    }
    // No package manager at all: fetch the official Gyan "essentials" build and
    // unzip it into ~/.pi/ffmpeg-win, which resolveBin() scans. Needs only the
    // PowerShell that ships with Windows 10+ (~90MB download, per-user, no admin).
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (fs.existsSync(powershell)) {
      const psDir = FFMPEG_WIN_DIR.replace(/'/g, "''");
      const psCmd =
        "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $d='" + psDir + "'; " +
        "New-Item -ItemType Directory -Force -Path $d | Out-Null; $z=Join-Path $d 'ffmpeg.zip'; " +
        "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; " +
        "Invoke-WebRequest -UseBasicParsing -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $z; " +
        "Expand-Archive -LiteralPath $z -DestinationPath $d -Force; Remove-Item -LiteralPath $z -Force";
      attempts.push({ label: "direct download", bin: powershell, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psCmd] });
    }
  } else {
    const sudo = resolveBin("sudo");
    for (const [mgr, mgrArgs] of [["apt-get", ["install", "-y", "ffmpeg"]], ["dnf", ["install", "-y", "ffmpeg"]], ["pacman", ["-S", "--noconfirm", "ffmpeg"]]] as const) {
      const bin = resolveBin(mgr);
      if (bin) attempts.push({ label: mgr, bin: sudo ?? bin, args: sudo ? [bin, ...mgrArgs] : [...mgrArgs] });
    }
  }

  for (const a of attempts) {
    try {
      report(`🎤 setting up: installing ffmpeg (${a.label})…`);
      logSetup(`ffmpeg install: ${a.bin} ${a.args.join(" ")}`);
      await run(a.bin, a.args, INSTALL_TIMEOUT);
      if (found()) return found()!;
    } catch (e: any) {
      logSetup(`ffmpeg install via ${a.label} failed: ${String(e.message ?? e).split("\n")[0]}`);
    }
  }
  return found() ?? null; // may be installed but not yet on PATH → caller reports
}

// Stop the recorder. POSIX: SIGINT lets ffmpeg finalize the open segment
// cleanly, with a timer to force-kill a hung child. Windows can't deliver
// SIGINT to a non-console child and ignores "q" on a piped stdin, so it must be
// terminated — the open segment's WAV header is left unpatched, and
// repairWavHeader() reconstructs it on read to recover the final utterance.
function stopRecorder(proc: ChildProcess): void {
  if (IS_WIN) {
    try { proc.kill(); } catch {}
    return;
  }
  try { proc.kill("SIGINT"); } catch { try { proc.kill(); } catch {} }
  setTimeout(() => { try { if (proc.exitCode === null && !proc.killed) proc.kill(); } catch {} }, 5000);
}

// A force-terminated ffmpeg leaves the last WAV segment with unwritten size
// fields (RIFF/data = 0), which decoders read as empty audio. For a canonical
// 44-byte PCM WAV the true sizes are derivable from the file length, so patch
// them in place. No-op when the header is already correct (the POSIX SIGINT
// path) or when the layout isn't the plain 44-byte form.
function repairWavHeader(file: string): void {
  try {
    const fd = fs.openSync(file, "r+");
    try {
      const size = fs.fstatSync(fd).size;
      if (size < 44) return;
      const head = Buffer.alloc(44);
      fs.readSync(fd, head, 0, 44, 0);
      if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") return;
      if (head.toString("ascii", 36, 40) !== "data") return; // non-canonical — leave alone
      const wantRiff = size - 8;
      const wantData = size - 44;
      if (head.readUInt32LE(4) === wantRiff && head.readUInt32LE(40) === wantData) return;
      const buf = Buffer.alloc(4);
      buf.writeUInt32LE(wantRiff, 0); fs.writeSync(fd, buf, 0, 4, 4);
      buf.writeUInt32LE(wantData, 0); fs.writeSync(fd, buf, 0, 4, 40);
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
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
  // Mutual exclusion with the Windows sibling: on win32 it owns the trigger
  // key, so this build registers nothing (no editor wrap, no /stt, no setup).
  if (IS_WIN && windowsSiblingActive()) return;

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
      // 0. parakeet is Apple-Silicon-only (mlx) — fail fast elsewhere rather
      //    than attempting a pip install that cannot succeed.
      if (engine === "parakeet" && !IS_APPLE_SILICON) {
        status(ctx, "🎤 parakeet needs Apple Silicon — run /stt moonshine");
        ctx.ui.notify("voice-input: the parakeet engine requires Apple Silicon (mlx). Use /stt moonshine on this platform.", "error");
        return false;
      }

      // 1. ffmpeg (recording + parakeet CLI decoding)
      if (!resolveBin("ffmpeg")) {
        const ffmpegPath = await installFfmpeg((m) => status(ctx, m));
        if (!ffmpegPath) {
          status(ctx, "🎤 ffmpeg not found — install it, then /reload");
          ctx.ui.notify(`voice-input: ffmpeg is required and could not be auto-installed. Install it with:  ${ffmpegInstallHint()}`, "error");
          return false;
        }
      }

      // 2. engine package (skipped when already importable/on PATH)
      if (!(await engineReady(engine))) {
        const venvPy = path.join(VENV_BIN, IS_WIN ? "python.exe" : "python");
        if (!fs.existsSync(venvPy)) {
          status(ctx, `🎤 setting up ${engine}: creating venv…`);
          logSetup(`${systemPython()} -m venv ${VENV_DIR}`);
          await run(systemPython(), ["-m", "venv", VENV_DIR], INSTALL_TIMEOUT);
        }
        status(ctx, `🎤 setting up ${engine}: installing ${PKG[engine]}…`);
        logSetup(`pip install -U ${PKG[engine]}`);
        const pip = path.join(VENV_BIN, IS_WIN ? "pip.exe" : "pip");
        const pipOut = await run(pip, ["install", "-U", PKG[engine]], INSTALL_TIMEOUT);
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
          const loc = IS_MAC ? ` (:${resolvedDevice.index})` : "";
          ctx.ui.notify(
            `voice-input: mic → "${resolvedDevice.name}"${loc}${deviceNote ? ` · ${deviceNote}` : ""}`,
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
      if (IS_LINUX) {
        ctx.ui.notify("voice-input: device enumeration isn't supported on Linux — recording the default PulseAudio input. Pin one via AUDIO_DEVICE in voice-input.ts.", "info");
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
        const loc = IS_MAC ? ` (:${chosen.index})` : "";
        const persist = IS_MAC ? `":${chosen.index}"` : `"${chosen.name}"`;
        ctx.ui.notify(
          `voice-input: mic → "${chosen.name}"${loc} for this session.\n` +
          `To make it permanent, set AUDIO_DEVICE = ${persist} in voice-input.ts and /reload.`,
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
        // Clean stop so the last segment is finalized (no-op if already exited).
        stopRecorder(current.proc);
        await current.done;
        status(ctx, "⏳ transcribing…", false);
        const drained = (await current.pump) ?? { audioSegs: 0, textChunks: 0 };
        if (drained.audioSegs === 0) {
          throw new Error(`no audio captured — check mic permission for your terminal (${MIC_PERMISSION_HINT})`);
        }
        if (drained.textChunks === 0) {
          // Audio WAS captured (else the throw above fired), so the recording
          // was silent or unintelligible. By far the most common cause is
          // recording the wrong input — name the device rather than making the
          // user guess, which is what cost an afternoon on 2026-07-31.
          const dev = resolvedDevice ? `"${resolvedDevice.name}"` : AUDIO_DEVICE ?? (IS_MAC ? ":0" : "the default input");
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
    const device = await resolveAudioDevice(ffmpeg);
    if (!device) {
      ctx.ui.notify("voice-input: no audio input device found — plug in a mic (and allow mic access in Windows privacy settings), then /stt-device to check.", "error");
      return;
    }
    try { fs.rmSync(SEG_DIR, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(SEG_DIR, { recursive: true });
    const proc = spawn(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", AUDIO_BACKEND, "-i", device,
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
          stopRecorder(proc);
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
          // The final segment of a force-terminated recorder (Windows stop) has
          // an unpatched header — repair it so its audio isn't read as empty.
          repairWavHeader(cur);
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
