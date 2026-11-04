// lmstudio-console.ts
// Interactive LM Studio model console inside Pi.
// /lmstudio → pick a model from the server's list → load / unload / swap,
// with optional custom context length. Talks to LM Studio's management REST
// API (GET /api/v0/models for state, POST /api/v1/models/load|unload) — works
// against remote instances. The base URL comes from the lmstudio provider in
// ~/.pi/agent/models.json (override: LMSTUDIO_URL env; fallback: localhost:1234).
//
// Commands:
//   /lmstudio                      — interactive console (select model → action)
//   /lmstudio status               — print model states, no dialogs
//   /lmstudio load <id> [ctx]      — load a model (optional context length)
//   /lmstudio unload <id|all>      — unload one loaded model, or all
//
// Install: copy to ~/.pi/agent/extensions/lmstudio-console.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PIFORGE_CONFIG = path.join(os.homedir(), ".pi", "piforge.json");
const MODELS_JSON = path.join(os.homedir(), ".pi", "agent", "models.json");
const API_TIMEOUT_MS = 15_000;
const LOAD_TIMEOUT_MS = 600_000; // a 27B loading from cold disk can take minutes

interface LmModel {
  id: string;
  type: string; // "llm" | "vlm" | "embeddings"
  state: "loaded" | "not-loaded";
  quantization?: string;
  max_context_length?: number;
  loaded_context_length?: number;
}

function isDisabled(): boolean {
  try {
    return JSON.parse(fs.readFileSync(PIFORGE_CONFIG, "utf-8")).disabled.includes("lmstudio-console");
  } catch {
    return false;
  }
}

function baseUrl(): string {
  const strip = (u: string) => u.replace(/\/+$/, "").replace(/\/v1$/, "");
  if (process.env.LMSTUDIO_URL) return strip(process.env.LMSTUDIO_URL);
  try {
    const models = JSON.parse(fs.readFileSync(MODELS_JSON, "utf-8"));
    const url = models?.providers?.lmstudio?.baseUrl;
    if (typeof url === "string" && url) return strip(url);
  } catch {}
  return "http://localhost:1234";
}

async function api<T>(method: "GET" | "POST", endpoint: string, body?: unknown, timeoutMs = API_TIMEOUT_MS): Promise<T> {
  const res = await fetch(`${baseUrl()}${endpoint}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || json?.error) {
    const e = json?.error;
    throw new Error(typeof e === "string" ? e : e?.message ?? `HTTP ${res.status}`);
  }
  return json as T;
}

const fetchModels = async (): Promise<LmModel[]> =>
  (await api<{ data: LmModel[] }>("GET", "/api/v0/models")).data;

const loadModel = (id: string, contextLength?: number) =>
  api<{ instance_id: string; load_time_seconds: number; status: string }>(
    "POST",
    "/api/v1/models/load",
    contextLength ? { model: id, context_length: contextLength } : { model: id },
    LOAD_TIMEOUT_MS,
  );

const unloadModel = (id: string) => api("POST", "/api/v1/models/unload", { instance_id: id });

function fmtRow(m: LmModel): string {
  const dot = m.state === "loaded" ? "●" : "○";
  const quant = m.quantization ? ` ${m.quantization}` : "";
  const ctx =
    m.state === "loaded" && m.loaded_context_length
      ? ` — loaded @ ${m.loaded_context_length} ctx`
      : ` (max ${m.max_context_length ?? "?"} ctx)`;
  return `${dot} ${m.id}${quant}${ctx}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (isDisabled()) return;
    ctx.ui.notify(`lmstudio-console: active — /lmstudio → ${baseUrl()}`, "info");
  });

  pi.registerCommand("lmstudio", {
    description: "LM Studio console: list / load / unload models on the inference server",
    handler: async (args, ctx) => {
      if (isDisabled()) {
        ctx.ui.notify("lmstudio-console is disabled (/piforge enable lmstudio-console)", "info");
        return;
      }

      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0];

      const doLoad = async (id: string, contextLength?: number) => {
        const ctxLabel = contextLength ? ` @ ${contextLength} ctx` : "";
        ctx.ui.setStatus("lmstudio", `loading ${id}…`);
        ctx.ui.notify(`lmstudio: loading ${id}${ctxLabel} — a big model can take minutes…`, "info");
        try {
          const r = await loadModel(id, contextLength);
          ctx.ui.notify(`lmstudio: ${r.instance_id} loaded in ${r.load_time_seconds}s${ctxLabel}`, "info");
        } finally {
          ctx.ui.setStatus("lmstudio", undefined);
        }
      };

      try {
        if (sub === "status" || sub === "load" || sub === "unload") {
          // non-interactive subcommands (scriptable)
          const models = await fetchModels();
          if (sub === "status") {
            ctx.ui.notify(`LM Studio @ ${baseUrl()}\n` + models.map((m) => "  " + fmtRow(m)).join("\n"), "info");
            return;
          }
          const id = parts[1];
          if (!id) {
            ctx.ui.notify(`usage: /lmstudio ${sub} <model-id>${sub === "load" ? " [context-length]" : " | all"}`, "info");
            return;
          }
          if (sub === "unload") {
            const targets = id === "all" ? models.filter((m) => m.state === "loaded").map((m) => m.id) : [id];
            if (targets.length === 0) {
              ctx.ui.notify("lmstudio: nothing loaded", "info");
              return;
            }
            for (const t of targets) await unloadModel(t);
            ctx.ui.notify(`lmstudio: unloaded ${targets.join(", ")}`, "info");
            return;
          }
          const ctxLen = parts[2] ? parseInt(parts[2], 10) : undefined;
          if (parts[2] && (!ctxLen || ctxLen <= 0)) {
            ctx.ui.notify(`lmstudio: invalid context length "${parts[2]}"`, "error");
            return;
          }
          await doLoad(id, ctxLen);
          return;
        }

        // interactive console
        const models = await fetchModels();
        if (models.length === 0) {
          ctx.ui.notify("lmstudio: server reachable but no models downloaded", "warning");
          return;
        }
        const rows = models.map(fmtRow);
        const choice = await ctx.ui.select(`LM Studio @ ${baseUrl()}`, rows);
        if (!choice) return;
        const model = models[rows.indexOf(choice)];

        if (model.state === "loaded") {
          const action = await ctx.ui.select(`${model.id} — loaded @ ${model.loaded_context_length ?? "?"} ctx`, [
            "Unload",
            "Reload with different context…",
            "Cancel",
          ]);
          if (!action || action === "Cancel") return;
          if (action === "Unload") {
            await unloadModel(model.id);
            ctx.ui.notify(`lmstudio: ${model.id} unloaded`, "info");
            return;
          }
          const input = await ctx.ui.input("New context length", `e.g. 95000 (max ${model.max_context_length ?? "?"})`);
          const ctxLen = input ? parseInt(input, 10) : NaN;
          if (!ctxLen || ctxLen <= 0) return;
          await unloadModel(model.id);
          await doLoad(model.id, ctxLen);
          return;
        }

        const action = await ctx.ui.select(`${model.id} — not loaded`, [
          "Load (server default context)",
          "Load with custom context…",
          "Swap (unload loaded models, then load this)",
          "Cancel",
        ]);
        if (!action || action === "Cancel") return;

        let ctxLen: number | undefined;
        if (action.startsWith("Load with custom")) {
          const input = await ctx.ui.input("Context length", `e.g. 95000 (max ${model.max_context_length ?? "?"})`);
          ctxLen = input ? parseInt(input, 10) : NaN;
          if (!ctxLen || ctxLen <= 0) return;
        }
        if (action.startsWith("Swap")) {
          const loaded = models.filter((m) => m.state === "loaded");
          for (const m of loaded) {
            ctx.ui.notify(`lmstudio: unloading ${m.id}…`, "info");
            await unloadModel(m.id);
          }
        }
        await doLoad(model.id, ctxLen);
      } catch (e: any) {
        ctx.ui.setStatus("lmstudio", undefined);
        const msg = e?.name === "TimeoutError" ? "request timed out" : (e?.message ?? String(e));
        ctx.ui.notify(`lmstudio: ${msg} (server: ${baseUrl()})`, "error");
      }
    },
  });
}
