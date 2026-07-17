import { useEffect, useRef, useState } from "react";
import { API_BASE, getToken } from "./api";

export type MerchantEventType = "order.new" | "order.escalation" | "order.changed";

export interface MerchantEvent {
  merchantId: string;
  type: MerchantEventType;
  orderId: string;
  detail?: string;
  at: string;
}

/** Wait before reconnecting, backing off so a dead server is not hammered. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Subscribes to the shop's live order events.
 *
 * WHY fetch AND NOT EventSource: the browser's EventSource cannot set request
 * headers, so it could only authenticate by putting the JWT in the query
 * string — where it would land in server access logs, browser history, and any
 * Referer. The token is valid for 7 days. Streaming the response with fetch
 * lets it travel in the Authorization header like every other request.
 *
 * The caller keeps polling as well. That is deliberate, not redundancy for its
 * own sake: the stream is in-process on the server, so behind a load balancer a
 * dashboard connected to instance A would miss an event emitted on instance B.
 * The poll is the floor — it guarantees the order is seen *eventually* even if
 * the stream is broken, absent, or connected to the wrong instance. The stream
 * makes it *immediate*. Losing the stream degrades latency, never correctness.
 */
export function useMerchantEvents(onEvent: (event: MerchantEvent) => void) {
  const [connected, setConnected] = useState(false);

  // Held in a ref so a re-render with a new callback does not tear down and
  // reconnect the stream.
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    const controller = new AbortController();
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    async function connect() {
      if (stopped) return;

      const token = getToken();
      if (!token) return; // Signed out — nothing to watch.

      try {
        const response = await fetch(`${API_BASE}/merchant/orders/stream`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`Stream refused with ${response.status}`);
        }

        setConnected(true);
        attempt = 0; // A good connection resets the backoff.

        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += value;

          // SSE frames are separated by a blank line. Anything after the last
          // separator is a partial frame and must stay in the buffer.
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
            if (!dataLine) continue;
            try {
              handlerRef.current(JSON.parse(dataLine.slice(5).trim()) as MerchantEvent);
            } catch {
              // A malformed frame must not kill the stream.
            }
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return; // We closed it on purpose.
      } finally {
        setConnected(false);
      }

      // Reconnect with backoff. The poll covers the gap meanwhile.
      if (stopped) return;
      attempt += 1;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
      reconnectTimer = setTimeout(() => void connect(), delay);
    }

    void connect();

    return () => {
      stopped = true;
      controller.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

  return { connected };
}
