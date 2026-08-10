import { useEffect, useId, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, ExternalLink, Send } from "lucide-react";
import type { DesktopPetCompletionSummary } from "../lib/desktopPetBubble";
import {
  DESKTOP_PET_DECISION_RESULT_EVENT,
  type DesktopPetConfigPayload,
  type DesktopPetDecisionAnswer,
  type DesktopPetDecisionRequest,
  type DesktopPetDecisionResult,
  type DesktopPetIncident,
} from "../lib/desktopPet";

export type DesktopPetLabels = DesktopPetConfigPayload["labels"];

function decisionKindLabel(
  labels: DesktopPetLabels,
  request: DesktopPetDecisionRequest
): string {
  if (request.kind === "permission") return labels.permissionRequest;
  if (request.kind === "questionnaire") return labels.questionnaireRequest;
  return labels.questionRequest;
}

function decisionCardTitle(request: DesktopPetDecisionRequest): string | null {
  const defaultTitle = {
    permission: "Pi permission",
    question: "Pi question",
    questionnaire: "Pi questionnaire",
  }[request.kind];
  return request.title === defaultTitle ? null : request.title;
}

function decisionCardMessage(request: DesktopPetDecisionRequest): string | null {
  const message = request.message?.trim();
  if (!message) return null;
  const prompts = request.questions.map((question) => question.prompt.trim()).join("\n\n");
  return message === prompts ? null : request.message;
}

export function DesktopPetDecisionCard({
  request,
  labels,
  bubbleSurfaceEpoch,
  onResolve,
}: {
  request: DesktopPetDecisionRequest;
  labels: DesktopPetLabels;
  bubbleSurfaceEpoch: string;
  onResolve: (
    request: DesktopPetDecisionRequest,
    answer: DesktopPetDecisionAnswer,
  ) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, { value: string; wasCustom: boolean }>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const submittingRef = useRef(false);
  const headingId = useId();
  const messageId = useId();
  const errorId = useId();
  const isSingle = request.questions.length === 1;
  const cardTitle = decisionCardTitle(request);
  const cardMessage = decisionCardMessage(request);
  const describedBy = [cardMessage ? messageId : null, submitFailed ? errorId : null]
    .filter(Boolean)
    .join(" ") || undefined;

  useEffect(() => {
    const unlisten = listen<DesktopPetDecisionResult>(
      DESKTOP_PET_DECISION_RESULT_EVENT,
      (event) => {
        if (
          event.payload.requestId === request.requestId
          && event.payload.brokerEpoch === request.brokerEpoch
          && event.payload.bubbleSurfaceEpoch === bubbleSurfaceEpoch
          && !event.payload.accepted
        ) {
          submittingRef.current = false;
          setSubmitting(false);
          setSubmitFailed(true);
        }
      }
    );
    return () => {
      submittingRef.current = false;
      void unlisten.then((remove) => remove());
    };
  }, [bubbleSurfaceEpoch, request.brokerEpoch, request.requestId]);

  const resolveAnswers = (next: Record<string, { value: string; wasCustom: boolean }>) => {
    if (submittingRef.current || Object.keys(next).length !== request.questions.length) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitFailed(false);
    void onResolve(request, {
      answers: request.questions.map((question) => ({
        questionId: question.id,
        value: next[question.id].value,
        wasCustom: next[question.id].wasCustom,
      })),
    }).catch(() => {
      submittingRef.current = false;
      setSubmitting(false);
      setSubmitFailed(true);
    });
  };

  const selectAnswer = (questionId: string, value: string, wasCustom: boolean) => {
    const normalized = wasCustom ? value.trim() : value;
    if (!normalized.trim()) return;
    const next = { ...answers, [questionId]: { value: normalized, wasCustom } };
    setAnswers(next);
    if (isSingle) resolveAnswers(next);
  };

  return (
    <article
      className="desktop-pet-decision"
      data-kind={request.kind}
      data-pet-interactive
      tabIndex={-1}
      aria-busy={submitting || undefined}
      aria-labelledby={headingId}
      aria-describedby={describedBy}
    >
      <header>
        <span id={cardTitle ? undefined : headingId}>{decisionKindLabel(labels, request)}</span>
        {cardTitle ? <strong id={headingId}>{cardTitle}</strong> : null}
      </header>
      {cardMessage ? (
        <p id={messageId} className="desktop-pet-card-message">{cardMessage}</p>
      ) : null}
      {submitFailed ? (
        <p id={errorId} className="desktop-pet-decision-error" role="alert">
          {labels.decisionSubmitFailed}
        </p>
      ) : null}
      <div className="desktop-pet-decision-questions">
        {request.questions.map((question) => (
          <fieldset key={question.id}>
            <legend>
              {question.label ? <small>{question.label}</small> : null}
              <span>{question.prompt}</span>
            </legend>
            <div className="desktop-pet-decision-options">
              {question.options.map((option) => {
                const selected = answers[question.id]?.value === option.value
                  && !answers[question.id]?.wasCustom;
                return (
                  <button
                    key={option.value}
                    type="button"
                    data-selected={selected || undefined}
                    aria-pressed={selected}
                    disabled={submitting}
                    onClick={() => selectAnswer(question.id, option.value, false)}
                  >
                    <strong>{option.label}</strong>
                    {option.description ? <small>{option.description}</small> : null}
                  </button>
                );
              })}
            </div>
            {question.allowOther ? (
              <div className="desktop-pet-decision-custom">
                <input
                  value={customAnswers[question.id] ?? ""}
                  maxLength={4_000}
                  disabled={submitting}
                  placeholder={labels.customAnswer}
                  aria-label={`${question.label || question.prompt} · ${labels.customAnswer}`}
                  onChange={(event) => setCustomAnswers((current) => ({
                    ...current,
                    [question.id]: event.currentTarget.value,
                  }))}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    selectAnswer(question.id, customAnswers[question.id] ?? "", true);
                  }}
                />
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => selectAnswer(
                    question.id,
                    customAnswers[question.id] ?? "",
                    true
                  )}
                >
                  <Send size={12} aria-hidden="true" />
                  <span>{labels.sendAnswer}</span>
                </button>
              </div>
            ) : null}
          </fieldset>
        ))}
      </div>
      {!isSingle ? (
        <button
          type="button"
          className="desktop-pet-decision-submit"
          disabled={submitting || Object.keys(answers).length !== request.questions.length}
          onClick={() => resolveAnswers(answers)}
        >
          <Send size={12} aria-hidden="true" />
          <span>{labels.submit}</span>
        </button>
      ) : null}
    </article>
  );
}

export function DesktopPetIncidentCard({
  incident,
  labels,
  onOpen,
  onAcknowledge,
}: {
  incident: DesktopPetIncident;
  labels: DesktopPetLabels;
  onOpen: (incident: DesktopPetIncident) => void;
  onAcknowledge: (incident: DesktopPetIncident) => void;
}) {
  const headingId = useId();
  const messageId = useId();
  return (
    <article
      className="desktop-pet-incident"
      data-pet-interactive
      tabIndex={-1}
      aria-labelledby={headingId}
      aria-describedby={incident.message ? messageId : undefined}
    >
      <header>
        <span>{labels.error}</span>
        <strong id={headingId}>{incident.title}</strong>
      </header>
      {incident.message ? (
        <p id={messageId} className="desktop-pet-card-message">{incident.message}</p>
      ) : null}
      <div className="desktop-pet-card-actions">
        <button type="button" onClick={() => onOpen(incident)}>
          <ExternalLink size={12} aria-hidden="true" />
          <span>{labels.openCurrent}</span>
        </button>
        <button type="button" onClick={() => onAcknowledge(incident)}>
          <Check size={12} aria-hidden="true" />
          <span>{labels.acknowledge}</span>
        </button>
      </div>
    </article>
  );
}

export function DesktopPetCompletionCard({
  completion,
  labels,
  onOpen,
}: {
  completion: DesktopPetCompletionSummary;
  labels: DesktopPetLabels;
  onOpen: (completion: DesktopPetCompletionSummary) => void;
}) {
  const headingId = useId();
  const messageId = useId();
  const title = completion.sessionTitle?.trim()
    || completion.projectName?.trim()
    || labels.success;
  return (
    <article
      className="desktop-pet-completion"
      data-pet-interactive
      tabIndex={-1}
      role="status"
      aria-live="polite"
      aria-atomic="false"
      aria-labelledby={headingId}
      aria-describedby={completion.message ? messageId : undefined}
    >
      <header>
        <span>{labels.success}</span>
        <strong id={headingId}>{title}</strong>
      </header>
      {completion.message ? (
        <p id={messageId} className="desktop-pet-card-message">{completion.message}</p>
      ) : null}
      <div className="desktop-pet-card-actions">
        <button type="button" onClick={() => onOpen(completion)}>
          <ExternalLink size={12} aria-hidden="true" />
          <span>{labels.openCurrent}</span>
        </button>
      </div>
    </article>
  );
}
