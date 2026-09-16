import { invoke } from "@tauri-apps/api/core";
import type {
  ProjectExtensionLaunchPlan,
  ProjectExtensionLaunchRequest,
  ProjectExtensionPolicyGetRequest,
  ProjectExtensionPolicyResponse,
  ProjectExtensionPolicySaveRequest,
} from "../../../shared/types/extensions";

export function getProjectExtensionPolicy(
  request: ProjectExtensionPolicyGetRequest,
): Promise<ProjectExtensionPolicyResponse> {
  return invoke<ProjectExtensionPolicyResponse>("extensions_project_policy_get", { request });
}

export function saveProjectExtensionPolicy(
  request: ProjectExtensionPolicySaveRequest,
): Promise<void> {
  return invoke<void>("extensions_project_policy_save", { request });
}

export function prepareProjectExtensionLaunch(
  request: ProjectExtensionLaunchRequest,
): Promise<ProjectExtensionLaunchPlan> {
  return invoke<ProjectExtensionLaunchPlan>("extensions_project_policy_prepare", { request });
}

export function releaseProjectExtensionSnapshot(snapshotId: string): Promise<void> {
  return invoke<void>("extensions_project_policy_release_snapshot", { snapshotId });
}

export function garbageCollectProjectExtensionSnapshots(
  activeSnapshotIds: string[],
): Promise<void> {
  return invoke<void>("extensions_project_policy_gc_snapshots", { activeSnapshotIds });
}
