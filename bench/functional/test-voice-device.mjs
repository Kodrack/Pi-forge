// FUNCTIONAL test: voice-input's audio-device resolution, against the REAL
// device list on this machine plus recorded fixtures.
//
// The bug: AUDIO_DEVICE was hardcoded ":0" = "the default mic". avfoundation
// indices are positions in an enumeration, not stable ids. Installing a virtual
// audio device (BlackHole, Loopback, an Aggregate device…) inserted it at index
// 0 and pushed the MacBook Pro Microphone to 1, so voice-input recorded the
// virtual loopback. It fails silently in the worst way: a loopback carries
// system audio, so with nothing playing it produces perfectly valid SILENT wav
// segments — the "no audio captured" check passes and the transcript is empty.
//
//   bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = fs.readFileSync(path.join(REPO_ROOT, "extensions", "voice-input.ts"), "utf-8");

const results = [];
const check = (label, ok) => results.push([label, ok]);

// ---- the regression itself: the hardcoded index must be gone ----
check("AUDIO_DEVICE is no longer a hardcoded index",
  /const AUDIO_DEVICE:\s*string \| null = null/.test(SRC));
check("BlackHole is on the virtual-device denylist", /"blackhole"/.test(SRC));
check("the ffmpeg input uses the resolved device, not the const",
  /"-f", "avfoundation", "-i", device,/.test(SRC));
check("resolution happens before spawn", /const device = await resolveAudioDevice\(ffmpeg\)/.test(SRC));
check("/stt-device is registered", /registerCommand\("stt-device"/.test(SRC));
check("the empty-transcript warning names the device",
  /transcription came back empty — .*segment\(s\) recorded from \$\{dev\}/.test(SRC));
check("device list is read with raw stderr, not the 500-char-truncating run()",
  SRC.includes("execFile(ffmpeg, [\"-f\", \"avfoundation\", \"-list_devices\""));

// ---- the selection logic, against recorded and live device lists ----
// Re-implemented from the source constants so the test fails if they drift.
const virtualPatterns = JSON.parse(
  "[" + /const VIRTUAL_DEVICE_PATTERNS = \[([\s\S]*?)\];/.exec(SRC)[1].replace(/\s+/g, " ").replace(/,\s*$/, "") + "]",
);
const preferredPatterns = JSON.parse(
  "[" + /const PREFERRED_DEVICE_PATTERNS = \[([\s\S]*?)\];/.exec(SRC)[1].replace(/\s+/g, " ").replace(/,\s*$/, "") + "]",
);
const isVirtual = (n) => virtualPatterns.some((p) => n.toLowerCase().includes(p));
const pickDevice = (devices) => {
  const real = devices.filter((d) => !isVirtual(d.name));
  if (real.length === 0) return devices[0] ?? null;
  return real.find((d) => preferredPatterns.some((p) => d.name.toLowerCase().includes(p))) ?? real[0];
};

// The exact machine state that caused the bug.
{
  const recorded = [
    { index: 0, name: "BlackHole 2ch" },
    { index: 1, name: "MacBook Pro Microphone" },
    { index: 2, name: "Immersed" },
    { index: 3, name: "Microsoft Teams Audio" },
    { index: 4, name: "AirBeamTV Audio" },
  ];
  const got = pickDevice(recorded);
  check(`recorded incident list → picks the real mic, not BlackHole (got "${got.name}")`,
    got.name === "MacBook Pro Microphone");
  check("BlackHole classified virtual", isVirtual("BlackHole 2ch"));
  check("Teams Audio classified virtual", isVirtual("Microsoft Teams Audio"));
  check("a real mic is NOT classified virtual", !isVirtual("MacBook Pro Microphone"));
  check("an external USB mic is NOT classified virtual", !isVirtual("Yeti Nano"));
}

// Ordering must not matter — that was the whole bug.
{
  const shuffled = [
    { index: 0, name: "Loopback Audio" },
    { index: 1, name: "BlackHole 16ch" },
    { index: 2, name: "Shure MV7" },
  ];
  check("real device found even at a nonzero index", pickDevice(shuffled).name === "Shure MV7");
}
{
  check("all-virtual list still returns something (record, but warn)",
    pickDevice([{ index: 0, name: "BlackHole 2ch" }]).name === "BlackHole 2ch");
  check("empty list is handled", pickDevice([]) === null);
}

// ---- live check against this machine ----
{
  const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((p) => fs.existsSync(p));
  if (!ffmpeg) {
    console.log("  SKIP  live device check (ffmpeg not found)");
  } else {
    const stderr = await new Promise((r) =>
      execFile(ffmpeg, ["-f", "avfoundation", "-list_devices", "true", "-i", ""],
        { timeout: 15000, maxBuffer: 1024 * 1024 }, (_e, _o, s) => r(String(s ?? ""))));
    const audio = stderr.slice(stderr.indexOf("AVFoundation audio devices"));
    const live = [...audio.matchAll(/\[(\d+)\]\s+(.+?)\s*$/gm)].map((m) => ({ index: +m[1], name: m[2] }));
    check(`live enumeration parses (${live.length} inputs found)`, live.length > 0);
    if (live.length) {
      const got = pickDevice(live);
      check(`live pick is a real input (got "${got.name}" at :${got.index})`, !isVirtual(got.name));
      check("live pick is NOT index 0 on this machine (proves the fix matters)",
        !(live[0] && isVirtual(live[0].name)) || got.index !== 0);
    }
  }
}

let failed = 0;
for (const [label, ok] of results) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
console.log(`test-voice-device (functional): ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
