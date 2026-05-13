// queue.ts
// Queue messages for delivery after Pi finishes working.
//
// /q "message"        — add to queue (delivered after current work completes)
// /q                  — show queued messages
// /q clear            — clear the queue
//
// When Pi finishes a turn and the queue has items, the next item is sent
// as a user message — triggering a fresh turn. Items are processed one
// at a time: each turn_end pops one item, so Pi fully completes each
// queued task before starting the next.
//
// Install: copy to ~/.pi/agent/extensions/queue.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const queue: string[] = [];
let processing = false;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    ctx.ui.notify(`queue active — /q "message" to queue work for after Pi finishes`, "info");
  });

  pi.on("turn_end", async () => {
    if (queue.length === 0 || processing) return;
    processing = true;

    const next = queue.shift()!;
    try {
      await (pi as any).sendUserMessage(`[queued] ${next}`);
    } catch {
      queue.unshift(next);
    } finally {
      processing = false;
    }
  });

  pi.registerCommand("q", {
    description: 'Queue a message for after Pi finishes. Usage: /q "do tests next"',
    handler: async (args: string, ctx: any) => {
      const text = (args ?? "").trim();

      if (!text) {
        if (queue.length === 0) {
          ctx.ui.notify("Queue is empty.", "info");
        } else {
          const list = queue.map((m, i) => `${i + 1}. ${m}`).join("\n");
          ctx.ui.notify(`Queued (${queue.length}):\n${list}`, "info");
        }
        return;
      }

      if (text === "clear") {
        const count = queue.length;
        queue.length = 0;
        ctx.ui.notify(`Queue cleared (${count} items removed).`, "info");
        return;
      }

      const msg = text.replace(/^["']|["']$/g, "");
      queue.push(msg);
      ctx.ui.notify(`Queued #${queue.length}: ${msg}`, "info");
    },
  });
}
