import type {
  DesktopPetEAnswer,
  DesktopPetEPendingAction,
} from "../bridge/protocol.js";

export interface ActionDraft {
  answers: Record<string, string[]>;
  customValues: Record<string, string>;
  approvalValue: string | null;
}

export function createActionDraft(action: DesktopPetEPendingAction): ActionDraft {
  const answers: Record<string, string[]> = {};
  const customValues: Record<string, string> = {};
  for (const question of action.questions ?? []) {
    answers[question.id] = [];
    customValues[question.id] = "";
  }
  return { answers, customValues, approvalValue: null };
}

export function serializeAnswers(action: DesktopPetEPendingAction, draft: ActionDraft): DesktopPetEAnswer[] {
  return (action.questions ?? []).map((question) => ({
    questionId: question.id,
    values: draft.answers[question.id] ?? [],
    customValue: draft.customValues[question.id]?.trim() || null,
  }));
}

export function isDraftComplete(action: DesktopPetEPendingAction, draft: ActionDraft): boolean {
  if (action.kind === "approval") return Boolean(draft.approvalValue);
  return (action.questions ?? []).every((question) => {
    const values = draft.answers[question.id] ?? [];
    const custom = draft.customValues[question.id]?.trim() ?? "";
    if (question.mode === "text") return custom.length > 0;
    return values.length > 0 || (question.allowOther && custom.length > 0);
  });
}
