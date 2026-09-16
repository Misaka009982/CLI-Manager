import { invoke } from "@tauri-apps/api/core";
import type { NativeProviderHomeState } from "./nativeProviderTypes";

/** 读取供应商功能共用的当前 Home，供不拥有 Home 编辑状态的页面复用。 */
export function getActiveNativeProviderHome(): Promise<NativeProviderHomeState> {
  return invoke<NativeProviderHomeState>("provider_home_active_get");
}
