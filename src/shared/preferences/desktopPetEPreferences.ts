import {
  DEFAULT_DESKTOP_PET_E_SETTINGS,
  canEnableDesktopPet,
  canEnableDesktopPetE,
  normalizeDesktopPetESettings,
  type DesktopPetESettings,
} from "../lib/desktopPetE";

export { DEFAULT_DESKTOP_PET_E_SETTINGS, type DesktopPetESettings } from "../lib/desktopPetE";

// 展示偏好独立于桥接设置，折叠操作不触发宠物进程配置同步。
export type DesktopPetESettingsSectionKey = "petPicker";
export type DesktopPetESettingsSectionsExpanded = Record<DesktopPetESettingsSectionKey, boolean>;
export const DESKTOP_PET_E_SETTINGS_SECTION_KEYS: readonly DesktopPetESettingsSectionKey[] = [
  "petPicker",
];
/** 宠物包选择网格默认折叠：宠物较多时网格会铺满设置页，选定后极少改动。 */
export const DESKTOP_PET_E_SETTINGS_SECTIONS_EXPANDED_DEFAULT: DesktopPetESettingsSectionsExpanded = {
  petPicker: false,
};

export function migrateDesktopPetESettingsSectionsExpanded(
  value: unknown,
): DesktopPetESettingsSectionsExpanded {
  const defaults = DESKTOP_PET_E_SETTINGS_SECTIONS_EXPANDED_DEFAULT;
  if (typeof value !== "object" || value === null) {
    return { ...defaults };
  }
  const raw = value as Partial<Record<DesktopPetESettingsSectionKey, unknown>>;
  return DESKTOP_PET_E_SETTINGS_SECTION_KEYS.reduce<DesktopPetESettingsSectionsExpanded>((next, key) => {
    next[key] = typeof raw[key] === "boolean" ? raw[key] : defaults[key];
    return next;
  }, { ...defaults });
}

export function migrateDesktopPetESettings(value: unknown): DesktopPetESettings {
  return normalizeDesktopPetESettings(value, DEFAULT_DESKTOP_PET_E_SETTINGS);
}

export function applyDesktopPetEPreferences(
  entries: {
    desktopPet?: { enabled: boolean };
    desktopPetE?: DesktopPetESettings;
    desktopPetESettingsSectionsExpanded?: DesktopPetESettingsSectionsExpanded;
  },
  persistSetting: (key: "desktopPetE", value: DesktopPetESettings) => void,
): void {
  entries.desktopPetE = migrateDesktopPetESettings(entries.desktopPetE);
  entries.desktopPetESettingsSectionsExpanded = migrateDesktopPetESettingsSectionsExpanded(
    entries.desktopPetESettingsSectionsExpanded,
  );
  if (entries.desktopPet?.enabled && entries.desktopPetE.enabled) {
    entries.desktopPetE = { ...entries.desktopPetE, enabled: false };
    persistSetting("desktopPetE", entries.desktopPetE);
  }
}

// 存储入口调用纯校验后再写盘；互斥失败时不清除另一只宠物的偏好。
export function prepareDesktopPetSettingUpdate<T>(
  key: string,
  value: T,
  settings: { desktopPet: { enabled: boolean }; desktopPetE: DesktopPetESettings },
): T | DesktopPetESettings {
  const nextValue = key === "desktopPetE"
    ? normalizeDesktopPetESettings(value, settings.desktopPetE)
    : value;
  if (key === "desktopPet" && (nextValue as { enabled: boolean }).enabled
    && !canEnableDesktopPet(settings.desktopPetE.enabled)) {
    throw new Error("desktop_pet_mutual_exclusion");
  }
  if (key === "desktopPetE" && (nextValue as DesktopPetESettings).enabled
    && !canEnableDesktopPetE(settings.desktopPet.enabled)) {
    throw new Error("desktop_pet_e_mutual_exclusion");
  }
  return nextValue;
}
