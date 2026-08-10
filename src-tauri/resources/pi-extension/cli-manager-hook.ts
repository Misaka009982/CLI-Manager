// __CLI_MANAGER_PI_HOOK__
// 由 CLI-Manager 管理。该扩展只桥接状态、心跳、最终错误与待用户决策；
// 桌宠生命周期由 CLI-Manager 管理，本扩展不注册任何桌宠控制命令。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const HEARTBEAT_INTERVAL_MS = 20_000;
const DECISION_POLL_INTERVAL_MS = 750;
const DECISION_UNAVAILABLE_GRACE_MS = 2_500;
const REQUEST_TIMEOUT_MS = 2_000;

type NotifyEvent = "SessionStart" | "UserPromptSubmit" | "Stop" | "StopFailure";
type DecisionKind = "question" | "questionnaire" | "permission";

interface DecisionOption {
  value: string;
  label: string;
  description?: string;
}

interface DecisionQuestion {
  id: string;
  label: string;
  prompt: string;
  allowOther: boolean;
  options: DecisionOption[];
}

interface DecisionAnswerItem {
  questionId: string;
  value: string;
  wasCustom: boolean;
}

interface QuestionDetails {
  question: string;
  options: string[];
  answer: string | null;
  wasCustom?: boolean;
}

interface QuestionnaireResult {
  questions: Array<{
    id: string;
    label?: string;
    prompt: string;
    options: Array<{ value: string; label: string; description?: string }>;
    allowOther?: boolean;
  }>;
  answers: Array<{ id: string; value: string; label: string; wasCustom: boolean; index?: number }>;
  cancelled: boolean;
}

interface DecisionAnswer {
  answers: DecisionAnswerItem[];
}

interface BridgeTarget {
  tabId: string;
  port: string;
  token: string;
}

interface OpenedDecisionPayload {
  requestId: string;
  brokerEpoch: string;
  sourceInstanceId: string;
  tabId: string;
  sessionId: string;
  kind: DecisionKind;
  title: string;
  message: string | null;
  questions: DecisionQuestion[];
  createdAt: number;
}

interface BridgeResponse {
  status: string;
  brokerEpoch?: string;
  answer?: DecisionAnswer;
  payload?: OpenedDecisionPayload;
}

interface LastFailure {
  message: string;
}

const sourceInstanceId = crypto.randomUUID();
let activeSessionId: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastFailure: LastFailure | null = null;
let lastEventTimestampMs = 0;

const QuestionOptionSchema = Type.Object({
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionParams = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  options: Type.Array(QuestionOptionSchema, { description: "Options for the user to choose from" }),
});

const QuestionnaireOptionSchema = Type.Object({
  value: Type.String({ description: "The value returned when selected" }),
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionnaireQuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  label: Type.Optional(Type.String({ description: "Short contextual label" })),
  prompt: Type.String({ description: "The full question text to display" }),
  options: Type.Array(QuestionnaireOptionSchema, { description: "Available options" }),
  allowOther: Type.Optional(Type.Boolean({ description: "Allow a custom answer" })),
});

const QuestionnaireParams = Type.Object({
  questions: Type.Array(QuestionnaireQuestionSchema, { description: "Questions to ask the user" }),
});

function nonEmpty(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function nextEventTimestampMs(): number {
  lastEventTimestampMs = Math.max(Date.now(), lastEventTimestampMs + 1);
  return lastEventTimestampMs;
}

function bridgeTarget(): BridgeTarget | null {
  const tabId = nonEmpty(process.env.CLI_MANAGER_TAB_ID);
  const port = nonEmpty(process.env.CLI_MANAGER_NOTIFY_PORT);
  const token = nonEmpty(process.env.CLI_MANAGER_NOTIFY_TOKEN);
  return tabId && port && token ? { tabId, port, token } : null;
}

function readSessionId(ctx: ExtensionContext): string | null {
  try {
    return nonEmpty(ctx.sessionManager.getSessionId());
  } catch {
    return null;
  }
}

function titleFor(event: NotifyEvent): string {
  switch (event) {
    case "SessionStart": return "Pi Agent session started";
    case "UserPromptSubmit": return "Pi Agent running";
    case "Stop": return "Pi Agent done";
    case "StopFailure": return "Pi Agent interrupted";
  }
}

async function postJson(
  path: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<BridgeResponse | null> {
  const target = bridgeTarget();
  if (!target || signal?.aborted) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });
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
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function postHookEvent(
  event: NotifyEvent,
  sessionId: string | null,
  message?: string | null,
  heartbeat = false,
): Promise<void> {
  const target = bridgeTarget();
  if (!target) return;
  await postJson("/api/claude-hook", {
    tabId: target.tabId,
    source: "pi",
    event,
    title: titleFor(event),
    message: message ?? null,
    sessionId,
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

function startHeartbeat(sessionId: string | null): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    void postHookEvent("UserPromptSubmit", sessionId, null, true);
  }, HEARTBEAT_INTERVAL_MS);
}

function abortError(): Error {
  const error = new Error("Pi decision bridge cancelled");
  error.name = "AbortError";
  return error;
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? abortError());
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const handleAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? abortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

async function requestDesktopDecision(
  kind: DecisionKind,
  title: string,
  message: string | null,
  questions: DecisionQuestion[],
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<DecisionAnswer | null> {
  const target = bridgeTarget();
  if (!target) return null;
  const requestId = crypto.randomUUID();
  const openedAt = nextEventTimestampMs();
  const sessionId = readSessionId(ctx);
  if (!sessionId) return null;
  let response = await postJson("/api/pi-decision/open", {
    requestId,
    sourceInstanceId,
    tabId: target.tabId,
    sessionId,
    kind,
    title,
    message,
    questions,
    createdAt: openedAt,
  });
  if (response?.status !== "pending" || !response.brokerEpoch) {
    if (signal?.aborted) throw signal.reason ?? abortError();
    return null;
  }

  const brokerEpoch = response.brokerEpoch;
  const openedPayload = response.payload;
  if (
    !openedPayload
    || openedPayload.requestId !== requestId
    || openedPayload.brokerEpoch !== brokerEpoch
    || openedPayload.sourceInstanceId !== sourceInstanceId
    || openedPayload.tabId !== target.tabId
    || openedPayload.sessionId !== sessionId
    || openedPayload.kind !== kind
  ) {
    await postJson("/api/pi-decision/cancel", { requestId, brokerEpoch });
    if (signal?.aborted) throw signal.reason ?? abortError();
    return null;
  }
  let unavailableSince: number | null = null;
  let acknowledged = false;
  try {
    if (signal?.aborted) throw signal.reason ?? abortError();
    while (!signal?.aborted) {
      await sleep(DECISION_POLL_INTERVAL_MS, signal);
      response = await postJson("/api/pi-decision/poll", { requestId, brokerEpoch }, signal);
      if (signal?.aborted) throw signal.reason ?? abortError();
      if (response?.status === "resolved" && response.answer) {
        const acknowledgement = await postJson("/api/pi-decision/ack", { requestId, brokerEpoch });
        acknowledged = acknowledgement?.status === "accepted";
        if (signal?.aborted) throw signal.reason ?? abortError();
        return response.answer;
      }
      if (response?.status === "pending") {
        unavailableSince = null;
        continue;
      }
      unavailableSince ??= Date.now();
      if (Date.now() - unavailableSince >= DECISION_UNAVAILABLE_GRACE_MS) {
        ctx.ui.notify(
          "CLI-Manager decision bridge disconnected; returning to Pi's native prompt.",
          "warning",
        );
        return null;
      }
    }
    throw signal?.reason ?? abortError();
  } finally {
    if (!acknowledged) {
      await postJson("/api/pi-decision/cancel", { requestId, brokerEpoch });
    }
  }
}

function questionFallbackResult(
  question: string,
  options: string[],
  answer: string | null,
  wasCustom = false,
  selectedIndex?: number,
): { content: Array<{ type: "text"; text: string }>; details: QuestionDetails } {
  const details: QuestionDetails = { question, options, answer };
  if (answer !== null) details.wasCustom = wasCustom;
  return {
    content: [{
      type: "text" as const,
      text: answer === null
        ? "User cancelled the selection"
        : wasCustom
          ? `User wrote: ${answer}`
          : `User selected: ${selectedIndex ?? Math.max(1, options.indexOf(answer) + 1)}. ${answer}`,
    }],
    details,
  };
}

function questionErrorResult(
  question: string,
  options: string[],
  message: string,
): { content: Array<{ type: "text"; text: string }>; details: QuestionDetails } {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { question, options, answer: null },
  };
}

async function nativeQuestion(
  question: string,
  options: Array<{ label: string; description?: string }>,
  ctx: ExtensionContext,
) {
  const optionLabels = options.map((item) => item.label);
  if (ctx.mode !== "tui") {
    return questionErrorResult(
      question,
      optionLabels,
      "Error: UI not available (running in non-interactive mode)",
    );
  }
  const numberedOptions = optionLabels.map((label, index) => `${index + 1}. ${label}`);
  const labels = [...numberedOptions, "Type something."];
  const selected = await ctx.ui.select(question, labels);
  if (!selected) return questionFallbackResult(question, optionLabels, null);
  if (selected === "Type something.") {
    const custom = nonEmpty(await ctx.ui.input(question, "Your answer"));
    return custom
      ? questionFallbackResult(question, optionLabels, custom, true)
      : questionFallbackResult(question, optionLabels, null);
  }
  const selectedIndex = numberedOptions.indexOf(selected);
  return selectedIndex >= 0
    ? questionFallbackResult(
        question,
        optionLabels,
        optionLabels[selectedIndex],
        false,
        selectedIndex + 1,
      )
    : questionFallbackResult(question, optionLabels, null);
}

function registerQuestionBridge(pi: ExtensionAPI): void {
  pi.registerTool<typeof QuestionParams, QuestionDetails>({
    name: "question",
    label: "Question",
    description: "Ask the user a question and let them pick from options.",
    parameters: QuestionParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.options.length === 0) {
        return questionErrorResult(params.question, [], "Error: No options provided");
      }
      const options = params.options.map((option) => ({
        value: option.label,
        label: option.label,
        description: option.description,
      }));
      const answer = await requestDesktopDecision("question", "Pi question", params.question, [{
        id: "question",
        label: "",
        prompt: params.question,
        allowOther: true,
        options,
      }], ctx, signal);
      const selected = answer?.answers[0];
      if (!selected) return nativeQuestion(params.question, params.options, ctx);
      return questionFallbackResult(
        params.question,
        params.options.map((item) => item.label),
        selected.value,
        selected.wasCustom,
      );
    },
  });
}

async function nativeQuestionnaire(
  questions: Array<{
    id: string;
    label?: string;
    prompt: string;
    options: Array<{ value: string; label: string; description?: string }>;
    allowOther?: boolean;
  }>,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: QuestionnaireResult }> {
  const answers: Array<{
    id: string;
    value: string;
    label: string;
    wasCustom: boolean;
    index?: number;
  }> = [];
  if (ctx.mode !== "tui") {
    return {
      content: [{ type: "text" as const, text: "Error: UI not available (running in non-interactive mode)" }],
      details: { questions: [], answers: [], cancelled: true },
    };
  }
  for (const question of questions) {
    const optionLabels = question.options.map((option, index) => (
      `${index + 1}. ${option.label}`
    ));
    const labels = [...optionLabels];
    if (question.allowOther !== false) labels.push("Type something.");
    const selected = await ctx.ui.select(question.prompt, labels);
    if (!selected) {
      return {
        content: [{ type: "text" as const, text: "User cancelled the questionnaire" }],
        details: { questions, answers, cancelled: true },
      };
    }
    if (selected === "Type something.") {
      const custom = nonEmpty(await ctx.ui.input(question.prompt, "Your answer"));
      if (!custom) {
        return {
          content: [{ type: "text" as const, text: "User cancelled the questionnaire" }],
          details: { questions, answers, cancelled: true },
        };
      }
      answers.push({ id: question.id, value: custom, label: custom, wasCustom: true });
    } else {
      const index = optionLabels.indexOf(selected);
      const option = question.options[index];
      if (!option) {
        return {
          content: [{ type: "text" as const, text: "User cancelled the questionnaire" }],
          details: { questions, answers, cancelled: true },
        };
      }
      answers.push({
        id: question.id,
        value: option.value,
        label: option.label,
        wasCustom: false,
        index: index + 1,
      });
    }
  }
  return {
    content: [{
      type: "text" as const,
      text: answers.map((item) => {
        const label = questions.find((question) => question.id === item.id)?.label || item.id;
        return item.wasCustom
          ? `${label}: user wrote: ${item.label}`
          : `${label}: user selected: ${item.index}. ${item.label}`;
      }).join("\n"),
    }],
    details: { questions, answers, cancelled: false },
  };
}

async function requestPermissionDecision(
  event: { toolCallId: string; toolName: string; input: Record<string, unknown> },
  ctx: ExtensionContext,
): Promise<{ block?: boolean; reason?: string } | undefined> {
  if (event.toolName !== "cli_manager_permission") return undefined;
  const input = event.input && typeof event.input === "object"
    ? event.input as { title?: unknown; message?: unknown }
    : {};
  const title = typeof input.title === "string" && input.title.trim()
    ? input.title.trim()
    : "Pi permission";
  const message = typeof input.message === "string" && input.message.trim()
    ? input.message.trim()
    : "Allow this operation?";
  const answer = await requestDesktopDecision("permission", title, message, [{
    id: "permission",
    label: "Permission",
    prompt: message,
    allowOther: false,
    options: [
      { value: "allow", label: "Allow" },
      { value: "deny", label: "Deny" },
    ],
  }], ctx, ctx.signal);
  if (!answer) {
    if (!ctx.hasUI) return { block: true, reason: "Permission unresolved: interactive UI unavailable" };
    const selected = await ctx.ui.select(message, ["Allow", "Deny"]);
    if (!selected) {
      // Cancellation remains unresolved: do not convert it into an automatic deny decision.
      ctx.ui.notify("Permission remains unresolved; request it again when ready.", "warning");
      return { block: true, reason: "Permission unresolved: user cancelled the prompt" };
    }
    return selected === "Allow"
      ? undefined
      : { block: true, reason: "Permission denied by user" };
  }
  return answer.answers[0]?.value === "allow"
    ? undefined
    : { block: true, reason: "Permission denied by user" };
}

function registerQuestionnaireBridge(pi: ExtensionAPI): void {
  pi.registerTool<typeof QuestionnaireParams, QuestionnaireResult>({
    name: "questionnaire",
    label: "Questionnaire",
    description: "Ask the user one or more questions.",
    parameters: QuestionnaireParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
      const answer = await requestDesktopDecision(
        "questionnaire",
        "Pi questionnaire",
        questions.map((question) => question.prompt).join("\n\n"),
        questions,
        ctx,
        signal,
      );
      if (!answer) return nativeQuestionnaire(questions, ctx);
      const answers = answer.answers.map((item) => {
        const question = questions.find((candidate) => candidate.id === item.questionId);
        if (!question) return null;
        const index = question.options.findIndex((candidate) => candidate.value === item.value);
        const option = index >= 0 ? question.options[index] : null;
        if (!item.wasCustom && !option) return null;
        return {
          id: item.questionId,
          value: item.value,
          label: option?.label ?? item.value,
          wasCustom: item.wasCustom,
          ...(item.wasCustom ? {} : { index: index + 1 }),
        };
      });
      if (answers.some((item) => item === null)) {
        return nativeQuestionnaire(questions, ctx);
      }
      const resolvedAnswers = answers.filter((item): item is NonNullable<typeof item> => item !== null);
      return {
        content: [{
          type: "text" as const,
          text: resolvedAnswers.map((item) => {
            const label = questions.find((question) => question.id === item.id)?.label || item.id;
            return item.wasCustom
              ? `${label}: user wrote: ${item.label}`
              : `${label}: user selected: ${item.index}. ${item.label}`;
          }).join("\n"),
        }],
        details: { questions, answers: resolvedAnswers, cancelled: false },
      };
    },
  });
}

export default function cliManagerHook(pi: ExtensionAPI) {
  registerQuestionBridge(pi);
  registerQuestionnaireBridge(pi);

  pi.on("tool_call", requestPermissionDecision);

  pi.on("session_start", async (_event, ctx) => {
    activeSessionId = readSessionId(ctx);
    await postHookEvent("SessionStart", activeSessionId);
  });

  pi.on("agent_start", async (_event, ctx) => {
    activeSessionId = readSessionId(ctx);
    lastFailure = null;
    await postHookEvent("UserPromptSubmit", activeSessionId);
    startHeartbeat(activeSessionId);
  });

  pi.on("agent_end", async (event) => {
    const finalAssistant = [...event.messages].reverse().find((message) => (
      message.role === "assistant"
    ));
    lastFailure = finalAssistant?.role === "assistant"
      && (finalAssistant.stopReason === "error" || finalAssistant.stopReason === "aborted")
      ? {
          message: nonEmpty(finalAssistant.errorMessage)
            || `Pi stopped with ${finalAssistant.stopReason}`,
        }
      : null;
  });

  pi.on("agent_settled", async () => {
    stopHeartbeat();
    if (lastFailure) {
      await postHookEvent("StopFailure", activeSessionId, lastFailure.message);
    } else {
      await postHookEvent("Stop", activeSessionId);
    }
    lastFailure = null;
  });

  pi.on("session_shutdown", async () => {
    stopHeartbeat();
  });

  // 权限生产者必须显式调用名为 cli_manager_permission 的工具；本扩展只观察该名称，
  // 不注册可供模型直接调用的权限工具，也不拦截普通工具或安全命令。
}
