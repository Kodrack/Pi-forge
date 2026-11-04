#!/usr/bin/env python3
"""Persistent STT + diarization worker for meeting-scribe.ts.

SELF-CONTAINED ON PURPOSE. This file has no dependency on anything outside the
Pi install: no shared module, no sibling import, nothing from scribe-app/. The
standalone Mac app keeps its own copy of this logic. Do not factor the two back
together -- PiForge must stay isolated so app work cannot break /scribe.

Loads parakeet-mlx and the sherpa-onnx models ONCE, then serves chunk jobs for
the life of the meeting (the extension spawns one per /scribe start and quits it
on /scribe stop, so nothing runs between meetings). Speaks JSON Lines:

  in   {"wav": "/tmp/.../seg-000.wav", "stream": "system"|"mic", "t0": 30.0}
  in   {"cmd": "summary"} / {"cmd": "quit"}
  out  {"type":"ready"}                                   models loaded
  out  {"type":"utt","t0":31.2,"speaker":"Speaker 1","text":"...","stream":"system"}
  out  {"type":"done","job":0,"utts":3,"stream":"system"} chunk fully processed
  out  {"type":"summary","me":"Speaker 2","speakers":{...}}  who owns the mic
  out  {"type":"error","job":0,"message":"..."}           chunk failed, meeting continues

BOTH streams are diarized, against ONE shared identity store, so a person keeps
a single identity regardless of which stream carries them. The mic is NOT
assumed to hold exactly one speaker -- it may be a speakerphone, a room of
people, or leaking the far end through the laptop speakers.

Diarization per chunk uses the pyannote segmentation model, which finds
speaker-CHANGE points -- plain VAD cannot, it only finds speech vs silence, so
back-to-back speakers land in one segment and their blended embedding corrupts
the voiceprint. Each chunk-local speaker is then linked to a global identity by
matching its mean embedding against running centroids. That linking is what
keeps "Speaker 2" the same person in minute 1 and minute 40.

Which identity is the user is decided at the END, from how much each voice was
heard on the mic vs the system stream (see summary) -- a judgement that needs
the whole meeting, not the first 30 seconds.

Install: copied to ~/.pi/agent/extensions/scribe-worker.py by install.sh
"""
import json
import os
import sys
import tempfile

import numpy as np
import soundfile as sf
import sherpa_onnx as so
from parakeet_mlx import from_pretrained

SR = 16000
MODEL_DIR = os.environ.get("SCRIBE_MODEL_DIR", os.path.expanduser("~/.pi/scribe-models"))
ASR_MODEL = os.environ.get("SCRIBE_ASR_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")
SEG_MODEL = os.path.join(MODEL_DIR, "segmentation.onnx")
EMB_MODEL = os.path.join(MODEL_DIR, "speaker-embedding.onnx")

# Tuned against real 4-speaker audio (bench/functional/test-meeting-scribe.mjs):
# link=0.5 / local=0.6 / 30s chunks reproduced offline global clustering exactly.
# Raise LINK_THRESHOLD if one person gets split into several speakers; lower it
# if two people get merged into one.
LINK_THRESHOLD = float(os.environ.get("SCRIBE_LINK_THRESHOLD", "0.5"))
LOCAL_THRESHOLD = float(os.environ.get("SCRIBE_LOCAL_THRESHOLD", "0.6"))
MIN_SEG_SECONDS = 0.4  # below this an embedding is too noisy to identify anyone


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class Scribe:
    def __init__(self):
        self.asr = from_pretrained(ASR_MODEL)
        self.diarizer = so.OfflineSpeakerDiarization(
            so.OfflineSpeakerDiarizationConfig(
                segmentation=so.OfflineSpeakerSegmentationModelConfig(
                    pyannote=so.OfflineSpeakerSegmentationPyannoteModelConfig(model=SEG_MODEL)
                ),
                embedding=so.SpeakerEmbeddingExtractorConfig(model=EMB_MODEL),
                # num_clusters=-1 -> discover how many people talk in THIS chunk
                clustering=so.FastClusteringConfig(num_clusters=-1, threshold=LOCAL_THRESHOLD),
                min_duration_on=0.3,
                min_duration_off=0.5,
            )
        )
        self.extractor = so.SpeakerEmbeddingExtractor(
            so.SpeakerEmbeddingExtractorConfig(model=EMB_MODEL, num_threads=2, debug=False, provider="cpu")
        )
        self.centroids = {}   # internal id -> (sum of embeddings, count)
        self.display = {}     # internal id -> "Speaker N", minted on first spoken words
        self.next_internal = 1
        self.next_display = 1
        # Seconds of speech per identity per stream. Both streams share ONE
        # identity space, so this is what tells us which voice owns the mic --
        # i.e. who "Me" is -- without assuming the mic only ever hears one person.
        self.stream_time = {}

    # ---- speaker identity ----
    def embed(self, samples):
        s = self.extractor.create_stream()
        s.accept_waveform(sample_rate=SR, waveform=samples)
        s.input_finished()
        e = np.array(self.extractor.compute(s), dtype=np.float32)
        return e / (np.linalg.norm(e) + 1e-9)

    def link(self, emb):
        """Chunk-local speaker -> stable global identity for the whole meeting."""
        best, best_sim = None, -1.0
        for iid, (vsum, n) in self.centroids.items():
            c = vsum / n
            sim = float(np.dot(emb, c / (np.linalg.norm(c) + 1e-9)))
            if sim > best_sim:
                best, best_sim = iid, sim
        if best is not None and best_sim >= LINK_THRESHOLD:
            vsum, n = self.centroids[best]
            self.centroids[best] = (vsum + emb, n + 1)  # centroid tracks the voice over the call
            return best
        iid = self.next_internal
        self.next_internal += 1
        self.centroids[iid] = (emb.copy(), 1)
        return iid

    def name_of(self, iid):
        """Number speakers in order of first *spoken words*, so a silent-but-
        detected cluster does not burn "Speaker 1" and leave the transcript
        starting at "Speaker 2"."""
        if iid not in self.display:
            self.display[iid] = f"Speaker {self.next_display}"
            self.next_display += 1
        return self.display[iid]

    # ---- transcription ----
    def say(self, samples):
        """Transcribe a float32 array (parakeet only takes paths, hence the temp wav)."""
        if len(samples) < int(MIN_SEG_SECONDS * SR):
            return ""
        fd, tmp = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            sf.write(tmp, samples, SR)
            return self.asr.transcribe(tmp).text.strip()
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    # ---- jobs ----
    def do_chunk(self, audio, t0, stream):
        """Diarize + transcribe one chunk of EITHER stream."""
        segments = list(self.diarizer.process(audio).sort_by_start_time())
        if not segments:
            return []
        # One embedding per chunk-local speaker, computed over ALL of its speech
        # in this chunk -- longer audio means a far more reliable voiceprint than
        # embedding each short segment separately.
        spans = {}
        for s in segments:
            spans.setdefault(s.speaker, []).append((s.start, s.end))
        mapping = {}
        for local, sp in spans.items():
            cat = np.concatenate([audio[int(a * SR) : int(b * SR)] for a, b in sp])
            mapping[local] = self.link(self.embed(cat))
        out = []
        for s in segments:
            iid = mapping[s.speaker]
            per = self.stream_time.setdefault(iid, {})
            per[stream] = per.get(stream, 0.0) + (s.end - s.start)
            text = self.say(audio[int(s.start * SR) : int(s.end * SR)])
            if text:
                out.append({"t0": t0 + float(s.start), "speaker": self.name_of(iid), "text": text})
        return out

    def summary(self):
        """Who owns the microphone? "Me" is the identity heard mostly on the mic:
        it must have the most mic time AND be heard more on the mic than on the
        system stream, so far-end audio bleeding into the mic through the
        speakers is not mistaken for the user."""
        me, best = None, 0.0
        for iid, per in self.stream_time.items():
            mic = per.get("mic", 0.0)
            sysm = per.get("system", 0.0)
            if mic > best and mic > sysm:
                me, best = iid, mic
        return {
            "type": "summary",
            "me": self.display.get(me) if me is not None else None,
            "speakers": {
                self.display[i]: {k: round(v, 1) for k, v in per.items()}
                for i, per in self.stream_time.items()
                if i in self.display
            },
        }


def main():
    scribe = Scribe()
    emit({"type": "ready"})
    for job_no, line in enumerate(sys.stdin):
        line = line.strip()
        if not line:
            continue
        stream = "system"
        try:
            job = json.loads(line)
            if job.get("cmd") == "quit":
                break
            if job.get("cmd") == "summary":
                emit(scribe.summary())
                continue
            stream = job.get("stream", "system")
            audio, sr = sf.read(job["wav"], dtype="float32", always_2d=False)
            if audio.ndim > 1:
                audio = audio.mean(axis=1)  # downmix if the device gave us stereo
            if sr != SR:
                raise ValueError(f"expected {SR}Hz, got {sr}")
            utts = scribe.do_chunk(audio, float(job.get("t0", 0.0)), stream)
            for u in utts:
                u.update(type="utt", stream=stream)
                emit(u)
            emit({"type": "done", "job": job_no, "utts": len(utts), "stream": stream})
        except Exception as exc:  # one bad chunk must never end the meeting
            emit({"type": "error", "job": job_no, "message": f"{type(exc).__name__}: {exc}", "stream": stream})
            emit({"type": "done", "job": job_no, "utts": 0, "stream": stream})


if __name__ == "__main__":
    main()
