import { describe, expect, test } from "bun:test";
import runTimerExtension, { formatElapsed } from "./index";

interface IntervalHandle {
  id: number;
}

interface FakeTheme {
  fg(color: string, text: string): string;
}

interface FakeUI {
  theme: FakeTheme;
  workingMessages: Array<string | undefined>;
  statuses: Array<{ key: string; text: string | undefined }>;
  setWorkingMessage(message?: string): void;
  setStatus(key: string, text: string | undefined): void;
}

interface FakeContext {
  hasUI: boolean;
  ui: FakeUI;
}

type Handler = (event: Record<string, unknown>, ctx: FakeContext) => Promise<void> | void;

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const intervals = new Map<number, { intervalMs: number; nextRunAt: number; callback: () => void }>();

  return {
    now: () => now,
    setInterval(callback: () => void, intervalMs: number): IntervalHandle {
      const handle = { id: nextId++ };
      intervals.set(handle.id, { intervalMs, nextRunAt: now + intervalMs, callback });
      return handle;
    },
    clearInterval(handle: IntervalHandle | undefined) {
      if (!handle) return;
      intervals.delete(handle.id);
    },
    advance(ms: number) {
      const target = now + ms;
      while (true) {
        let nextDue: { id: number; nextRunAt: number; callback: () => void; intervalMs: number } | undefined;
        for (const [id, interval] of intervals) {
          if (interval.nextRunAt > target) continue;
          if (!nextDue || interval.nextRunAt < nextDue.nextRunAt) {
            nextDue = { id, ...interval };
          }
        }
        if (!nextDue) break;
        now = nextDue.nextRunAt;
        nextDue.callback();
        const current = intervals.get(nextDue.id);
        if (current) {
          current.nextRunAt = now + current.intervalMs;
        }
      }
      now = target;
    },
  };
}

function createHarness() {
  const handlers = new Map<string, Handler[]>();
  const theme: FakeTheme = {
    fg(color: string, text: string) {
      return `<${color}>${text}</${color}>`;
    },
  };
  const ui: FakeUI = {
    theme,
    workingMessages: [],
    statuses: [],
    setWorkingMessage(message?: string) {
      ui.workingMessages.push(message);
    },
    setStatus(key: string, text: string | undefined) {
      ui.statuses.push({ key, text });
    },
  };

  return {
    ui,
    pi: {
      on(event: string, handler: Handler) {
        const existing = handlers.get(event) ?? [];
        existing.push(handler);
        handlers.set(event, existing);
      },
    },
    async emit(type: string, ctxOverrides: Partial<FakeContext> = {}, event: Record<string, unknown> = {}) {
      const ctx: FakeContext = {
        hasUI: true,
        ui,
        ...ctxOverrides,
      };
      for (const handler of handlers.get(type) ?? []) {
        await handler({ type, ...event }, ctx);
      }
    },
  };
}

describe("formatElapsed", () => {
  test("formats seconds, minutes, and hours with spaces between units", () => {
    expect(formatElapsed(12_300)).toBe("12.3s");
    expect(formatElapsed(59_900)).toBe("59.9s");
    expect(formatElapsed(59_950)).toBe("1m 0s");
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(3_599_900)).toBe("59m 59s");
    expect(formatElapsed(3_600_000)).toBe("1hr 0m 0s");
  });
});


describe("omp-run-timer", () => {
  test("keeps the latest tool intent visible until the next tool starts", async () => {
    const clock = createFakeClock();
    const harness = createHarness();
    runTimerExtension(harness.pi as never, {
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await harness.emit("agent_start");
    expect(harness.ui.statuses).toContainEqual({ key: "0-run-timer", text: undefined });
    expect(harness.ui.workingMessages.at(-1)).toBe("Working… · 0.0s (esc to interrupt)");

    clock.advance(1200);
    expect(harness.ui.workingMessages.at(-1)).toBe("Working… · 1.2s (esc to interrupt)");

    await harness.emit("tool_execution_start", {}, { toolCallId: "1", toolName: "read", intent: "Reading config" });
    expect(harness.ui.workingMessages.at(-1)).toBe("Reading config · 1.2s (esc to interrupt)");

    clock.advance(300);
    expect(harness.ui.workingMessages.at(-1)).toBe("Reading config · 1.5s (esc to interrupt)");

    await harness.emit("tool_execution_end", {}, { toolCallId: "1", toolName: "read" });
    expect(harness.ui.workingMessages.at(-1)).toBe("Reading config · 1.5s (esc to interrupt)");

    await harness.emit("tool_execution_start", {}, { toolCallId: "2", toolName: "grep", intent: "Searching files" });
    expect(harness.ui.workingMessages.at(-1)).toBe("Searching files · 1.5s (esc to interrupt)");

    await harness.emit("tool_execution_start", {}, { toolCallId: "3", toolName: "bash" });
    expect(harness.ui.workingMessages.at(-1)).toBe("Searching files · 1.5s (esc to interrupt)");
  });

  test("pauses the working timer while ask is waiting", async () => {
    const clock = createFakeClock();
    const harness = createHarness();
    runTimerExtension(harness.pi as never, {
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await harness.emit("agent_start");
    clock.advance(800);
    expect(harness.ui.workingMessages.at(-1)).toBe("Working… · 0.8s (esc to interrupt)");

    await harness.emit("tool_execution_start", {}, { toolCallId: "ask-1", toolName: "ask" });
    const writesBeforePause = harness.ui.workingMessages.length;
    const pausedMessage = harness.ui.workingMessages.at(-1);

    clock.advance(5_000);

    expect(harness.ui.workingMessages).toHaveLength(writesBeforePause);
    expect(harness.ui.workingMessages.at(-1)).toBe(pausedMessage);
  });

  test("resumes after ask without counting paused time and keeps the prior intent", async () => {
    const clock = createFakeClock();
    const harness = createHarness();
    runTimerExtension(harness.pi as never, {
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await harness.emit("agent_start");
    clock.advance(1200);
    await harness.emit("tool_execution_start", {}, { toolCallId: "1", toolName: "read", intent: "Reading config" });
    clock.advance(300);
    expect(harness.ui.workingMessages.at(-1)).toBe("Reading config · 1.5s (esc to interrupt)");

    await harness.emit("tool_execution_start", {}, { toolCallId: "ask-1", toolName: "ask" });
    clock.advance(4_000);
    expect(harness.ui.workingMessages.at(-1)).toBe("Reading config · 1.5s (esc to interrupt)");

    await harness.emit("tool_execution_end", {}, { toolCallId: "ask-1", toolName: "ask" });
    clock.advance(200);

    expect(harness.ui.workingMessages.at(-1)).toBe("Reading config · 1.7s (esc to interrupt)");
  });

  test("excludes ask wait time from Last run across multiple pauses", async () => {
    const clock = createFakeClock();
    const harness = createHarness();
    runTimerExtension(harness.pi as never, {
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await harness.emit("agent_start");
    clock.advance(500);
    await harness.emit("tool_execution_start", {}, { toolCallId: "ask-1", toolName: "ask" });
    clock.advance(2_000);
    await harness.emit("tool_execution_end", {}, { toolCallId: "ask-1", toolName: "ask" });

    clock.advance(300);
    await harness.emit("tool_execution_start", {}, { toolCallId: "ask-2", toolName: "ask" });
    clock.advance(1_500);
    await harness.emit("tool_execution_end", {}, { toolCallId: "ask-2", toolName: "ask" });

    clock.advance(200);
    await harness.emit("agent_end");

    expect(harness.ui.statuses.at(-1)).toEqual({ key: "0-run-timer", text: "⏱ \u2007Last run · 1.0s" });
  });

  test("keeps counting through non-ask tools", async () => {
    const clock = createFakeClock();
    const harness = createHarness();
    runTimerExtension(harness.pi as never, {
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await harness.emit("agent_start");
    clock.advance(800);
    await harness.emit("tool_execution_start", {}, { toolCallId: "1", toolName: "read", intent: "Reading config" });

    clock.advance(500);

    expect(harness.ui.workingMessages.at(-1)).toBe("Reading config · 1.3s (esc to interrupt)");
  });


  test("dedupes working message writes when repeated ticks do not change visible text", async () => {
    const clock = createFakeClock();
    const harness = createHarness();
    runTimerExtension(harness.pi as never, {
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await harness.emit("agent_start");
    expect(harness.ui.workingMessages).toEqual(["Working… · 0.0s (esc to interrupt)"]);

    clock.advance(50);
    expect(harness.ui.workingMessages).toEqual(["Working… · 0.0s (esc to interrupt)"]);

    clock.advance(100);
    expect(harness.ui.workingMessages).toEqual([
      "Working… · 0.0s (esc to interrupt)",
      "Working… · 0.1s (esc to interrupt)",
    ]);

    clock.advance(100);
    expect(harness.ui.workingMessages).toEqual([
      "Working… · 0.0s (esc to interrupt)",
      "Working… · 0.1s (esc to interrupt)",
      "Working… · 0.2s (esc to interrupt)",
    ]);

    await harness.emit("tool_execution_start", {}, { toolCallId: "1", toolName: "read", intent: "Reading config" });
    expect(harness.ui.workingMessages.at(-1)).toBe("Reading config · 0.3s (esc to interrupt)");
    const writesAfterIntentSwitch = harness.ui.workingMessages.length;

    clock.advance(50);
    expect(harness.ui.workingMessages).toHaveLength(writesAfterIntentSwitch);
  });


  test("writes final duration to status and clears working message on agent_end", async () => {
    const clock = createFakeClock();
    const harness = createHarness();
    runTimerExtension(harness.pi as never, {
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await harness.emit("agent_start");
    clock.advance(2300);
    await harness.emit("agent_end");

    expect(harness.ui.workingMessages.at(-1)).toBeUndefined();
    expect(harness.ui.statuses.at(-1)).toEqual({ key: "0-run-timer", text: "⏱ \u2007Last run · 2.3s" });
  });

  test("clears residual UI state on session lifecycle events", async () => {
    const clock = createFakeClock();
    const harness = createHarness();
    runTimerExtension(harness.pi as never, {
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await harness.emit("agent_start");
    clock.advance(800);
    await harness.emit("tool_execution_start", {}, { toolCallId: "1", toolName: "grep", intent: "Searching files" });

    await harness.emit("session_switch", {}, { reason: "resume", previousSessionFile: "old.json" });
    expect(harness.ui.workingMessages.at(-1)).toBeUndefined();
    expect(harness.ui.statuses.at(-1)).toEqual({ key: "0-run-timer", text: undefined });

    await harness.emit("agent_start");
    clock.advance(400);
    await harness.emit("session_start");
    expect(harness.ui.workingMessages.at(-1)).toBeUndefined();
    expect(harness.ui.statuses.at(-1)).toEqual({ key: "0-run-timer", text: undefined });
  });

  test("ignores non-UI events", async () => {
    const clock = createFakeClock();
    const harness = createHarness();
    runTimerExtension(harness.pi as never, {
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await harness.emit("agent_start", { hasUI: false });
    clock.advance(1000);
    await harness.emit("tool_execution_start", { hasUI: false }, { toolCallId: "1", toolName: "read", intent: "Should not show" });
    await harness.emit("agent_end", { hasUI: false });

    expect(harness.ui.workingMessages).toEqual([]);
    expect(harness.ui.statuses).toEqual([]);
  });

  test("dedupes clearing the working message when UI is already reset", async () => {
    const clock = createFakeClock();
    const harness = createHarness();
    runTimerExtension(harness.pi as never, {
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await harness.emit("agent_start");
    await harness.emit("agent_end");
    expect(harness.ui.workingMessages.at(-1)).toBeUndefined();
    const writesAfterFirstClear = harness.ui.workingMessages.length;

    await harness.emit("agent_end");
    await harness.emit("session_start");
    expect(harness.ui.workingMessages).toHaveLength(writesAfterFirstClear);
  });

  test("handles tool events and agent_end safely without an active run", async () => {
    const clock = createFakeClock();
    const harness = createHarness();
    runTimerExtension(harness.pi as never, {
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await harness.emit("tool_execution_start", {}, { toolCallId: "1", toolName: "read", intent: "Reading config" });
    expect(harness.ui.workingMessages.at(-1)).toBe("Reading config · 0.0s (esc to interrupt)");

    clock.advance(500);
    await harness.emit("tool_execution_end", {}, { toolCallId: "1", toolName: "read" });
    expect(harness.ui.workingMessages.at(-1)).toBe("Reading config · 0.5s (esc to interrupt)");

    await harness.emit("agent_end");
    expect(harness.ui.statuses.at(-1)).toEqual({ key: "0-run-timer", text: "⏱ \u2007Last run · 0.5s" });
  });
});
