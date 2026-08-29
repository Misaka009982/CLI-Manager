// __PI_MARKER__
// CLI_MANAGER_PI_EXTENSION_VERSION:5
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
// 兜底补丁发通知前先等一会儿：官方 ui_prompt 事件（Pi 0.84.4+）在同一轮微任务里就会到，
// 抢先接管后补丁就不再发，避免同一个对话框出现两条提醒。
const DIALOG_MIRROR_FALLBACK_MS = 150;

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
  const numbered = options.map((option, index) => `${index + 1}. ${option.label}`);
  const selected = await ctx.ui.select(prompt, [...numbered, "Type something."], skipMirror(signal));
  if (!selected) return { answer: null, wasCustom: false };
  if (selected === "Type something.") {
    return {
      answer: nonEmpty(await ctx.ui.input(prompt, "Your answer", skipMirror(signal))),
      wasCustom: true,
    };
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
  const answers: Array<{ id: string; value: string; label: string; wasCustom: boolean; index?: number }> = [];
  for (const question of questions) {
    const numbered = question.options.map((option, index) => `${index + 1}. ${option.label}`);
    const choices = question.allowOther ? [...numbered, "Type something."] : numbered;
    const selected = await ctx.ui.select(question.prompt, choices, skipMirror(signal));
    if (!selected) {
      return {
        content: [{ type: "text", text: "User cancelled the questionnaire" }],
        details: { questions, answers, cancelled: true },
      };
    }
    if (selected === "Type something.") {
      const custom = nonEmpty(await ctx.ui.input(question.prompt, "Your answer", skipMirror(signal)));
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
// 官方 ui_prompt 事件是否已到达。只要收到过一次就说明当前 Pi 支持它，兜底补丁从此只做
// 「跳过自身对话框」的判断，不再发通知，避免双份提醒。
let officialPromptEvents = false;

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
      if (own) ownDialogs += 1;
      // 兜底通知延后发：官方事件（如果这版 Pi 有）会在同一轮微任务里先到并接管，
      // 到时这里就不再重复发。等待期间也要挂起心跳，否则提示会被刷掉。
      const fallback = own ? null : setTimeout(() => {
        if (!officialPromptEvents) void postHook("Notification", dialogNotice(kind, args[0]));
      }, DIALOG_MIRROR_FALLBACK_MS);
      if (!own) beginMirroredDialog();
      try {
        return await forward.apply(this, args);
      } finally {
        if (own) ownDialogs = Math.max(0, ownDialogs - 1);
        else {
          if (fallback) clearTimeout(fallback);
          endMirroredDialog();
        }
      }
    };
  }
  ui[DIALOG_MIRROR_INSTALLED] = true;
}

// 官方事件通道：Pi 已把嵌套对话框合并成一个外层区间，同一时刻最多只有一个区间，
// 所以用一个布尔量记住「这个区间是否已镜像」，结束时据此配平，而不是在结束时重新判断
// ownDialogs（那个计数可能已被别处的对话框改动，会导致心跳挂起后无法恢复）。
let officialSpanMirrored = false;

function registerPromptEvents(pi: ExtensionAPI): void {
  pi.on("ui_prompt_start", async (event) => {
    officialPromptEvents = true;
    if (!ENABLED.running || ownDialogs > 0) return;
    officialSpanMirrored = true;
    beginMirroredDialog();
    void postHook("Notification", dialogNotice(event.kind, event.title));
  });
  pi.on("ui_prompt_end", async () => {
    officialPromptEvents = true;
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
