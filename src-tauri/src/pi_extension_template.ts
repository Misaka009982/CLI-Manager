// __PI_MARKER__
// CLI_MANAGER_PI_EXTENSION_VERSION:7
// 由 CLI-Manager 管理，请勿手动修改；如需恢复，请在 Hook 设置中重新安装。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// pi-tui 与 typebox 同在 Pi 扩展加载器的 alias / virtualModules 表里，可安全静态引入；
// 终端一侧的问题界面要自绘才能展示每个选项的说明，ctx.ui.select 只接受字符串数组。
import { Editor, Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const ENABLED = {
  sessionStart: __PI_SESSION_START__,
  running: __PI_RUNNING__,
  stop: __PI_STOP__,
};
const POLL_INTERVAL_MS = 750;
const UNAVAILABLE_GRACE_MS = 2_500;
const REQUEST_TIMEOUT_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 20_000;

type DecisionKind = "question" | "questionnaire" | "permission";
type NotifyEvent = "SessionStart" | "UserPromptSubmit" | "Notification" | "Stop" | "StopFailure";

interface DecisionQuestion {
  id: string;
  label: string;
  prompt: string;
  allowOther: boolean;
  options: Array<{ value: string; label: string; description?: string }>;
}

interface DecisionAnswer {
  answers: Array<{ questionId: string; value: string; wasCustom: boolean }>;
}

interface BridgeResponse {
  status: string;
  brokerEpoch?: string;
  payload?: Record<string, unknown>;
  answer?: DecisionAnswer;
}

// schema 里的说明文字直接决定模型会不会填写选项说明，必须与 Pi 原生 question /
// questionnaire 工具保持一致，否则模型只给光秃秃的 label，终端和宠物端都没有解释可展示。
const QuestionParams = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  options: Type.Array(
    Type.Object({
      label: Type.String({ description: "Display label for the option" }),
      description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
    }),
    { description: "Options for the user to choose from" },
  ),
});

const QuestionnaireParams = Type.Object({
  questions: Type.Array(
    Type.Object({
      id: Type.String({ description: "Unique identifier for this question" }),
      label: Type.Optional(Type.String({
        description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
      })),
      prompt: Type.String({ description: "The full question text to display" }),
      options: Type.Array(
        Type.Object({
          value: Type.String({ description: "The value returned when selected" }),
          label: Type.String({ description: "Display label for the option" }),
          description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
        }),
        { description: "Available options to choose from" },
      ),
      allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
    }),
    { description: "Questions to ask the user" },
  ),
});

const sourceInstanceId = crypto.randomUUID();
const pendingDecisions = new Map<string, string | null>();
let activeSessionId: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let failureMessage: string | null = null;
let lastEventTimestampMs = 0;

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nextEventTimestampMs(): number {
  const now = Date.now();
  lastEventTimestampMs = Math.max(now, lastEventTimestampMs + 1);
  return lastEventTimestampMs;
}

function bridgeTarget(): { tabId: string; port: string; token: string } | null {
  const tabId = nonEmpty(process.env.CLI_MANAGER_TAB_ID);
  const port = nonEmpty(process.env.CLI_MANAGER_NOTIFY_PORT);
  const token = nonEmpty(process.env.CLI_MANAGER_NOTIFY_TOKEN);
  return tabId && port && token ? { tabId, port, token } : null;
}

function sessionId(ctx: ExtensionContext): string | null {
  try {
    return nonEmpty(ctx.sessionManager.getSessionId());
  } catch {
    return null;
  }
}

async function postJson(path: string, payload: unknown, signal?: AbortSignal): Promise<BridgeResponse | null> {
  const target = bridgeTarget();
  if (!target || signal?.aborted) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(`http://127.0.0.1:${target.port}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) return { status: "unavailable" };
    if (response.status === 204) return { status: "accepted" };
    return await response.json() as BridgeResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function postHook(event: NotifyEvent, message: string | null = null, heartbeat = false): Promise<void> {
  const target = bridgeTarget();
  if (!target) return;
  await postJson("/api/claude-hook", {
    tabId: target.tabId,
    source: "pi",
    event,
    title: event === "SessionStart" ? "Pi Agent session started"
      : event === "UserPromptSubmit" ? "Pi Agent running"
        : event === "Notification" ? "Pi Agent waiting for a terminal answer"
          : event === "StopFailure" ? "Pi Agent interrupted" : "Pi Agent done",
    message,
    sessionId: activeSessionId,
    cwd: process.cwd(),
    timestamp: new Date(nextEventTimestampMs()).toISOString(),
    heartbeat,
    sourceInstanceId,
    remoteEventId: heartbeat ? null : crypto.randomUUID(),
  });
}

function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// 生命周期意义上的「心跳该不该开」，与实际计时器分离：镜像对话框会临时停掉计时器，
// 结束后靠这个标记判断要不要恢复，避免在 agent 已结束后重新点亮运行状态。
let heartbeatRunning = false;

function suspendHeartbeatForLifecycle(): void {
  heartbeatRunning = false;
  stopHeartbeat();
}

async function cancelPendingDecisions(): Promise<void> {
  const requests = [...pendingDecisions.entries()];
  pendingDecisions.clear();
  await Promise.all(requests.flatMap(([requestId, brokerEpoch]) => brokerEpoch ? [postJson(
    "/api/pi-decision/cancel",
    { requestId, brokerEpoch, sourceInstanceId },
  )] : []));
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatRunning = true;
  heartbeatTimer = setInterval(() => void postHook("UserPromptSubmit", null, true), HEARTBEAT_INTERVAL_MS);
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function requestDecision(
  kind: DecisionKind,
  title: string,
  message: string | null,
  questions: DecisionQuestion[],
  ctx: ExtensionContext,
  signal?: AbortSignal,
  // 宠物端确实立了待处理项时回调一次：镜像第三方对话框时靠它区分「宠物端已接管」
  // 与「桥接不可用」，后者才需要退回只发一条提醒。
  onOpened?: () => void,
): Promise<DecisionAnswer | null> {
  const target = bridgeTarget();
  const currentSessionId = sessionId(ctx);
  if (!target || !currentSessionId) return null;
  const requestId = crypto.randomUUID();
  pendingDecisions.set(requestId, null);
  let response = await postJson("/api/pi-decision/open", {
    requestId,
    sourceInstanceId,
    tabId: target.tabId,
    sessionId: currentSessionId,
    kind,
    title,
    message,
    questions,
    createdAt: Date.now(),
  }, signal);
  const epoch = response?.brokerEpoch;
  const payload = response?.payload;
  if (epoch) pendingDecisions.set(requestId, epoch);
  if (response?.status === "resolved" && response.answer) {
    pendingDecisions.delete(requestId);
    onOpened?.();
    return response.answer;
  }
  if (response?.status !== "pending") {
    pendingDecisions.delete(requestId);
    return null;
  }
  if (
    !epoch
    || !payload
    || payload.requestId !== requestId
    || payload.brokerEpoch !== epoch
    || payload.sourceInstanceId !== sourceInstanceId
    || payload.tabId !== target.tabId
    || payload.sessionId !== currentSessionId
    || payload.kind !== kind
  ) {
    pendingDecisions.delete(requestId);
    if (epoch) {
      await postJson("/api/pi-decision/cancel", {
        requestId,
        brokerEpoch: epoch,
        sourceInstanceId,
      });
    }
    return null;
  }

  let unavailableSince: number | null = null;
  let acknowledged = false;
  // 到这里 broker 已经接下请求，宠物端能看到待处理项。
  onOpened?.();
  try {
    while (!signal?.aborted) {
      await wait(POLL_INTERVAL_MS, signal);
      response = await postJson("/api/pi-decision/poll", {
        requestId,
        brokerEpoch: epoch,
        sourceInstanceId,
      }, signal);
      if (response?.status === "resolved" && response.answer) {
        const acknowledgement = await postJson("/api/pi-decision/ack", {
          requestId,
          brokerEpoch: epoch,
          sourceInstanceId,
        }, signal);
        if (acknowledgement?.status === "accepted") {
          acknowledged = true;
          return response.answer;
        }
        unavailableSince ??= Date.now();
      } else if (response?.status === "pending") {
        unavailableSince = null;
      } else {
        unavailableSince ??= Date.now();
      }
      if (unavailableSince !== null && Date.now() - unavailableSince >= UNAVAILABLE_GRACE_MS) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "CLI-Manager decision bridge disconnected; returning to Pi's native prompt.",
            "warning",
          );
        }
        return null;
      }
    }
    return null;
  } finally {
    pendingDecisions.delete(requestId);
    if (!acknowledged) {
      await postJson("/api/pi-decision/cancel", {
        requestId,
        brokerEpoch: epoch,
        sourceInstanceId,
      });
    }
  }
}

// 宠物端与 Pi 终端原生提示同时呈现并竞速：任一侧先给出结论就采用它，并 abort 另一侧。
// abort 会让 ctx.ui.select 自动收起原生对话框，也会让 requestDecision 的 finally 向 broker
// 发出 cancel，从而消除宠物端的待处理项——两侧不会同时留下悬挂的问题。
// 返回 null 的一侧表示「无结论」（桥接不可用、非 TUI 模式或已被对侧抢先），不参与胜出。
type SurfaceOutcome<N> =
  | { kind: "bridge"; value: DecisionAnswer }
  | { kind: "native"; value: N }
  | { kind: "none" };

async function raceDecisionSurfaces<N>(
  runBridge: (signal: AbortSignal) => Promise<DecisionAnswer | null>,
  runNative: (signal: AbortSignal) => Promise<N | null>,
  outerSignal?: AbortSignal,
): Promise<{ decision: DecisionAnswer | null; native: N | null }> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(outerSignal?.reason);
  if (outerSignal?.aborted) controller.abort(outerSignal.reason);
  else outerSignal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const outcome = await new Promise<SurfaceOutcome<N>>((resolve) => {
      let done = false;
      let outstanding = 2;
      const settle = (result: SurfaceOutcome<N>) => {
        if (done) return;
        done = true;
        // 抢先方胜出后立即中止另一侧：原生对话框自动收起，桥接请求在 finally 里
        // 向 broker 发 cancel，宠物端的待处理项随之消除。
        controller.abort();
        resolve(result);
      };
      const inconclusive = () => {
        outstanding -= 1;
        if (outstanding <= 0) settle({ kind: "none" });
      };
      void runBridge(controller.signal).then(
        (value) => value ? settle({ kind: "bridge", value }) : inconclusive(),
        inconclusive,
      );
      void runNative(controller.signal).then(
        (value) => value !== null ? settle({ kind: "native", value }) : inconclusive(),
        inconclusive,
      );
    });
    return {
      decision: outcome.kind === "bridge" ? outcome.value : null,
      native: outcome.kind === "native" ? outcome.value : null,
    };
  } finally {
    controller.abort();
    outerSignal?.removeEventListener("abort", forwardAbort);
  }
}

// 终端一侧的问题界面：ctx.ui.select 只接受字符串数组，无法展示每个选项的说明（推荐理由、
// 取舍等），所以自绘一个组件，与 Pi 原生 question / questionnaire 扩展的呈现保持一致：
// 选项带编号，说明另起一行缩进成灰字；多问题时顶部有 Tab 条与 Submit 页；
// “Type something.” 走内嵌编辑器，不再弹第二个对话框。
interface SurfaceOption {
  value: string;
  label: string;
  description?: string;
}

interface SurfaceQuestion {
  id: string;
  label: string;
  prompt: string;
  allowOther: boolean;
  options: SurfaceOption[];
}

interface SurfaceAnswer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

interface SurfaceResult {
  answers: SurfaceAnswer[];
  cancelled: boolean;
}

const SURFACE_OTHER_LABEL = "Type something.";

async function showQuestionSurface(
  questions: SurfaceQuestion[],
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<SurfaceResult> {
  const cancelledResult: SurfaceResult = { answers: [], cancelled: true };
  if (ctx.mode !== "tui" || questions.length === 0 || signal?.aborted) return cancelledResult;
  // ctx.ui.custom 不接受 opts，官方 ui_prompt 事件里也拿不到 skipMirror 标记，
  // 只能靠 ownDialogs 计数告诉镜像逻辑「这是本扩展自己弹的，宠物端已有待处理项」。
  ownDialogs += 1;
  try {
    const result = await ctx.ui.custom<SurfaceResult>((tui, theme, _keybindings, done) => {
      const isMulti = questions.length > 1;
      const submitTab = questions.length;
      const answers = new Map<string, SurfaceAnswer>();
      let currentTab = 0;
      let optionIndex = 0;
      let editingId: string | null = null;
      let cachedLines: string[] | undefined;

      const editor = new Editor(tui, {
        borderColor: (text) => theme.fg("accent", text),
        selectList: {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      });

      const finish = (result: SurfaceResult): void => {
        signal?.removeEventListener("abort", onAbort);
        done(result);
      };

      // 命名函数：同一个引用才能在 finally / dispose 里成对取消监听。
      function onAbort(): void {
        finish(cancelledResult);
      }

      const refresh = () => {
        cachedLines = undefined;
        tui.requestRender();
      };

      const displayOptions = (question: SurfaceQuestion): Array<SurfaceOption & { isOther?: boolean }> =>
        question.allowOther
          ? [...question.options, { value: SURFACE_OTHER_LABEL, label: SURFACE_OTHER_LABEL, isOther: true }]
          : [...question.options];

      const complete = () => answers.size === questions.length;

      const advance = () => {
        if (!isMulti) {
          finish({ answers: [...answers.values()], cancelled: false });
          return;
        }
        currentTab = currentTab < questions.length - 1 ? currentTab + 1 : submitTab;
        optionIndex = 0;
        refresh();
      };

      editor.onSubmit = (value) => {
        if (!editingId) return;
        const trimmed = value.trim();
        const questionId = editingId;
        // 空输入退回选项列表，不记下一个空答案。
        editingId = null;
        editor.setText("");
        if (!trimmed) {
          refresh();
          return;
        }
        answers.set(questionId, { id: questionId, value: trimmed, label: trimmed, wasCustom: true });
        advance();
      };

      const handleInput = (data: string) => {
        if (editingId) {
          if (matchesKey(data, Key.escape)) {
            editingId = null;
            editor.setText("");
            refresh();
            return;
          }
          editor.handleInput(data);
          refresh();
          return;
        }
        if (isMulti) {
          if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
            currentTab = (currentTab + 1) % (submitTab + 1);
            optionIndex = 0;
            refresh();
            return;
          }
          if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
            currentTab = (currentTab - 1 + submitTab + 1) % (submitTab + 1);
            optionIndex = 0;
            refresh();
            return;
          }
        }
        if (matchesKey(data, Key.escape)) {
          finish(cancelledResult);
          return;
        }
        const question = questions[currentTab];
        if (!question) {
          if (matchesKey(data, Key.enter) && complete()) {
            finish({ answers: [...answers.values()], cancelled: false });
          }
          return;
        }
        const options = displayOptions(question);
        if (matchesKey(data, Key.up)) {
          optionIndex = Math.max(0, optionIndex - 1);
          refresh();
          return;
        }
        if (matchesKey(data, Key.down)) {
          optionIndex = Math.min(options.length - 1, optionIndex + 1);
          refresh();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          const option = options[optionIndex];
          if (!option) return;
          if (option.isOther) {
            editingId = question.id;
            editor.setText("");
            refresh();
            return;
          }
          answers.set(question.id, {
            id: question.id,
            value: option.value,
            label: option.label,
            wasCustom: false,
            index: optionIndex + 1,
          });
          advance();
        }
      };

      const render = (width: number): string[] => {
        if (cachedLines) return cachedLines;
        const lines: string[] = [];
        const renderWidth = Math.max(1, width);
        const push = (prefix: string, text: string) => {
          const prefixWidth = visibleWidth(prefix);
          if (prefixWidth >= renderWidth) {
            lines.push(...wrapTextWithAnsi(prefix + text, renderWidth));
            return;
          }
          const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
          const indent = " ".repeat(prefixWidth);
          wrapped.forEach((line, index) => lines.push(`${index === 0 ? prefix : indent}${line}`));
        };

        lines.push(theme.fg("accent", "\u2500".repeat(renderWidth)));
        if (isMulti) {
          const tabs = questions.map((question, index) => {
            const answered = answers.has(question.id);
            const text = ` ${answered ? "\u25a0" : "\u25a1"} ${question.label} `;
            return index === currentTab
              ? theme.bg("selectedBg", theme.fg("text", text))
              : theme.fg(answered ? "success" : "muted", text);
          });
          const submitText = " \u2713 Submit ";
          tabs.push(
            currentTab === submitTab
              ? theme.bg("selectedBg", theme.fg("text", submitText))
              : theme.fg(complete() ? "success" : "dim", submitText),
          );
          push(" ", `\u2190 ${tabs.join(" ")} \u2192`);
          lines.push("");
        }

        const question = questions[currentTab];
        if (!question) {
          push(" ", theme.fg("accent", theme.bold("Ready to submit")));
          lines.push("");
          for (const item of questions) {
            const answer = answers.get(item.id);
            if (!answer) continue;
            const value = `${answer.wasCustom ? "(wrote) " : ""}${answer.label}`;
            push(" ", `${theme.fg("muted", `${item.label}: `)}${theme.fg("text", value)}`);
          }
          lines.push("");
          if (complete()) {
            push(" ", theme.fg("success", "Press Enter to submit"));
          } else {
            const missing = questions
              .filter((item) => !answers.has(item.id))
              .map((item) => item.label)
              .join(", ");
            push(" ", theme.fg("warning", `Unanswered: ${missing}`));
          }
        } else {
          push(" ", theme.fg("text", question.prompt));
          lines.push("");
          const options = displayOptions(question);
          options.forEach((option, index) => {
            const selected = index === optionIndex;
            const editing = option.isOther === true && editingId === question.id;
            const prefix = selected ? theme.fg("accent", "> ") : "  ";
            const color = selected || editing ? "accent" : "text";
            push(prefix, theme.fg(color, `${index + 1}. ${option.label}${editing ? " \u270e" : ""}`));
            // 选项说明单独一行缩进展示，这是 ctx.ui.select 做不到的部分。
            if (option.description) push("     ", theme.fg("muted", option.description));
          });
          if (editingId === question.id) {
            lines.push("");
            push(" ", theme.fg("muted", "Your answer:"));
            for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
          }
        }

        lines.push("");
        push(
          " ",
          theme.fg(
            "dim",
            editingId
              ? "Enter to submit \u2022 Esc to go back"
              : isMulti
              ? "Tab/\u2190\u2192 navigate \u2022 \u2191\u2193 select \u2022 Enter confirm \u2022 Esc cancel"
              : "\u2191\u2193 navigate \u2022 Enter select \u2022 Esc cancel",
          ),
        );
        lines.push(theme.fg("accent", "\u2500".repeat(renderWidth)));

        cachedLines = lines;
        return lines;
      };

      // 竞速中被宠物端抢先时靠 abort 收起自绘面板（ctx.ui.select 内置了这一步，custom 没有）。
      if (signal) {
        if (signal.aborted) queueMicrotask(onAbort);
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      return {
        render,
        invalidate: () => {
          cachedLines = undefined;
        },
        handleInput,
        dispose: () => signal?.removeEventListener("abort", onAbort),
      };
    });
    return result ?? cancelledResult;
  } finally {
    ownDialogs = Math.max(0, ownDialogs - 1);
  }
}

async function nativeQuestion(
  prompt: string,
  options: Array<{ label: string; description?: string }>,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ answer: string | null; wasCustom: boolean; index?: number; error?: string }> {
  if (ctx.mode !== "tui") {
    return {
      answer: null,
      wasCustom: false,
      error: "Error: UI not available (running in non-interactive mode)",
    };
  }
  const result = await showQuestionSurface([{
    id: "question",
    label: "Q1",
    prompt,
    allowOther: true,
    // question 工具把 label 当作返回值，这里保持一致。
    options: options.map((option) => ({
      value: option.label,
      label: option.label,
      description: option.description,
    })),
  }], ctx, signal);
  const answer = result.cancelled ? undefined : result.answers[0];
  if (!answer) return { answer: null, wasCustom: false };
  return answer.wasCustom
    ? { answer: answer.value, wasCustom: true }
    : { answer: answer.value, wasCustom: false, index: answer.index };
}

function questionResult(
  prompt: string,
  options: string[],
  answer: string | null,
  wasCustom: boolean,
  index?: number,
) {
  return {
    content: [{
      type: "text" as const,
      text: answer === null ? "User cancelled the selection"
        : wasCustom ? `User wrote: ${answer}` : `User selected: ${index}. ${answer}`,
    }],
    details: { question: prompt, options, answer, ...(answer === null ? {} : { wasCustom }) },
  };
}

function questionErrorResult(prompt: string, options: string[], message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { question: prompt, options, answer: null },
  };
}

function registerQuestion(pi: ExtensionAPI): void {
  pi.registerTool<typeof QuestionParams, { question: string; options: string[]; answer: string | null }>({
    name: "question",
    label: "Question",
    description: "Ask the user a question and let them pick from options.",
    parameters: QuestionParams,
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      if (params.options.length === 0) {
        return questionErrorResult(params.question, [], "Error: No options provided");
      }
      const labels = params.options.map((option) => option.label);
      const options = params.options.map((option) => ({
        value: option.label,
        label: option.label,
        description: option.description,
      }));
      const { decision, native } = await raceDecisionSurfaces(
        async (raceSignal) => {
          const answer = await requestDecision("question", "Pi question", params.question, [{
            id: "question",
            label: "",
            prompt: params.question,
            allowOther: true,
            options,
          }], ctx, raceSignal);
          // 答案不可用时按「无结论」处理，让终端一侧继续等待，而不是抢先后再弹一次。
          const selected = answer?.answers[0];
          if (!selected) return null;
          return selected.wasCustom || labels.includes(selected.value) ? answer : null;
        },
        async (raceSignal) => {
          // 非交互模式下原生侧无能力作答，不能拿能力缺失抢先宠物端的真实答案。
          if (ctx.mode !== "tui") return null;
          const result = await nativeQuestion(params.question, params.options, ctx, raceSignal);
          // 被宠物端抢先时 select 也返回 undefined，靠 aborted 区分「被取代」（不参与胜出）
          // 与「用户按 ESC」（明确取消，answer 为 null，走取消结果）。
          return raceSignal.aborted ? null : result;
        },
        signal,
      );
      const selected = decision?.answers[0];
      if (selected) {
        const selectedIndex = labels.indexOf(selected.value);
        if (selected.wasCustom || selectedIndex >= 0) {
          return questionResult(
            params.question,
            labels,
            selected.value,
            selected.wasCustom,
            selected.wasCustom ? undefined : selectedIndex + 1,
          );
        }
      }
      if (native) {
        return questionResult(params.question, labels, native.answer, native.wasCustom, native.index);
      }
      // 两侧都没结论：通常是非交互模式或桥接不可用，回退到单纯的原生提示。
      const fallback = await nativeQuestion(params.question, params.options, ctx, signal);
      if (fallback.error) {
        return questionErrorResult(params.question, labels, fallback.error);
      }
      return questionResult(
        params.question,
        labels,
        fallback.answer,
        fallback.wasCustom,
        fallback.index,
      );
    },
  });
}

async function nativeQuestionnaire(
  questions: DecisionQuestion[],
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
  if (ctx.mode !== "tui") {
    return {
      content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
      details: { questions, answers: [], cancelled: true },
    };
  }
  const result = await showQuestionSurface(
    questions.map((question) => ({
      id: question.id,
      label: nonEmpty(question.label) ?? question.id,
      prompt: question.prompt,
      allowOther: question.allowOther,
      options: question.options,
    })),
    ctx,
    signal,
  );
  // 自绘面板只在全部问题已答时才交，这里再校一次，避开未来改动造成的部分提交。
  if (result.cancelled || result.answers.length !== questions.length) {
    return {
      content: [{ type: "text", text: "User cancelled the questionnaire" }],
      details: { questions, answers: result.answers, cancelled: true },
    };
  }
  const answers = result.answers;
  return {
    content: [{
      type: "text",
      text: answers.map((answer) => {
        const label = questions.find((question) => question.id === answer.id)?.label || answer.id;
        return answer.wasCustom
          ? `${label}: user wrote: ${answer.label}`
          : `${label}: user selected: ${answer.index}. ${answer.label}`;
      }).join("\n"),
    }],
    details: { questions, answers, cancelled: false },
  };
}

function registerQuestionnaire(pi: ExtensionAPI): void {
  pi.registerTool<typeof QuestionnaireParams, unknown>({
    name: "questionnaire",
    label: "Questionnaire",
    description: "Ask the user one or more questions.",
    parameters: QuestionnaireParams,
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      if (params.questions.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Error: No questions provided" }],
          details: { questions: [], answers: [], cancelled: true },
        };
      }
      const questions = params.questions.map((question, index) => ({
        id: question.id,
        label: question.label || `Q${index + 1}`,
        prompt: question.prompt,
        allowOther: question.allowOther !== false,
        options: question.options,
      }));
      const { decision, native } = await raceDecisionSurfaces(
        (raceSignal) => requestDecision(
          "questionnaire",
          "Pi questionnaire",
          questions.map((question) => question.prompt).join("\n\n"),
          questions,
          ctx,
          raceSignal,
        ),
        async (raceSignal) => {
          if (ctx.mode !== "tui") return null;
          const result = await nativeQuestionnaire(questions, ctx, raceSignal);
          return raceSignal.aborted ? null : result;
        },
        signal,
      );
      if (!decision || decision.answers.length !== questions.length) {
        return native ?? nativeQuestionnaire(questions, ctx, signal);
      }
      const answers: Array<{
        id: string;
        value: string;
        label: string;
        wasCustom: boolean;
        index?: number;
      }> = [];
      const seen = new Set<string>();
      for (const answer of decision.answers) {
        if (seen.has(answer.questionId)) return nativeQuestionnaire(questions, ctx, signal);
        seen.add(answer.questionId);
        const question = questions.find((candidate) => candidate.id === answer.questionId);
        if (!question) return nativeQuestionnaire(questions, ctx, signal);
        if (answer.wasCustom) {
          if (!question.allowOther || !answer.value.trim()) return nativeQuestionnaire(questions, ctx, signal);
          answers.push({
            id: answer.questionId,
            value: answer.value,
            label: answer.value,
            wasCustom: true,
          });
          continue;
        }
        const index = question.options.findIndex((option) => option.value === answer.value);
        if (index < 0) return nativeQuestionnaire(questions, ctx, signal);
        answers.push({
          id: answer.questionId,
          value: answer.value,
          label: question.options[index].label,
          wasCustom: false,
          index: index + 1,
        });
      }
      if (answers.length !== questions.length) return nativeQuestionnaire(questions, ctx, signal);
      return {
        content: [{
          type: "text" as const,
          text: answers.map((answer) => {
            const label = questions.find((question) => question.id === answer.id)?.label || answer.id;
            return answer.wasCustom
              ? `${label}: user wrote: ${answer.label}`
              : `${label}: user selected: ${answer.index}. ${answer.label}`;
          }).join("\n"),
        }],
        details: { questions, answers, cancelled: false },
      };
    },
  });
}

async function permissionDecision(
  event: { toolName: string; input: Record<string, unknown> },
  ctx: ExtensionContext,
): Promise<{ block?: boolean; reason?: string } | undefined> {
  if (event.toolName !== "cli_manager_permission") return undefined;
  const title = nonEmpty(event.input?.title) || "Pi permission";
  const message = nonEmpty(event.input?.message) || "Allow this operation?";
  const { decision, native } = await raceDecisionSurfaces<string>(
    async (raceSignal) => {
      const answer = await requestDecision("permission", title, message, [{
        id: "permission",
        label: "Permission",
        prompt: message,
        allowOther: false,
        options: [
          { value: "allow", label: "Allow" },
          { value: "deny", label: "Deny" },
        ],
      }], ctx, raceSignal);
      // 只有明确的 allow/deny 才算胜出，其他情况让终端一侧继续等待。
      const value = answer?.answers[0]?.value;
      return value === "allow" || value === "deny" ? answer : null;
    },
    async (raceSignal) => {
      if (ctx.mode !== "tui") return null;
      const selected = await ctx.ui.select(message, ["Allow", "Deny"], skipMirror(raceSignal));
      // 被宠物端抢先时 select 也返回 undefined；用 aborted 区分「被取代」（不参与胜出）
      // 与「用户按 ESC」（明确取消，需要收起宠物端并按未决处理）。
      if (raceSignal.aborted) return null;
      return selected ?? "cancelled";
    },
    ctx.signal,
  );
  const answer = decision?.answers[0]?.value ?? (native === "Allow"
    ? "allow"
    : native === "Deny"
    ? "deny"
    : null);
  if (answer === "allow") return undefined;
  if (answer === "deny") return { block: true, reason: "Permission denied by user" };
  if (ctx.mode !== "tui") {
    return { block: true, reason: "Permission unresolved: interactive UI unavailable" };
  }
  ctx.ui.notify("Permission remains unresolved; request it again when ready.", "warning");
  return { block: true, reason: "Permission unresolved: user cancelled the prompt" };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function schemaProperty(parameters: unknown, name: string): Record<string, unknown> | null {
  const root = asRecord(parameters);
  const properties = asRecord(root?.properties);
  return asRecord(properties?.[name]);
}

function arrayItemSchema(schema: Record<string, unknown> | null): Record<string, unknown> | null {
  return asRecord(schema?.items);
}

function isQuestionToolCompatible(parameters: unknown): boolean {
  const question = schemaProperty(parameters, "question");
  const options = arrayItemSchema(schemaProperty(parameters, "options"));
  return !!question && !!options && !!asRecord(options.properties)?.label;
}

function isQuestionnaireToolCompatible(parameters: unknown): boolean {
  const questions = arrayItemSchema(schemaProperty(parameters, "questions"));
  const questionProperties = asRecord(questions?.properties);
  const options = arrayItemSchema(asRecord(questionProperties?.options));
  return !!questionProperties?.id
    && !!questionProperties?.prompt
    && !!options?.properties
    && !!asRecord(options.properties)?.label;
}

function loadDecisionBridges(pi: ExtensionAPI, loaded: Set<string>): void {
  const tools = pi.getAllTools();
  const questionTool = tools.find((tool) => tool.name === "question");
  if (questionTool && !loaded.has("question") && isQuestionToolCompatible(questionTool.parameters)) {
    try {
      registerQuestion(pi);
      loaded.add("question");
    } catch {
      // 同名工具无法安全替换时保留原生实现。
    }
  }
  const questionnaireTool = tools.find((tool) => tool.name === "questionnaire");
  if (
    questionnaireTool
    && !loaded.has("questionnaire")
    && isQuestionnaireToolCompatible(questionnaireTool.parameters)
  ) {
    try {
      registerQuestionnaire(pi);
      loaded.add("questionnaire");
    } catch {
      // 同名工具无法安全替换时保留原生实现。
    }
  }
}

// 第三方 Pi 扩展（permission-gate、dirty-repo-guard 等）直接调 ctx.ui.select/confirm/input，
// 这类对话框不经过 CLI-Manager 的决策桥接，宠物端无法代答。这里把它们镜像成一条宠物端通知，
// 让用户知道「终端里有对话框在等你」，而回答仍然只在终端内完成。
//
// ctx.ui 是 Pi 在 bindExtensions 时创建、由所有扩展共享的同一个对象（runner.uiContext），
// 因此改写它的方法即可覆盖其他扩展；Pi 自己的 project trust 提示用的是另一个对象，不受影响。
// 每次 session_start 都会重新绑定 uiContext，所以安装动作也放在 session_start 里并做幂等标记。
// Pi 0.84.4 起提供官方的 ui_prompt_start / ui_prompt_end 事件，覆盖 select/confirm/input/
// editor/custom 且嵌套对话框已被 Pi 合并成一个外层等待区间，是首选来源。老版本 Pi 没有这两个
// 事件，所以仍保留改写 ctx.ui 的兜底补丁；官方事件一旦到达就永久接管，补丁不再发通知。
type DialogKind = "select" | "confirm" | "input";
// 官方事件还会带 editor / custom，兜底补丁覆盖不到这两种。
type PromptKind = DialogKind | "editor" | "custom";

// 本扩展自己发起的对话框（question/questionnaire/permission 的原生一侧）已经在宠物端有
// 待处理项，靠 opts 上的这个标记跳过镜像，避免同一次询问出现两条记录。
// 结构与 Pi 的 ExtensionUIDialogOptions 兼容（signal 用于竞速时收起对话框），额外多带一个标记字段。
interface MirroredDialogOptions {
  signal?: AbortSignal;
  __cliManagerSkipMirror__?: true;
}

// 不加类型注解：const 推断为字面量类型，索引 MirroredDialogOptions 得到精确的 true | undefined；
// 字段一旦改名，下面的索引访问会直接编译报错，不会静默读到 undefined。
const DIALOG_MIRROR_SKIP = "__cliManagerSkipMirror__";
const DIALOG_MIRROR_INSTALLED = "__cliManagerDialogMirror__";

function skipMirror(signal?: AbortSignal): MirroredDialogOptions {
  return { signal, __cliManagerSkipMirror__: true };
}

function dialogNotice(kind: PromptKind, title: unknown): string {
  const oneLine = (nonEmpty(title) ?? "").replace(/\s+/g, " ").slice(0, 300);
  const verb = kind === "input" || kind === "editor" ? "needs text input" : "needs a choice";
  return oneLine ? `Pi ${verb}: ${oneLine}` : `Pi ${verb} in the terminal.`;
}

// 镜像期间挂起心跳：心跳每 20 秒发一次 UserPromptSubmit，会把「需要关注」刷回「运行中」，
// 让刚镜像出来的提示瞬间消失。对话框可以嵌套，所以用计数而不是布尔量。
let mirroredDialogs = 0;

function beginMirroredDialog(): void {
  mirroredDialogs += 1;
  if (mirroredDialogs === 1) stopHeartbeat();
}

function endMirroredDialog(): void {
  mirroredDialogs = Math.max(0, mirroredDialogs - 1);
  // 仅在 agent 仍在跑（心跳本来就该开着）时恢复，避免在 agent 已结束后重新点亮运行状态。
  if (mirroredDialogs === 0 && ENABLED.running && heartbeatRunning) startHeartbeat();
}

// 本扩展自己发起的对话框数量。官方事件里拿不到 opts 上的 skip 标记，只能靠这个计数
// 判断当前等待的对话框是不是自己弹的（自己弹的宠物端已有待处理项，不该再发提醒）。
let ownDialogs = 0;

// 第三方对话框的宠物端代答：把 select / confirm / input 的选项搬到宠物端，与终端竞速。
// 代答走的是 pendingAction 通道（受「宠物端问题交互」开关管），不再依赖通知气泡，
// 所以关掉「通知提醒」也能在宠物端看到并回答。无法搬过去的（editor / custom，
// 或选项不适配）仍然只镜像成一条提醒。
const DIALOG_AFFIRMATIVE_LABELS = new Set([
  "yes",
  "y",
  "allow",
  "approve",
  "continue",
  "proceed",
  "ok",
  "confirm",
]);

// 危险对话框特征：文本带警告标记，或命中常见的不可逆命令。命中时只把「放行」那一项
// 标红，不加二次确认：代答只是把终端已有的确认搬了个位置，不应自己又加一道关。
const DANGEROUS_DIALOG_PATTERNS = [
  /\u26a0/,
  /\brm\s+(-[a-z]*[rf]|--recursive|--force)/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b[^\n]*777/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+--force)/i,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
];

function looksDangerous(text: string): boolean {
  return DANGEROUS_DIALOG_PATTERNS.some((pattern) => pattern.test(text));
}

// 宠物端面板比终端窄，标题只取第一行；正文截断到下面这个上限（后端 prompt 硬限 16384 字符）。
const MAX_DIALOG_PROMPT_CHARS = 4_000;
// 后端 normalized_questions 对选项数量的硬限。
const MAX_DIALOG_OPTIONS = 64;

function dialogHeadline(text: string): string {
  const firstLine = text.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  return (firstLine ?? "Pi dialog").slice(0, 120);
}

interface DialogTakeover {
  question: DecisionQuestion;
  title: string;
  // 把宠物端答案还原成原生返回值；null 表示答案不合法，不算竞速胜出。
  toNative: (value: string, wasCustom: boolean) => { value: unknown } | null;
}

function planDialogTakeover(kind: DialogKind, args: unknown[]): DialogTakeover | null {
  const title = nonEmpty(args[0]) ?? "";
  if (kind === "input") {
    const placeholder = nonEmpty(args[1]);
    const prompt = [title || "Pi needs text input.", placeholder ? `(${placeholder})` : null]
      .filter((part) => part)
      .join("\n")
      .slice(0, MAX_DIALOG_PROMPT_CHARS);
    return {
      title: dialogHeadline(title || "Pi needs text input"),
      question: { id: "dialog", label: "", prompt, allowOther: true, options: [] },
      toNative: (value, wasCustom) => (wasCustom && value.trim() ? { value } : null),
    };
  }
  const message = kind === "confirm" ? nonEmpty(args[1]) : null;
  const prompt = [title, message].filter((part) => part).join("\n").slice(0, MAX_DIALOG_PROMPT_CHARS);
  const dangerous = looksDangerous(prompt);
  const labels = kind === "confirm"
    // Pi 的 confirm 内部就是 Yes / No 选择器，宠物端沿用同一组选项。
    ? ["Yes", "No"]
    : Array.isArray(args[1])
      ? args[1].filter((option): option is string => typeof option === "string" && option.trim().length > 0)
      : [];
  // select 必须拿到完整的选项数组，否则还原不出合法返回值。
  if (kind === "select" && (!Array.isArray(args[1]) || labels.length !== args[1].length)) return null;
  // 选项为空、超后端上限或 value 重复时不代答，避开宠物端出现无法作答的空面板。
  if (labels.length === 0 || labels.length > MAX_DIALOG_OPTIONS || new Set(labels).size !== labels.length) {
    return null;
  }
  const options = labels.map((label) => ({
    value: label,
    // label 后端限 160 字符，value 保留原串以保证返回值精确。
    label: label.length > 160 ? `${label.slice(0, 157)}...` : label,
    destructive: dangerous && DIALOG_AFFIRMATIVE_LABELS.has(label.trim().toLowerCase()),
  }));
  return {
    title: dialogHeadline(title || "Pi needs a choice"),
    question: { id: "dialog", label: "", prompt: prompt || "Pi needs a choice.", allowOther: false, options },
    toNative: (value, wasCustom) => {
      if (wasCustom || !labels.includes(value)) return null;
      return { value: kind === "confirm" ? value === "Yes" : value };
    },
  };
}

function installDialogMirror(ctx: ExtensionContext): void {
  if (!ENABLED.running || ctx.mode !== "tui") return;
  let ui: Record<string, unknown>;
  try {
    ui = ctx.ui as unknown as Record<string, unknown>;
  } catch {
    return;
  }
  if (!ui || ui[DIALOG_MIRROR_INSTALLED]) return;
  for (const kind of ["select", "confirm", "input"] as DialogKind[]) {
    const original = ui[kind];
    if (typeof original !== "function") continue;
    const forward = original as (...args: unknown[]) => unknown;
    ui[kind] = async function (this: unknown, ...args: unknown[]) {
      const opts = args[2] as MirroredDialogOptions | undefined;
      const own = opts?.[DIALOG_MIRROR_SKIP] === true;
      if (own) {
        // 本扩展自己的对话框（已在更外层竞速）：直接转发。
        ownDialogs += 1;
        try {
          return await forward.apply(this, args);
        } finally {
          ownDialogs = Math.max(0, ownDialogs - 1);
        }
      }
      const plan = planDialogTakeover(kind, args);
      // 代答期间也算「本扩展在管」：官方 ui_prompt 事件不要再发一条重复提醒。
      ownDialogs += 1;
      let petOpened = false;
      let mirrored = false;
      // 宠物端没接住（未启用、未运行、选项不适配）时退回只发一条提醒，
      // 并挂起心跳，否则 20 秒一次的 UserPromptSubmit 会把提示刷掉。
      const mirrorNotice = () => {
        if (petOpened || mirrored) return;
        mirrored = true;
        beginMirroredDialog();
        void postHook("Notification", dialogNotice(kind, args[0]));
      };
      try {
        if (!plan) {
          mirrorNotice();
          return await forward.apply(this, args);
        }
        let bridged: { value: unknown } | null = null;
        const { decision, native } = await raceDecisionSurfaces<{ value: unknown }>(
          async (raceSignal) => {
            const answer = await requestDecision(
              "question",
              plan.title,
              null,
              [plan.question],
              ctx,
              raceSignal,
              () => {
                petOpened = true;
              },
            );
            const picked = answer?.answers[0];
            // 桥接拿不到结论且不是被终端抢先，就是宠物端没接住，改发提醒。
            if (!picked) {
              if (!raceSignal.aborted) mirrorNotice();
              return null;
            }
            bridged = plan.toNative(picked.value, picked.wasCustom);
            return bridged ? answer : null;
          },
          async (raceSignal) => {
            // 把竞速 signal 并入调用方自己的 opts：宠物端先答时终端对话框会自动收起。
            const nativeArgs = [...args];
            nativeArgs[2] = { ...(opts ?? {}), signal: raceSignal };
            const value = await forward.apply(this, nativeArgs);
            // 被宠物端抢先时不参与胜出；否则包一层，让 undefined / false 也能算明确结论。
            return raceSignal.aborted ? null : { value };
          },
          opts?.signal,
        );
        if (decision && bridged) return bridged.value;
        if (native) return native.value;
        // 两侧都无结论（调用方自己 abort）：沿用原生取消语义。
        return kind === "confirm" ? false : undefined;
      } finally {
        if (mirrored) endMirroredDialog();
        ownDialogs = Math.max(0, ownDialogs - 1);
      }
    };
  }
  ui[DIALOG_MIRROR_INSTALLED] = true;
}

// 官方事件通道：只负责补丁覆盖不到的 editor / custom（select / confirm / input 已在包装层
// 把 ownDialogs 抬起来，这里会直接跳过）。Pi 已把嵌套对话框合并成一个外层区间，
// 所以用一个布尔量记住「这个区间是否已镜像」，结束时据此配平，而不是在结束时重新判断
// ownDialogs（那个计数可能已被别处的对话框改动，会导致心跳挂起后无法恢复）。
let officialSpanMirrored = false;

function registerPromptEvents(pi: ExtensionAPI): void {
  pi.on("ui_prompt_start", async (event) => {
    if (!ENABLED.running || ownDialogs > 0) return;
    officialSpanMirrored = true;
    beginMirroredDialog();
    void postHook("Notification", dialogNotice(event.kind, event.title));
  });
  pi.on("ui_prompt_end", async () => {
    if (!officialSpanMirrored) return;
    officialSpanMirrored = false;
    endMirroredDialog();
  });
}

export default function cliManagerHook(pi: ExtensionAPI) {
  const loadedDecisionBridges = new Set<string>();
  pi.on("tool_call", permissionDecision);
  // Pi 0.84.4+ 有这两个事件；老版本只是注册了永不触发的 handler，靠 installDialogMirror 兜底。
  registerPromptEvents(pi);

  pi.on("session_start", async (_event, ctx) => {
    suspendHeartbeatForLifecycle();
    await cancelPendingDecisions();
    loadDecisionBridges(pi, loadedDecisionBridges);
    // 会话/reload 边界上不可能有对话框还开着，顺手清掉计数，避免异常路径漏配平后长期失衡。
    mirroredDialogs = 0;
    ownDialogs = 0;
    officialSpanMirrored = false;
    installDialogMirror(ctx);
    activeSessionId = sessionId(ctx);
    if (ENABLED.sessionStart) void postHook("SessionStart");
  });

  pi.on("agent_start", async (_event, ctx) => {
    activeSessionId = sessionId(ctx);
    failureMessage = null;
    if (ENABLED.running) {
      void postHook("UserPromptSubmit");
      startHeartbeat();
    } else {
      suspendHeartbeatForLifecycle();
    }
  });

  pi.on("agent_end", async (event) => {
    const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
    failureMessage = assistant?.role === "assistant"
      && (assistant.stopReason === "error" || assistant.stopReason === "aborted")
      ? nonEmpty(assistant.errorMessage) || `Pi stopped with ${assistant.stopReason}`
      : null;
  });

  pi.on("agent_settled", async () => {
    suspendHeartbeatForLifecycle();
    if (ENABLED.stop) {
      void postHook(failureMessage ? "StopFailure" : "Stop", failureMessage);
    }
    failureMessage = null;
  });

  pi.on("session_shutdown", async () => {
    suspendHeartbeatForLifecycle();
    await cancelPendingDecisions();
    activeSessionId = null;
    failureMessage = null;
  });
}
