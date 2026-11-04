// FUNCTIONAL test: drives the REAL scribe-worker.py with real audio, real
// models and real subprocess I/O — the thing meeting-scribe.ts spawns.
//
// What it exists to protect: cross-chunk speaker identity. A meeting is
// transcribed in 30s chunks, and each chunk is diarized independently, so
// "Speaker 2" in minute 1 and "Speaker 2" in minute 40 are only the same person
// because the worker links each chunk-local cluster to a running global
// centroid. Break that linking and every chunk renumbers from scratch — which
// still *looks* fine in a single-chunk test. So this test asserts identity
// ACROSS a chunk boundary, which is the property that actually matters.
//
// Origin (2026-07-30): the first design cut segments with silero VAD and scored
// 74% against offline global clustering. VAD finds speech vs silence, not
// speaker CHANGES, so two people talking back-to-back landed in one segment and
// the blended embedding corrupted the centroid. Switching to the pyannote
// segmentation model took it to 100%. The VAD approach passed every
// single-chunk smoke test, hence this regression test.
//
// Fixture is synthesized with macOS `say` so the test needs no network. Note
// that macOS TTS voices are NOT a speaker-separation benchmark — two male
// system voices (Alex/Daniel) embed at 0.89-0.95 cosine, indistinguishable from
// the same speaker, because they share a synthesis engine. Alex vs Samantha
// (male vs female) sits at ~0.24 against ~0.91 same-speaker, a wide enough
// margin to test the plumbing. Real diarization accuracy was measured
// separately against real 4-speaker human audio; see bench/README.md.
//
//   bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync, spawn } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER = path.join(REPO_ROOT, "extensions", "scribe-worker.py");
const EXT = path.join(REPO_ROOT, "extensions", "meeting-scribe.ts");
const VENV_PY = path.join(os.homedir(), ".pi", "stt-venv", "bin", "python");
const MODEL_DIR = path.join(os.homedir(), ".pi", "scribe-models");

const results = [];
const check = (label, ok) => results.push([label, ok]);

// ---- skip cleanly when the machine has not run /scribe setup ----
const missing = [
  [VENV_PY, "~/.pi/stt-venv (run /scribe setup)"],
  [path.join(MODEL_DIR, "segmentation.onnx"), "~/.pi/scribe-models/segmentation.onnx"],
  [path.join(MODEL_DIR, "speaker-embedding.onnx"), "~/.pi/scribe-models/speaker-embedding.onnx"],
].filter(([p]) => !fs.existsSync(p));
if (missing.length) {
  console.log("SKIP test-meeting-scribe: missing " + missing.map(([, d]) => d).join(", "));
  process.exit(0);
}
if (process.platform !== "darwin") {
  console.log("SKIP test-meeting-scribe: fixture synthesis needs macOS `say`");
  process.exit(0);
}

// ---- thresholds parsed LIVE from the worker source, per bench convention ----
// scribe-worker.py is deliberately SELF-CONTAINED: PiForge must not import
// anything from scribe-app/, so that work on the standalone app cannot break
// /scribe. The app keeps its own separate copy of this logic.
const workerSrc = fs.readFileSync(WORKER, "utf-8");
const coreSrc = workerSrc;
const linkThreshold = Number(coreSrc.match(/SCRIBE_LINK_THRESHOLD",\s*"([\d.]+)"/)?.[1]);
const localThreshold = Number(coreSrc.match(/SCRIBE_LOCAL_THRESHOLD",\s*"([\d.]+)"/)?.[1]);
check(`link threshold parses from source (${linkThreshold})`, linkThreshold > 0 && linkThreshold < 1);
check(`local threshold parses from source (${localThreshold})`, localThreshold > 0 && localThreshold < 1);

// Load-bearing logic markers — if these vanish the test's assumptions are stale.
check(
  "core still uses pyannote segmentation (not VAD) for speaker-change points",
  /OfflineSpeakerSegmentationPyannoteModelConfig/.test(coreSrc) && !/VoiceActivityDetector/.test(coreSrc),
);
check("worker still links chunk-local speakers to running centroids", /def link\(/.test(coreSrc) && /self\.centroids\[best\] = \(vsum \+ emb, n \+ 1\)/.test(coreSrc));
// Regression (2026-07-30): the mic stream used to be hard-labelled "Me" with no
// diarization at all. A podcast playing through the laptop speakers reached the
// mic, so all of it was attributed to the user and the diarizer never ran —
// "it did not recognize other people". Both streams must now be diarized.
check("mic stream is no longer hard-labelled Me", !/"speaker": "Me"/.test(coreSrc));
check("both streams go through one diarization path", /def do_chunk\(self, audio, t0, stream\)/.test(coreSrc) && !/def do_mic\(/.test(coreSrc));
check("worker reports who owns the mic from per-stream speech time", /def summary\(/.test(coreSrc) && /mic > best and mic > sysm/.test(coreSrc));
// The app and the Pi extension must share one implementation, not two copies.
check("worker is self-contained (no import from the app)", !/scribe_core|sys\.path\.insert/.test(workerSrc) && /def link\(/.test(workerSrc));
check("extension relabels the mic-dominant speaker to Me at stop", /worker\.summary\(\)/.test(fs.readFileSync(EXT, "utf-8")) && /\$1Me\$2/.test(fs.readFileSync(EXT, "utf-8")));

const extSrc = fs.readFileSync(EXT, "utf-8");
check("extension records two streams (system + mic)", /streams: \("system" \| "mic"\)\[\]/.test(extSrc));
check("extension waits for all live streams before flushing a chunk", /allSettled/.test(extSrc));
// Regression (2026-07-30): device enumeration parsed execFile's REJECTION message,
// which already embeds stderr — run() appended a truncated second copy whose seam
// landed inside the video-device section, so "Capture screen 0" was reported as an
// audio input and the list came out doubled. It must read the stderr pipe directly
// and de-duplicate by index.
check("device listing reads the stderr pipe, not the rejection message", /listAudioDevices[\s\S]{0,900}proc\.stderr\?\.on\("data"/.test(extSrc));
check("device listing de-duplicates by index", /listAudioDevices[\s\S]{0,900}seen\.has\(Number\(m\[1\]\)\)/.test(extSrc));

// ---- build the fixture ----
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piforge-fn-scribe-")));

// ---- the extension actually LOADS and registers its command ----
// A Pi extension that throws on load fails silently except for a missing banner,
// so import the real module and drive the read-only paths. setup/start are NOT
// called here — they install packages and grab audio devices.
{
  const stripped = path.join(TMP, "meeting-scribe.ts");
  fs.writeFileSync(stripped, extSrc.replace(/^import type .*$/m, "// (type-only import stripped)"));
  const mod = await import(stripped);
  let sessionStart;
  const commands = {};
  mod.default({
    on: (ev, h) => {
      if (ev === "session_start") sessionStart = h;
    },
    registerCommand: (name, opts) => (commands[name] = opts),
    registerTool: () => {},
    sendMessage: async () => {},
  });
  check("extension loads and registers /scribe", typeof commands.scribe?.handler === "function");
  check("extension registers a session_start banner", typeof sessionStart === "function");

  const notices = [];
  const ctx = { ui: { notify: (m) => notices.push(String(m)), setStatus: () => {}, getEditorText: () => "", setEditorText: () => {} } };
  await sessionStart?.({}, ctx);
  check("session_start announces the extension", notices.some((n) => /meeting-scribe active/.test(n)));

  notices.length = 0;
  await commands.scribe.handler("status", ctx);
  check("/scribe status when idle reports idle (no crash, no recording)", notices.some((n) => /idle/i.test(n)));

  notices.length = 0;
  await commands.scribe.handler("stop", ctx);
  check("/scribe stop when idle is a no-op", notices.some((n) => /not recording/i.test(n)));

  notices.length = 0;
  await commands.scribe.handler("wat", ctx);
  check("unknown subcommand prints usage", notices.some((n) => /usage: \/scribe setup/.test(n)));
}
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: "pipe" });

function utter(voice, text, out) {
  const aiff = path.join(TMP, `${out}.aiff`);
  sh("say", ["-v", voice, "-o", aiff, text]);
  sh("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", aiff, "-ar", "16000", "-ac", "1", "-y", path.join(TMP, `${out}.wav`)]);
  return path.join(TMP, `${out}.wav`);
}

// A = Alex (male), B = Samantha (female) — the pair with a real embedding margin.
utter("Alex", "The deployment window is Thursday afternoon and the migration needs sign off before then.", "a1");
utter("Samantha", "I can finish the schema review by Wednesday if I get the staging credentials today.", "b1");
utter("Samantha", "Half a day should be enough for a rehearsal on the staging cluster.", "b2");
utter("Alex", "Agreed, let us put the rollback test on the plan for Tuesday morning.", "a2");
// The mic fixture is speaker A again, and LONGER than A's system-stream time —
// so A must both link across streams and win the "who owns the mic" judgement.
utter("Alex", "Sorry, one more thing before we all drop off the call this afternoon.", "mic1");
utter("Alex", "I will send the staging credentials over this evening, they are in the shared vault.", "mic2");
utter("Alex", "Let us also book thirty minutes on Friday to review how the rehearsal went.", "mic3");
sh("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "1", "-y", path.join(TMP, "sil.wav")]);

function concat(parts, out) {
  const list = path.join(TMP, `${out}.txt`);
  fs.writeFileSync(list, parts.flatMap((p) => [`file '${path.join(TMP, p + ".wav")}'`, `file '${path.join(TMP, "sil.wav")}'`]).join("\n"));
  const dst = path.join(TMP, `${out}.wav`);
  sh("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-ar", "16000", "-ac", "1", "-y", dst]);
  return dst;
}

// chunk1 = A then B ; chunk2 = B then A  (order flipped, so a chunk-local
// numbering scheme that ignores global identity necessarily gets this wrong)
const chunk1 = concat(["a1", "b1"], "chunk1");
const chunk2 = concat(["b2", "a2"], "chunk2");
const micWav = concat(["mic1", "mic2", "mic3"], "micchunk");

// ---- drive the real worker over its real JSONL protocol ----
const out = await new Promise((resolve, reject) => {
  const proc = spawn(VENV_PY, [WORKER], { env: { ...process.env, SCRIBE_MODEL_DIR: MODEL_DIR } });
  let buf = "";
  const lines = [];
  const timer = setTimeout(() => {
    proc.kill("SIGKILL");
    reject(new Error("worker timed out after 300s"));
  }, 300000);
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const obj = JSON.parse(line);
      lines.push(obj);
      if (obj.type === "ready") {
        proc.stdin.write(JSON.stringify({ wav: chunk1, stream: "system", t0: 0 }) + "\n");
        proc.stdin.write(JSON.stringify({ wav: chunk2, stream: "system", t0: 30 }) + "\n");
        proc.stdin.write(JSON.stringify({ wav: micWav, stream: "mic", t0: 60 }) + "\n");
      }
      if (lines.filter((l) => l.type === "done").length === 3 && !lines.some((l) => l.type === "summary")) {
        proc.stdin.write(JSON.stringify({ cmd: "summary" }) + "\n");
      }
      if (obj.type === "summary") {
        proc.stdin.write(JSON.stringify({ cmd: "quit" }) + "\n");
        proc.stdin.end();
      }
    }
  });
  proc.stderr.on("data", (d) => process.env.SCRIBE_DEBUG && console.error(d.toString()));
  proc.on("close", () => {
    clearTimeout(timer);
    resolve(lines);
  });
});

const utts = out.filter((l) => l.type === "utt");
const errors = out.filter((l) => l.type === "error");
check("worker announced ready", out.some((l) => l.type === "ready"));
check("no worker errors", errors.length === 0 || (console.log("  errors:", JSON.stringify(errors)), false));
check("all three chunks completed", out.filter((l) => l.type === "done").length === 3);

// collapse consecutive same-speaker utterances — the diarizer may split one
// person's turn into several segments, which is fine; the SEQUENCE is the claim.
const seq = (stream, t0lo, t0hi) => {
  const s = utts.filter((u) => u.stream === stream && u.t0 >= t0lo && u.t0 < t0hi).sort((a, b) => a.t0 - b.t0);
  return s.map((u) => u.speaker).filter((sp, i, arr) => i === 0 || sp !== arr[i - 1]);
};

const c1 = seq("system", 0, 30);
const c2 = seq("system", 30, 60);
console.log(`  chunk1 speakers: ${JSON.stringify(c1)}   (truth: A then B)`);
console.log(`  chunk2 speakers: ${JSON.stringify(c2)}   (truth: B then A)`);

check("chunk1 separated two speakers", c1.length === 2 && c1[0] !== c1[1]);
check("chunk2 separated two speakers", c2.length === 2 && c2[0] !== c2[1]);
// THE point of this test: identity survives the chunk boundary.
check("speaker A keeps its identity across the chunk boundary", c1.length === 2 && c2.length === 2 && c1[0] === c2[1]);
check("speaker B keeps its identity across the chunk boundary", c1.length === 2 && c2.length === 2 && c1[1] === c2[0]);
check("no third speaker invented across chunks", new Set([...c1, ...c2]).size === 2);
check("speakers numbered in order of first speech", c1[0] === "Speaker 1" && c1[1] === "Speaker 2");

const mic = utts.filter((u) => u.stream === "mic");
const micSpeakers = [...new Set(mic.map((u) => u.speaker))];
console.log(`  mic speakers:    ${JSON.stringify(micSpeakers)}   (truth: A, the same A as on system)`);
check("mic produced transcript", mic.length > 0);
check("mic stream is diarized, not hard-labelled Me", mic.length > 0 && !mic.some((u) => u.speaker === "Me"));
check("mic timestamps are offset by the chunk t0", mic.every((u) => u.t0 >= 60));
// THE cross-stream claim: speaker A on the mic is recognised as the same person
// as speaker A on the system stream, because both share one identity store.
check("speaker A on the mic links to speaker A on the system stream", micSpeakers.length === 1 && micSpeakers[0] === c1[0]);
check("mic did not invent a new identity", new Set([...c1, ...c2, ...micSpeakers]).size === 2);

// ---- who owns the mic ----
const summary = out.find((l) => l.type === "summary");
console.log(`  summary:         me=${summary?.me}  speakers=${JSON.stringify(summary?.speakers)}`);
check("worker emitted a summary", !!summary);
check("the mic-dominant speaker is identified as Me", summary?.me === c1[0]);
check("summary reports per-stream speech time", !!summary?.speakers && Object.values(summary.speakers).some((v) => "mic" in v && "system" in v));
// Speaker B is only ever on the system stream, so must never be picked as Me.
check("a system-only speaker is never picked as Me", summary?.me !== c1[1]);

fs.rmSync(TMP, { recursive: true, force: true });

// ---- report ----
let failed = 0;
for (const [label, ok] of results) {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
}
console.log(failed === 0 ? "test-meeting-scribe: ALL PASS" : `test-meeting-scribe: ${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
