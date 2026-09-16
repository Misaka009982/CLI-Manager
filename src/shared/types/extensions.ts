export type ExtensionCli = "claude" | "codex" | "grok";

export type ExtensionScopeKind = "project" | "worktree";
export type ExtensionPolicyKind = "mcp" | "skill";
export type ExtensionPolicyMode = "inherit" | "custom";
export type ProjectExtensionApplicationStatus = "applied" | "globalOnly" | "error";

export type McpTransport = "stdio" | "sse" | "streamableHttp";

export type McpConfigFormat = "json" | "toml";

export interface McpTimeout {
  startupMs: number | null;
  requestMs: number | null;
}

export interface McpResourceSource {
  kind: string;
  identity: string;
  label: string | null;
}

export type JsonObject = Record<string, unknown>;

export interface McpResource {
  schemaVersion: number;
  resourceId: string;
  serverKey: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  env: Record<string, string>;
  headers: Record<string, string>;
  secretRefs: Record<string, string>;
  timeout: McpTimeout | null;
  perCliExtensions: Record<string, JsonObject>;
  enabledByCli: Record<ExtensionCli, boolean>;
  source: McpResourceSource | null;
  [key: string]: unknown;
}

export interface McpResourceRedacted {
  schemaVersion: number;
  resourceId: string;
  serverKey: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  env: Record<string, string>;
  headers: Record<string, string>;
  secretRefs: Record<string, string>;
  timeout: McpTimeout | null;
  perCliExtensions: Record<string, JsonObject>;
  enabledByCli: Record<ExtensionCli, boolean>;
  source: McpResourceSource | null;
  extra: Record<string, unknown>;
  redactedFields: string[];
}

export interface McpValidationIssue {
  code: string;
  field: string;
}

export interface McpValidationReport {
  valid: boolean;
  issues: McpValidationIssue[];
}

export type CapabilityStatus = "supported" | "globalOnly" | "unknown" | "error";
export type CapabilityFieldStatus = "supported" | "unsupported" | "canonicalOnly";

export interface McpCapabilityField {
  status: CapabilityFieldStatus;
  note: string | null;
}

export interface McpCliCapability {
  cli: ExtensionCli;
  displayName: string;
  format: McpConfigFormat;
  rootKey: string;
  version: string | null;
  status: CapabilityStatus;
  transports: McpTransport[];
  fields: Record<string, McpCapabilityField>;
}

export type ProjectionStatus = "ready" | "unsupported";

export interface McpProjectionIssue {
  code: string;
  field: string;
  resourceId: string | null;
}

export interface McpProjectionPreview {
  cli: ExtensionCli;
  format: McpConfigFormat;
  status: ProjectionStatus;
  content: string;
  resources: McpResourceRedacted[];
  issues: McpProjectionIssue[];
  omittedFields: string[];
  changed: boolean;
}

export interface McpNativeConfigPreview {
  cli: ExtensionCli;
  format: McpConfigFormat;
  resources: McpResourceRedacted[];
}

export interface McpProjectionRequest {
  cli: ExtensionCli;
  baseConfig: string;
  resources: McpResource[];
}

export type ExtensionImportSourceKind = "nativeMcp" | "ccswitch" | "skillDirectory";

export type ExtensionImportConflictPolicy = "skip" | "replace" | "saveAs";

export interface ExtensionImportRequest {
  sourceKind: ExtensionImportSourceKind;
  cli?: ExtensionCli | null;
  sourcePath?: string | null;
}

export interface ExtensionImportApplyRequest extends ExtensionImportRequest {
  expectedFingerprint: string;
  selectedResourceIds?: string[];
  selectedSkillIds?: string[];
  conflictPolicy: ExtensionImportConflictPolicy;
}

export interface SkillImportPreview {
  packageId: string;
  sourceIdentity: string;
  sourceRef: string;
  subdirectory: string;
  fileCount: number;
  totalBytes: number;
}

export interface ExtensionImportItemPreview {
  candidateId: string;
  kind: "mcp" | "skill";
  name: string;
  description: string;
  contentHash: string;
  action: string;
  reason: string | null;
  resource: McpResourceRedacted | null;
  skill: SkillImportPreview | null;
}

export interface ExtensionImportPreview {
  sourceKind: ExtensionImportSourceKind;
  sourceIdentity: string;
  sourcePath: string;
  sourceFingerprint: string;
  items: ExtensionImportItemPreview[];
  warnings: string[];
}

export interface ExtensionImportItemResult {
  candidateId: string;
  kind: "mcp" | "skill";
  status: string;
  resourceId: string | null;
  packageId: string | null;
  reason: string | null;
}

export interface ExtensionImportResult {
  sourceKind: ExtensionImportSourceKind;
  sourceIdentity: string;
  sourceFingerprint: string;
  items: ExtensionImportItemResult[];
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  warnings: string[];
}

export type SkillSyncMode = "auto" | "symlink" | "copy";

export interface SkillPackageView {
  packageId: string;
  name: string;
  description: string;
  sourceKind: string;
  sourceIdentity: string;
  sourceRef: string;
  resolvedCommit: string | null;
  subdirectory: string;
  contentHash: string;
  version: string | null;
  packagePath: string;
  updatedAtMs: number;
}

export interface SkillInstallationView {
  installationId: string;
  packageId: string;
  environmentKind: "local" | "wsl" | string;
  environmentId: string;
  cli: ExtensionCli;
  homePath: string;
  targetPath: string;
  requestedMode: SkillSyncMode | string;
  actualMode: SkillSyncMode | string;
  linkTarget: string | null;
  deployedHash: string;
  owned: boolean;
  externalModified: boolean;
  backupPath: string | null;
  status: string;
  updatedAtMs: number;
}

export interface SkillDeploymentRequest {
  packageId: string;
  environmentKind: "local" | "wsl";
  environmentId: string;
  cli: ExtensionCli;
  homePath: string;
  mode: SkillSyncMode;
}

export interface SkillDeploymentResult {
  installation: SkillInstallationView;
  changed: boolean;
  backupPath: string | null;
}

export interface SkillUninstallResult {
  installationId: string;
  removed: boolean;
  externalModified: boolean;
  backupPath: string | null;
}

export interface SkillRestoreResult {
  installation: SkillInstallationView;
  restoredFrom: string;
}

export interface GithubSkillRequest {
  repositoryUrl: string;
  reference?: string | null;
  subdirectory?: string | null;
  resolvedCommit?: string | null;
  candidateIds?: string[];
  candidateId?: string | null;
  operationId?: string | null;
}

export interface GithubSkillCandidateView {
  candidateId: string;
  name: string;
  description: string;
  skillPath: string;
  packagePath: string;
  manifestHash: string;
  resolvedCommit: string;
}

export interface GithubSkillPreview {
  repositoryUrl: string;
  owner: string;
  repository: string;
  reference: string;
  resolvedCommit: string;
  subdirectory: string;
  candidates: GithubSkillCandidateView[];
  sourceFingerprint: string;
  operationId: string | null;
}

export interface GithubSkillInstallResult {
  resolvedCommit: string;
  packages: SkillPackageView[];
  skipped: number;
  warnings: string[];
}

export interface ProjectExtensionPolicyGetRequest {
  projectId: string;
  worktreeId?: string | null;
  environmentKind?: "local" | "wsl" | string | null;
  environmentId?: string | null;
}

export interface ProjectExtensionPolicyInput {
  cli: ExtensionCli;
  kind: ExtensionPolicyKind;
  mode: ExtensionPolicyMode;
  selectedIds: string[];
}

export interface ProjectExtensionPolicySaveRequest {
  scopeKind: ExtensionScopeKind;
  scopeId: string;
  projectId: string;
  policies: ProjectExtensionPolicyInput[];
}

export interface ProjectExtensionPolicyView {
  scopeKind: ExtensionScopeKind;
  scopeId: string;
  projectId: string;
  cli: ExtensionCli;
  kind: ExtensionPolicyKind;
  mode: ExtensionPolicyMode;
  selectedIds: string[];
  effectiveIds: string[];
  appliedIds: string[];
  inheritedFrom: string;
  revision: number;
  capabilityStatus: CapabilityStatus;
  applicationStatus: ProjectExtensionApplicationStatus;
  reason: string | null;
}

export interface ProjectExtensionPolicyResponse {
  projectId: string;
  worktreeId: string | null;
  scopeKind: ExtensionScopeKind;
  scopeId: string;
  resources: McpResourceRedacted[];
  packages: SkillPackageView[];
  policies: ProjectExtensionPolicyView[];
  globalMcpIds: Record<ExtensionCli, string[]>;
  globalSkillIds: Record<ExtensionCli, string[]>;
}

export interface ProjectExtensionLaunchRequest {
  projectId: string;
  worktreeId?: string | null;
  cli: ExtensionCli;
  environmentKind: "local" | "wsl";
  environmentId: string;
  providerSnapshotId?: string | null;
  providerId?: string | null;
}

export interface ProjectExtensionLaunchPlan {
  snapshotId: string | null;
  policyRevision: number;
  mcpStatus: ProjectExtensionApplicationStatus;
  skillStatus: ProjectExtensionApplicationStatus;
  mcpConfigPath: string | null;
  claudeSettingsPath: string | null;
  codexConfigOverrides: string[];
  codexProfileName: string | null;
  appliedMcpIds: string[];
  appliedSkillIds: string[];
  warnings: string[];
}
