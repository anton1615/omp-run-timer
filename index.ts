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

const STATUS_KEY = "run-timer";
const DEFAULT_WORKING_LABEL = "Working…";
const ELAPSED_ICON = "⏱";
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
}

export function formatElapsed(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function normalizeIntent(intent: unknown): string | undefined {
  if (typeof intent !== "string") return undefined;
  const trimmed = intent.trim();
  return trimmed ? trimmed : undefined;
}

function buildWorkingMessage(intent: string | undefined, elapsedMs: number): string {
  const label = intent ?? DEFAULT_WORKING_LABEL;
  return `${label} · ${ELAPSED_ICON} ${formatElapsed(elapsedMs)} ${INTERRUPT_SUFFIX}`;
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

    const getElapsedMs = () => (activeRun ? now() - activeRun.startedAt : 0);

    const stopTicker = () => {
      if (!activeRun?.ticker) return;
      clearTicker(activeRun.ticker);
      activeRun.ticker = undefined;
    };

    const renderWorkingMessage = (ctx: ExtensionContext) => {
      if (!activeRun) return;
      ctx.ui.setWorkingMessage(buildWorkingMessage(activeRun.intent, getElapsedMs()));
    };

    const startTicker = (ctx: ExtensionContext) => {
      if (!activeRun || tickMs <= 0) return;
      stopTicker();
      activeRun.ticker = setTicker(() => {
        if (!activeRun) return;
        ctx.ui.setWorkingMessage(buildWorkingMessage(activeRun.intent, getElapsedMs()));
      }, tickMs);
    };

    const ensureRun = (ctx: ExtensionContext) => {
      if (activeRun) return activeRun;
      activeRun = {
        startedAt: now(),
        intent: undefined,
        ticker: undefined,
      };
      startTicker(ctx);
      return activeRun;
    };

    const resetUiState = (ctx: ExtensionContext) => {
      stopTicker();
      activeRun = undefined;
      ctx.ui.setWorkingMessage();
      ctx.ui.setStatus(STATUS_KEY, undefined);
    };

    const handleAgentStart = (_event: AgentStartEvent, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      stopTicker();
      activeRun = {
        startedAt: now(),
        intent: undefined,
        ticker: undefined,
      };
      ctx.ui.setStatus(STATUS_KEY, undefined);
      startTicker(ctx);
      renderWorkingMessage(ctx);
    };

    const handleToolStart = (event: ToolExecutionStartEvent, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      const run = ensureRun(ctx);
      run.intent = normalizeIntent(event.intent);
      renderWorkingMessage(ctx);
    };

    const handleToolEnd = (_event: ToolExecutionEndEvent, ctx: ExtensionContext) => {
      if (!ctx.hasUI || !activeRun) return;
      activeRun.intent = undefined;
      renderWorkingMessage(ctx);
    };

    const handleAgentEnd = (_event: AgentEndEvent, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      if (!activeRun) {
        ctx.ui.setWorkingMessage();
        return;
      }
      const totalDuration = formatElapsed(getElapsedMs());
      stopTicker();
      activeRun = undefined;
      ctx.ui.setWorkingMessage();
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `${ELAPSED_ICON} Last run · ${totalDuration}`));
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
