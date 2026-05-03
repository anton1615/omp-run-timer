import type {
  AgentEndEvent,
  AgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  SessionSwitchEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
} from "@oh-my-pi/pi-coding-agent";

const STATUS_KEY = "0-run-timer";
const DEFAULT_WORKING_LABEL = "Working…";
const ELAPSED_ICON = "⏱";
// One ASCII space plus a figure space survives OMP footer status sanitization.
const LAST_RUN_SPACER = " \u2007";
const INTERRUPT_SUFFIX = "(esc to interrupt)";
const DEFAULT_TICK_MS = 100;

type IntervalHandle = ReturnType<typeof globalThis.setInterval>;

export interface RunTimerOptions {
  now?: () => number;
  setInterval?: (callback: () => void, intervalMs: number) => IntervalHandle;
  clearInterval?: (handle: IntervalHandle | undefined) => void;
  tickMs?: number;
}

interface ActiveRun {
  startedAt: number;
  intent: string | undefined;
  ticker: IntervalHandle | undefined;
  pausedAt: number | undefined;
  accumulatedPausedMs: number;
}

export function formatElapsed(ms: number): string {
  const elapsedSeconds = Math.max(0, ms) / 1000;
  const roundedTenths = Math.round(elapsedSeconds * 10) / 10;
  if (roundedTenths < 60) {
    return `${roundedTenths.toFixed(1)}s`;
  }

  const totalSeconds = Math.max(60, Math.floor(elapsedSeconds));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${seconds}s`;
  }

  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}hr ${minutes}m ${seconds}s`;
}

function normalizeIntent(intent: unknown): string | undefined {
  if (typeof intent !== "string") return undefined;
  const trimmed = intent.trim();
  return trimmed ? trimmed : undefined;
}
function buildWorkingMessage(intent: string | undefined, elapsedMs: number): string {
  const label = intent ?? DEFAULT_WORKING_LABEL;
  return `${label} · ${formatElapsed(elapsedMs)} ${INTERRUPT_SUFFIX}`;
}

export function createRunTimerExtension(options: RunTimerOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const setTicker = options.setInterval ?? ((callback, intervalMs) => globalThis.setInterval(callback, intervalMs));
  const clearTicker = options.clearInterval ?? (handle => {
    if (handle) {
      globalThis.clearInterval(handle);
    }
  });
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;

  return function runTimerExtension(pi: ExtensionAPI): void {
    let activeRun: ActiveRun | undefined;
    let lastWorkingMessage: string | undefined;

    const getElapsedMs = () => {
      if (!activeRun) return 0;
      const pausedMs = activeRun.pausedAt === undefined ? 0 : now() - activeRun.pausedAt;
      return now() - activeRun.startedAt - activeRun.accumulatedPausedMs - pausedMs;
    };

    const stopTicker = () => {
      if (!activeRun?.ticker) return;
      clearTicker(activeRun.ticker);
      activeRun.ticker = undefined;
    };

    const pauseRun = () => {
      if (!activeRun || activeRun.pausedAt !== undefined) return;
      stopTicker();
      activeRun.pausedAt = now();
    };

    const resumeRun = (ctx: ExtensionContext) => {
      if (!activeRun || activeRun.pausedAt === undefined) return;
      activeRun.accumulatedPausedMs += now() - activeRun.pausedAt;
      activeRun.pausedAt = undefined;
      startTicker(ctx);
    };

    const setWorkingMessage = (ctx: ExtensionContext, message: string) => {
      if (message === lastWorkingMessage) return;
      ctx.ui.setWorkingMessage(message);
      lastWorkingMessage = message;
    };

    const clearWorkingMessage = (ctx: ExtensionContext) => {
      if (lastWorkingMessage === undefined) return;
      lastWorkingMessage = undefined;
      ctx.ui.setWorkingMessage();
    };

    const renderWorkingMessage = (ctx: ExtensionContext) => {
      if (!activeRun) return;
      setWorkingMessage(ctx, buildWorkingMessage(activeRun.intent, getElapsedMs()));
    };

    const startTicker = (ctx: ExtensionContext) => {
      if (!activeRun || tickMs <= 0) return;
      stopTicker();
      activeRun.ticker = setTicker(() => {
        if (!activeRun) return;
        renderWorkingMessage(ctx);
      }, tickMs);
    };

    const ensureRun = (ctx: ExtensionContext) => {
      if (activeRun) return activeRun;
      activeRun = {
        startedAt: now(),
        intent: undefined,
        ticker: undefined,
        pausedAt: undefined,
        accumulatedPausedMs: 0,
      };
      startTicker(ctx);
      return activeRun;
    };

    const resetUiState = (ctx: ExtensionContext) => {
      stopTicker();
      activeRun = undefined;
      clearWorkingMessage(ctx);
      ctx.ui.setStatus(STATUS_KEY, undefined);
    };

    const handleAgentStart = (_event: AgentStartEvent, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      stopTicker();
      activeRun = {
        startedAt: now(),
        intent: undefined,
        ticker: undefined,
        pausedAt: undefined,
        accumulatedPausedMs: 0,
      };
      ctx.ui.setStatus(STATUS_KEY, undefined);
      startTicker(ctx);
      renderWorkingMessage(ctx);
    };

    const handleToolStart = (event: ToolExecutionStartEvent, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      if (event.toolName === "ask") {
        pauseRun();
        return;
      }

      const run = ensureRun(ctx);
      const nextIntent = normalizeIntent(event.intent);
      if (nextIntent) run.intent = nextIntent;
      renderWorkingMessage(ctx);
    };

    const handleToolEnd = (event: ToolExecutionEndEvent, ctx: ExtensionContext) => {
      if (!ctx.hasUI || !activeRun) return;
      if (event.toolName === "ask") {
        resumeRun(ctx);
      }
      renderWorkingMessage(ctx);
    };

    const handleAgentEnd = (_event: AgentEndEvent, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      if (!activeRun) {
        clearWorkingMessage(ctx);
        return;
      }
      const totalDuration = formatElapsed(getElapsedMs());
      stopTicker();
      activeRun = undefined;
      clearWorkingMessage(ctx);
      ctx.ui.setStatus(STATUS_KEY, `${ELAPSED_ICON}${LAST_RUN_SPACER}Last run · ${totalDuration}`);
    };

    const handleSessionReset = (_event: SessionStartEvent | SessionSwitchEvent, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      resetUiState(ctx);
    };

    pi.on("agent_start", handleAgentStart);
    pi.on("tool_execution_start", handleToolStart);
    pi.on("tool_execution_end", handleToolEnd);
    pi.on("agent_end", handleAgentEnd);
    pi.on("session_start", handleSessionReset);
    pi.on("session_switch", handleSessionReset);
  };
}

export default function runTimerExtension(pi: ExtensionAPI, options: RunTimerOptions = {}): void {
  createRunTimerExtension(options)(pi);
}
