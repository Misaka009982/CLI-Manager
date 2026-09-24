export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 640;
export const TERMINAL_MIN = 320;

export function sidebarLayout(viewport: number, left: number, right: number,
  leftOpen: boolean, rightOpen: boolean, detailsOpen = false) {
  const desktop = viewport >= 768;
  const details = desktop && viewport >= 1180 && detailsOpen ? 320 : 0;
  const count = Number(leftOpen) + Number(rightOpen);
  const budget = Math.max(0, viewport - details - TERMINAL_MIN - count * 6);
  const clamp = (value: number) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, value));
  let projects = desktop && leftOpen ? clamp(left) : 0;
  let files = desktop && rightOpen ? clamp(right) : 0;
  const excess = projects + files - budget;
  if (excess > 0) {
    const flexible = Math.max(0, projects - SIDEBAR_MIN) + Math.max(0, files - SIDEBAR_MIN);
    if (flexible > 0) {
      projects -= Math.min(excess, flexible) * Math.max(0, projects - SIDEBAR_MIN) / flexible;
      files -= Math.min(excess, flexible) * Math.max(0, files - SIDEBAR_MIN) / flexible;
    }
  }
  return { desktop, projects: Math.floor(projects), files: Math.floor(files), details,
    projectMax: Math.min(SIDEBAR_MAX, budget - files), fileMax: Math.min(SIDEBAR_MAX, budget - projects) };
}
