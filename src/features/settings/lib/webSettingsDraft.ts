export interface WebSettingsDraft<T> {
  values: T;
  revision: number;
  initialized: boolean;
}

type DraftAction<T> =
  | { type: "edit"; patch: Partial<T> }
  | { type: "status"; patch: Partial<T> }
  | { type: "saved"; patch: Partial<T>; revision: number };

export function createWebSettingsDraft<T>(values: T): WebSettingsDraft<T> {
  return { values, revision: 0, initialized: false };
}

// 状态事件只初始化未编辑的表单；保存回执只应用到提交时的版本，避免覆盖期间的新输入。
export function webSettingsDraftReducer<T>(state: WebSettingsDraft<T>, action: DraftAction<T>): WebSettingsDraft<T> {
  if (action.type === "edit") {
    return { ...state, values: { ...state.values, ...action.patch }, revision: state.revision + 1 };
  }
  const sync = action.type === "saved"
    ? action.revision === state.revision
    : !state.initialized && state.revision === 0;
  return { ...state, initialized: true, values: sync ? { ...state.values, ...action.patch } : state.values };
}
