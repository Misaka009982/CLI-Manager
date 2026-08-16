import {
  useEffect,
  useId,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";
import {
  createActionDraft,
  isDraftComplete,
  serializeAnswers,
  type ActionDraft,
} from "../../lib/desktopPetEAgentAction";
import {
  DESKTOP_PET_E_MAX_ANSWER_TEXT_LENGTH,
  type DesktopPetEPendingAction,
  type DesktopPetEQuestion,
} from "../../lib/desktopPetE";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import { useDesktopPetEAgentStore } from "../../stores/desktopPetEAgentStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { Check, Info, Maximize2, Minimize2, RefreshCw, ShieldAlert } from "../icons";

interface DesktopPetESessionActionPanelProps {
  sessionId: string;
}

interface ActionContentProps {
  action: DesktopPetEPendingAction;
}

interface JumpOnlyNoticeProps extends ActionContentProps {
  reason?: string;
}

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

const ACTION_TRANSLATION_KEYS = new Set<TranslationKey>([
  "desktopPetE.renderer.actionFailed",
  "desktopPetE.approval.allow",
  "desktopPetE.approval.allowForSession",
  "desktopPetE.approval.alwaysAllow",
  "desktopPetE.approval.alwaysAllowLocal",
  "desktopPetE.approval.alwaysAllowProject",
  "desktopPetE.approval.alwaysAllowUser",
  "desktopPetE.approval.deny",
  "desktopPetE.approval.cancel",
  "desktopPetE.agent.adapterUnavailable",
  "desktopPetE.agent.notificationOnly",
  "desktopPetE.agent.requestUnsupported",
  "desktopPetE.agent.grokJumpOnly",
  "desktopPetE.agent.requestExpired",
  "desktopPetE.agent.deliveryFailed",
]);

function localizeActionText(value: string | null | undefined, t: Translate): string | null {
  if (!value) return null;
  return ACTION_TRANSLATION_KEYS.has(value as TranslationKey) ? t(value as TranslationKey) : value;
}

function updateQuestionValues(
  setDraft: Dispatch<SetStateAction<ActionDraft>>,
  question: DesktopPetEQuestion,
  values: string[],
): void {
  setDraft((current) => ({
    ...current,
    answers: { ...current.answers, [question.id]: values },
    customValues: question.mode === "single" && values.length > 0
      ? { ...current.customValues, [question.id]: "" }
      : current.customValues,
  }));
}

function updateCustomValue(
  setDraft: Dispatch<SetStateAction<ActionDraft>>,
  question: DesktopPetEQuestion,
  value: string,
): void {
  setDraft((current) => ({
    ...current,
    answers: question.mode === "single" && value.trim()
      ? { ...current.answers, [question.id]: [] }
      : current.answers,
    customValues: { ...current.customValues, [question.id]: value },
  }));
}

function JumpOnlyNotice({ action, reason }: JumpOnlyNoticeProps) {
  const { t } = useI18n();
  const title = action.title?.trim() || t("desktopPetE.renderer.actionNeeded");
  const details = [
    action.message?.trim() || null,
    localizeActionText(reason ?? action.adapterReason, t),
  ].filter((value): value is string => Boolean(value));
  const description = details.join(" · ") || t("desktopPetE.agent.adapterUnavailable");

  return (
    <aside
      className="absolute right-3 top-3 z-30 flex items-start gap-3 rounded-md border px-3 py-2.5 shadow-2xl backdrop-blur-md"
      style={{
        width: "min(520px, calc(100% - 24px))",
        color: "var(--terminal-theme-foreground, #ececec)",
        borderColor: "color-mix(in srgb, #f5c451 48%, transparent)",
        background: "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 92%, #f5c451 8%)",
      }}
      role="status"
      aria-live="polite"
    >
      <Info className="mt-0.5 shrink-0 text-amber-300" size={17} aria-hidden="true" />
      <span className="min-w-0">
        <strong className="block break-words text-xs font-semibold tracking-normal">{title}</strong>
        <span
          className="mt-1 block max-h-24 overflow-y-auto break-words pr-1 text-[11px] leading-4"
          style={{ color: "var(--terminal-theme-muted, #9ca0a6)" }}
        >
          {description}
        </span>
      </span>
    </aside>
  );
}

function InteractiveActionPanel({ action }: ActionContentProps) {
  const { t } = useI18n();
  const submit = useDesktopPetEAgentStore((state) => state.submit);
  const sharedSubmitting = useDesktopPetEAgentStore((state) => state.submissions.get(action.id) ?? null);
  const [draft, setDraft] = useState<ActionDraft>(() => createActionDraft(action));
  const [collapsed, setCollapsed] = useState(false);
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const titleId = useId();
  const groupPrefix = useId();
  const submitting = action.submitting || localSubmitting || sharedSubmitting !== null;
  const error = localizeActionText(localError ?? action.error, t);
  const title = action.title?.trim() || t("desktopPetE.renderer.actionNeeded");

  useEffect(() => {
    if (action.submitting || action.error) {
      setLocalSubmitting(false);
      setLocalError(null);
    }
  }, [action.error, action.submitting]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || !isDraftComplete(action, draft)) return;
    const transportActionId = `session-${crypto.randomUUID()}`;
    setLocalError(null);
    setLocalSubmitting(true);
    try {
      await submit({
        pendingActionId: action.id,
        transportActionId,
        answers: serializeAnswers(action, draft),
        approvalValue: draft.approvalValue,
      });
    } catch {
      setLocalSubmitting(false);
      setLocalError("desktopPetE.renderer.actionFailed");
    }
  };

  return (
    <form
      className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 flex-col overflow-hidden rounded-md border shadow-2xl backdrop-blur-md"
      style={{
        width: "min(720px, calc(100% - 24px))",
        maxHeight: "min(520px, 72%)",
        color: "var(--terminal-theme-foreground, #ececec)",
        borderColor: "color-mix(in srgb, #f5c451 52%, transparent)",
        background: "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 95%, #f5c451 5%)",
      }}
      aria-labelledby={titleId}
      onSubmit={(event) => void handleSubmit(event)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="flex shrink-0 items-start gap-3 border-b px-4 py-3" style={{ borderColor: "color-mix(in srgb, currentColor 14%, transparent)" }}>
        <ShieldAlert className="mt-0.5 shrink-0 text-amber-300" size={18} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <strong id={titleId} className="block break-words text-sm font-semibold tracking-normal">{title}</strong>
          {!collapsed && action.message && (
            <span
              className="mt-1 block max-h-20 overflow-y-auto break-words pr-1 text-xs leading-5"
              style={{ color: "var(--terminal-theme-muted, #9ca0a6)" }}
            >
              {action.message}
            </span>
          )}
        </span>
        <button
          type="button"
          className="ui-focus-ring inline-grid h-7 w-7 shrink-0 place-items-center rounded text-current opacity-70 transition-opacity hover:bg-white/10 hover:opacity-100"
          title={t(collapsed ? "desktopPetE.renderer.expand" : "desktopPetE.renderer.collapse")}
          aria-label={t(collapsed ? "desktopPetE.renderer.expand" : "desktopPetE.renderer.collapse")}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((current) => !current)}
        >
          {collapsed
            ? <Maximize2 size={15} aria-hidden="true" />
            : <Minimize2 size={15} aria-hidden="true" />}
        </button>
      </header>

      {!collapsed && (
        <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {error && (
          <p className="mb-3 mt-0 rounded border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200" role="alert">
            {error}
          </p>
        )}

        {action.kind === "approval" ? (
          <div className="grid gap-2">
            {(action.approvalChoices ?? []).map((choice, index) => {
              const inputId = `${groupPrefix}-approval-${index}`;
              return (
                <label
                  key={choice.value}
                  htmlFor={inputId}
                  className={`flex min-h-10 cursor-pointer items-start gap-3 rounded border px-3 py-2 text-xs transition-colors hover:bg-white/5 ${choice.destructive ? "border-red-400/30 text-red-200" : "border-white/15"}`}
                >
                  <input
                    id={inputId}
                    type="radio"
                    name={`${groupPrefix}-approval`}
                    value={choice.value}
                    checked={draft.approvalValue === choice.value}
                    disabled={submitting}
                    onChange={() => setDraft((current) => ({ ...current, approvalValue: choice.value }))}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-amber-300"
                  />
                  <span className="min-w-0 break-words leading-5">
                    {localizeActionText(choice.label, t) ?? choice.label}
                  </span>
                </label>
              );
            })}
          </div>
        ) : (
          <div className="grid gap-4">
            {(action.questions ?? []).map((question, questionIndex) => {
              const values = draft.answers[question.id] ?? [];
              return (
                <fieldset key={question.id} className="m-0 min-w-0 border-0 border-t border-white/10 p-0 pt-3 first:border-t-0 first:pt-0">
                  <legend className="mb-2 flex max-w-full items-start gap-2 p-0 text-xs font-semibold tracking-normal">
                    <span className="inline-grid h-5 w-5 shrink-0 place-items-center rounded-full bg-amber-300 text-[10px] font-bold text-black">
                      {questionIndex + 1}
                    </span>
                    <span className="min-w-0 break-words leading-5">{question.label || question.prompt}</span>
                    {question.required === false && (
                      <span className="shrink-0 text-[10px] font-normal" style={{ color: "var(--terminal-theme-muted, #9ca0a6)" }}>
                        {t("desktopPetE.renderer.optional")}
                      </span>
                    )}
                  </legend>
                  {question.label && (
                    <p className="mb-2 mt-0 break-words text-xs leading-5" style={{ color: "var(--terminal-theme-muted, #9ca0a6)" }}>
                      {question.prompt}
                    </p>
                  )}
                  {question.mode !== "text" && (
                    <div className="grid gap-2">
                      {question.options.map((option, optionIndex) => {
                        const inputId = `${groupPrefix}-${questionIndex}-${optionIndex}`;
                        const checked = values.includes(option.value);
                        return (
                          <label
                            key={option.value}
                            htmlFor={inputId}
                            className="flex min-h-10 cursor-pointer items-start gap-3 rounded border border-white/15 px-3 py-2 text-xs transition-colors hover:bg-white/5"
                          >
                            <input
                              id={inputId}
                              type={question.mode === "multiple" ? "checkbox" : "radio"}
                              name={`${groupPrefix}-${question.id}`}
                              value={option.value}
                              checked={checked}
                              disabled={submitting}
                              onChange={(event) => {
                                if (question.mode === "multiple") {
                                  const next = event.currentTarget.checked
                                    ? [...values, option.value]
                                    : values.filter((value) => value !== option.value);
                                  updateQuestionValues(setDraft, question, next);
                                } else {
                                  updateQuestionValues(setDraft, question, [option.value]);
                                }
                              }}
                              className="mt-0.5 h-4 w-4 shrink-0 accent-amber-300"
                            />
                            <span className="min-w-0">
                              <strong className="block break-words font-medium leading-5">{option.label}</strong>
                              {option.description && (
                                <small className="mt-0.5 block break-words text-[11px] leading-4" style={{ color: "var(--terminal-theme-muted, #9ca0a6)" }}>
                                  {option.description}
                                </small>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {(question.mode === "text" || question.allowOther) && (
                    <textarea
                      value={draft.customValues[question.id] ?? ""}
                      disabled={submitting}
                      maxLength={DESKTOP_PET_E_MAX_ANSWER_TEXT_LENGTH}
                      rows={3}
                      onChange={(event) => updateCustomValue(setDraft, question, event.currentTarget.value)}
                      placeholder={t("desktopPetE.renderer.typeAnswer")}
                      aria-label={question.prompt}
                      className="mt-2 w-full resize-y rounded border border-white/20 bg-black/25 px-3 py-2 text-xs leading-5 text-inherit outline-none focus:border-amber-300 disabled:cursor-wait disabled:opacity-60"
                    />
                  )}
                </fieldset>
              );
            })}
          </div>
        )}
      </div>

      <footer className="flex shrink-0 justify-end border-t px-4 py-3" style={{ borderColor: "color-mix(in srgb, currentColor 14%, transparent)" }}>
        <button
          type="submit"
          disabled={submitting || !isDraftComplete(action, draft)}
          className="ui-focus-ring inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-amber-300/45 bg-amber-300/15 px-4 text-xs font-semibold text-amber-100 transition-colors hover:bg-amber-300/25 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {submitting
            ? <RefreshCw className="animate-spin" size={15} aria-hidden="true" />
            : <Check size={15} aria-hidden="true" />}
          {submitting
            ? t("desktopPetE.renderer.submitting")
            : error
              ? t("desktopPetE.renderer.retry")
              : t("desktopPetE.renderer.submit")}
        </button>
      </footer>
        </>
      )}
    </form>
  );
}

export function DesktopPetESessionActionPanel({ sessionId }: DesktopPetESessionActionPanelProps) {
  const action = useDesktopPetEAgentStore((state) => state.pendingActions.get(sessionId) ?? null);
  const agentInteractionEnabled = useSettingsStore((state) => state.desktopPetE.agentInteractionEnabled);
  if (!action) return null;
  if (!agentInteractionEnabled) {
    return <JumpOnlyNotice action={action} reason="desktopPetE.agent.adapterUnavailable" />;
  }
  if (action.adapterMode !== "interactive") return <JumpOnlyNotice action={action} />;
  return <InteractiveActionPanel key={`${action.id}:${action.requestGeneration}`} action={action} />;
}
