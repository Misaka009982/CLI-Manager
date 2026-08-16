// __PI_MARKER__
// 由 CLI-Manager 管理，请勿手动修改；如需恢复，请在 Hook 设置中重新安装。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
type NotifyEvent = "SessionStart" | "UserPromptSubmit" | "Stop" | "StopFailure";

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

const QuestionParams = Type.Object({
  question: Type.String(),
  options: Type.Array(Type.Object({
    label: Type.String(),
    description: Type.Optional(Type.String()),
  })),
});

const QuestionnaireParams = Type.Object({
  questions: Type.Array(Type.Object({
    id: Type.String(),
    label: Type.Optional(Type.String()),
    prompt: Type.String(),
    options: Type.Array(Type.Object({
      value: Type.String(),
      label: Type.String(),
      description: Type.Optional(Type.String()),
    })),
    allowOther: Type.Optional(Type.Boolean()),
  })),
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

async function nativeQuestion(
  prompt: string,
  options: Array<{ label: string; description?: string }>,
  ctx: ExtensionContext,
): Promise<{ answer: string | null; wasCustom: boolean; index?: number; error?: string }> {
  if (ctx.mode !== "tui") {
    return {
      answer: null,
      wasCustom: false,
      error: "Error: UI not available (running in non-interactive mode)",
    };
  }
  const numbered = options.map((option, index) => `${index + 1}. ${option.label}`);
  const selected = await ctx.ui.select(prompt, [...numbered, "Type something."]);
  if (!selected) return { answer: null, wasCustom: false };
  if (selected === "Type something.") {
    return { answer: nonEmpty(await ctx.ui.input(prompt, "Your answer")), wasCustom: true };
  }
  const index = numbered.indexOf(selected);
  return index >= 0
    ? { answer: options[index].label, wasCustom: false, index: index + 1 }
    : { answer: null, wasCustom: false };
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
      const options = params.options.map((option) => ({
        value: option.label,
        label: option.label,
        description: option.description,
      }));
      const decision = await requestDecision("question", "Pi question", params.question, [{
        id: "question",
        label: "",
        prompt: params.question,
        allowOther: true,
        options,
      }], ctx, signal);
      const selected = decision?.answers[0];
      if (selected) {
        const selectedIndex = params.options.findIndex((option) => option.label === selected.value);
        if (selected.wasCustom || selectedIndex >= 0) {
          return questionResult(
            params.question,
            params.options.map((option) => option.label),
            selected.value,
            selected.wasCustom,
            selected.wasCustom ? undefined : selectedIndex + 1,
          );
        }
      }
      const fallback = await nativeQuestion(params.question, params.options, ctx);
      if (fallback.error) {
        return questionErrorResult(
          params.question,
          params.options.map((option) => option.label),
          fallback.error,
        );
      }
      return questionResult(
        params.question,
        params.options.map((option) => option.label),
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
): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
  if (ctx.mode !== "tui") {
    return {
      content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
      details: { questions, answers: [], cancelled: true },
    };
  }
  const answers: Array<{ id: string; value: string; label: string; wasCustom: boolean; index?: number }> = [];
  for (const question of questions) {
    const numbered = question.options.map((option, index) => `${index + 1}. ${option.label}`);
    const choices = question.allowOther ? [...numbered, "Type something."] : numbered;
    const selected = await ctx.ui.select(question.prompt, choices);
    if (!selected) {
      return {
        content: [{ type: "text", text: "User cancelled the questionnaire" }],
        details: { questions, answers, cancelled: true },
      };
    }
    if (selected === "Type something.") {
      const custom = nonEmpty(await ctx.ui.input(question.prompt, "Your answer"));
      if (!custom) {
        return {
          content: [{ type: "text", text: "User cancelled the questionnaire" }],
          details: { questions, answers, cancelled: true },
        };
      }
      answers.push({ id: question.id, value: custom, label: custom, wasCustom: true });
      continue;
    }
    const index = numbered.indexOf(selected);
    const option = question.options[index];
    if (!option) {
      return {
        content: [{ type: "text", text: "User cancelled the questionnaire" }],
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
      const decision = await requestDecision(
        "questionnaire",
        "Pi questionnaire",
        questions.map((question) => question.prompt).join("\n\n"),
        questions,
        ctx,
        signal,
      );
      if (!decision || decision.answers.length !== questions.length) {
        return nativeQuestionnaire(questions, ctx);
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
        if (seen.has(answer.questionId)) return nativeQuestionnaire(questions, ctx);
        seen.add(answer.questionId);
        const question = questions.find((candidate) => candidate.id === answer.questionId);
        if (!question) return nativeQuestionnaire(questions, ctx);
        if (answer.wasCustom) {
          if (!question.allowOther || !answer.value.trim()) return nativeQuestionnaire(questions, ctx);
          answers.push({
            id: answer.questionId,
            value: answer.value,
            label: answer.value,
            wasCustom: true,
          });
          continue;
        }
        const index = question.options.findIndex((option) => option.value === answer.value);
        if (index < 0) return nativeQuestionnaire(questions, ctx);
        answers.push({
          id: answer.questionId,
          value: answer.value,
          label: question.options[index].label,
          wasCustom: false,
          index: index + 1,
        });
      }
      if (answers.length !== questions.length) return nativeQuestionnaire(questions, ctx);
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
  const answer = await requestDecision("permission", title, message, [{
    id: "permission",
    label: "Permission",
    prompt: message,
    allowOther: false,
    options: [
      { value: "allow", label: "Allow" },
      { value: "deny", label: "Deny" },
    ],
  }], ctx, ctx.signal);
  if (answer?.answers[0]?.value === "allow") return undefined;
  if (answer?.answers[0]?.value === "deny") {
    return { block: true, reason: "Permission denied by user" };
  }
  if (ctx.mode !== "tui") {
    return { block: true, reason: "Permission unresolved: interactive UI unavailable" };
  }
  const selected = await ctx.ui.select(message, ["Allow", "Deny"]);
  if (selected === "Allow") return undefined;
  if (selected === "Deny") return { block: true, reason: "Permission denied by user" };
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

export default function cliManagerHook(pi: ExtensionAPI) {
  const loadedDecisionBridges = new Set<string>();
  pi.on("tool_call", permissionDecision);

  pi.on("session_start", async (_event, ctx) => {
    stopHeartbeat();
    await cancelPendingDecisions();
    loadDecisionBridges(pi, loadedDecisionBridges);
    activeSessionId = sessionId(ctx);
    if (ENABLED.sessionStart) await postHook("SessionStart");
  });

  pi.on("agent_start", async (_event, ctx) => {
    activeSessionId = sessionId(ctx);
    failureMessage = null;
    if (ENABLED.running) {
      await postHook("UserPromptSubmit");
      startHeartbeat();
    } else {
      stopHeartbeat();
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
    stopHeartbeat();
    if (ENABLED.stop) {
      await postHook(failureMessage ? "StopFailure" : "Stop", failureMessage);
    }
    failureMessage = null;
  });

  pi.on("session_shutdown", async () => {
    stopHeartbeat();
    await cancelPendingDecisions();
    activeSessionId = null;
    failureMessage = null;
  });
}
