import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const treeSource = readFileSync(new URL("../src/features/projects/components/ProjectTree.tsx", import.meta.url), "utf8");
const pinnedSectionSource = readFileSync(new URL("../src/features/projects/components/PinnedProjectSection.tsx", import.meta.url), "utf8");
const sidebarSource = readFileSync(new URL("../src/features/projects/components/SidebarView.tsx", import.meta.url), "utf8");
const treeContextSource = readFileSync(new URL("../src/features/projects/components/TreeContext.tsx", import.meta.url), "utf8");
const controllerSource = readFileSync(new URL("../src/features/projects/hooks/useSidebarController.tsx", import.meta.url), "utf8");
const locateHookSource = readFileSync(new URL("../src/features/projects/hooks/useProjectLocate.ts", import.meta.url), "utf8");
const modelSource = readFileSync(new URL("../src/features/projects/lib/sidebarModel.ts", import.meta.url), "utf8");
const treeStyles = readFileSync(new URL("../src/styles/components/project-tree.css", import.meta.url), "utf8");
const iconsSource = readFileSync(new URL("../src/shared/ui/icons.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../src/shared/i18n/messages/projects.zh-CN.ts", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../src/shared/i18n/messages/projects.en-US.ts", import.meta.url), "utf8");

test("pinned region and project list scroll independently with a separator between them", () => {
  // 两个兄弟滚动容器 + 一条分隔线；滚轮由浏览器原生判定作用于指针所在区域。
  assert.match(treeSource, /className="ui-sidebar-pinned-scroll"/);
  assert.match(treeSource, /className="ui-sidebar-region-divider" role="separator"/);
  assert.match(treeSource, /<div className=\{embedded \? undefined : "ui-sidebar-main-scroll"\}>/);
  // 外层壳不再自己滚动，否则两个内层容器拿不到各自的滚动条。
  assert.match(treeSource, /flex h-full flex-col overflow-hidden/);
  // 「已置顶」筛选下置顶区独占区域，搜索态下置顶区隐藏，均不分区。
  assert.match(treeSource, /const splitPinnedRegion = !embedded && showPinnedSection && !pinnedFilterActive;/);

  assert.match(treeStyles, /\.ui-sidebar-pinned-scroll\s*\{[^}]*max-height:\s*30%/);
  assert.match(treeStyles, /\.ui-sidebar-pinned-scroll\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(treeStyles, /\.ui-sidebar-main-scroll\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(treeStyles, /\.ui-sidebar-main-scroll\s*\{[^}]*flex:\s*1 1 auto/);
  assert.match(treeStyles, /\.ui-sidebar-region-divider\s*\{/);
});

test("region scrolling stays native and is not reimplemented with wheel interception", () => {
  // 指针落在哪个区域，浏览器就滚动该区域最近的可滚动祖先，无需 JS 参与。
  assert.doesNotMatch(treeSource, /onWheel/);
  assert.doesNotMatch(treeSource, /addEventListener\(\s*"wheel"/);
  assert.doesNotMatch(sidebarSource, /onWheel/);
  // flex 子项默认 min-height:auto，缺了这条两个容器都不会真正溢出滚动。
  assert.match(treeStyles, /\.ui-sidebar-pinned-scroll\s*\{[^}]*min-height:\s*0;/);
  assert.match(treeStyles, /\.ui-sidebar-main-scroll\s*\{[^}]*min-height:\s*0;/);
  // 滚动条沿用全局 *::-webkit-scrollbar，因此两个容器不需要各自的 webkit 规则。
  assert.doesNotMatch(treeStyles, /\.ui-sidebar-(pinned|main)-scroll::-webkit-scrollbar/);
});

test("context menu protection restores the list region instead of the zero-height shell", () => {
  // 外层 .ui-sidebar-combined-list 的 scrollTop 恒为 0，回写它等于没保护。
  assert.match(modelSource, /closest<HTMLElement>\("\.ui-sidebar-main-scroll"\)/);
  // 置顶项不在列表区内，closest 返回 null，从而不会回写置顶区自身的滚动位置。
  assert.match(modelSource, /if \(!scrollContainer \|\| scrollTop === null\) return;/);
});

test("locating a pinned project expands its ancestor groups before scrolling", () => {
  assert.match(modelSource, /export function collectProjectAncestorGroupIds\(nodes: TNode\[\], projectId: string\): string\[\] \| null/);
  assert.match(modelSource, /walk\(node\.children, \[\.\.\.ancestors, node\.group\.id\]\)/);
  // 祖先链由外到内，返回 null 表示项目不在树里。
  assert.match(modelSource, /if \(node\.type === "project" && node\.project\.id === projectId\) return ancestors;/);

  assert.match(locateHookSource, /const ancestors = collectProjectAncestorGroupIds\(tree, project\.id\);/);
  assert.match(locateHookSource, /if \(ancestors === null\) \{/);
  assert.match(locateHookSource, /toast\.info\(t\("sidebar\.locate\.notFound"\)/);
  // 筛选不切回「全部」时项目可能根本不在树里。
  assert.match(locateHookSource, /if \(projectFilter !== "all"\) \{/);
  assert.match(locateHookSource, /setProjectFilter\("all"\);/);
  // 展开祖先与手动展开同语义，因此复用 setCollapsedIds（会被持久化）。
  assert.match(locateHookSource, /setCollapsedIds\(\(prev\) => \{/);
});

test("repeat locate still scrolls because the request is nonce driven", () => {
  // 选中态没变时 selectedTreeKey 不变化，依赖它不会重跑副作用。
  assert.match(locateHookSource, /nonceRef\.current \+= 1;/);
  assert.match(locateHookSource, /setLocateRequest\(\{ projectId: project\.id, projectName: project\.name, nonce: nonceRef\.current \}\);/);
  assert.match(treeSource, /const locateNonce = locateRequest\?\.nonce \?\? 0;/);
  assert.match(treeSource, /\}, \[locateNonce, locateProjectId, locateProjectName, t\]\);/);
  assert.match(treeSource, /\.find\(\(node\) => node\.dataset\.treeKey === targetKey\)/);
  assert.match(treeSource, /targetKey = `p:\$\{locateProjectId\}`/);
  assert.match(treeSource, /scrollIntoView\(\{ block: "nearest" \}\)/);
  // 原有「选中即滚动」的副作用必须保留，定位不改写它。
  assert.match(treeSource, /\}, \[selectedTreeKey\]\);/);
});

test("unreachable targets report instead of failing silently", () => {
  // 首帧未命中先补一帧再判定，避免把同批提交误判为不可达。
  assert.match(treeSource, /retryFrame = window\.requestAnimationFrame\(\(\) => attempt\(true\)\);/);
  assert.match(treeSource, /toast\.info\(t\("sidebar\.locate\.notFound"\), \{/);
  assert.match(treeSource, /t\("sidebar\.locate\.notFoundDescription", \{ name: locateProjectName \}\)/);
  assert.match(locateHookSource, /projectName: string;/);
});

test("locate menu item is the first entry and only appears for pinned copies", () => {
  const locateBlockStart = sidebarSource.indexOf("{contextMenu.fromPinned && (");
  assert.ok(locateBlockStart > 0, "project context menu must branch on fromPinned");

  const locateBlockEnd = sidebarSource.indexOf("</>", locateBlockStart);
  const locateBlock = sidebarSource.slice(locateBlockStart, locateBlockEnd);
  assert.match(locateBlock, /<Crosshair size=\{14\} strokeWidth=\{1\.5\} \/>/);
  assert.match(locateBlock, /t\("sidebar\.menu\.locate"\)/);
  // 紧随其后的分隔符，把定位项与其余操作分开。
  assert.match(locateBlock, /<div className="context-menu-separator" role="separator"/);
  // 批量选择态下与相邻项目项一致地隐藏。
  assert.match(locateBlock, /hidden=\{showProjectBatchContextMenu\}/);
  assert.match(locateBlock, /treeActions\.onLocateProject\(contextMenu\.project\)/);

  // 「第一位」：定位块必须排在首个既有项目项之前。
  const openTerminalIndex = sidebarSource.indexOf('t("sidebar.menu.openTerminal")');
  assert.ok(openTerminalIndex > locateBlockStart, "locate must precede the open-terminal entry");
  assert.match(sidebarSource, /Crosshair,/);
  assert.match(iconsSource, /\n  Crosshair,/);
});

test("pinned rows are the only source that marks the menu as fromPinned", () => {
  assert.match(pinnedSectionSource, /actions\.onContextMenuProject\(event, project, true\)/);
  assert.match(treeContextSource, /onContextMenuProject: \(e: ReactMouseEvent, p: Project, fromPinned\?: boolean\) => void;/);
  assert.match(controllerSource, /const handleContextMenuProject = useCallback\(\(e: ReactMouseEvent, project: Project, fromPinned\?: boolean\) => \{/);
  assert.match(controllerSource, /setContextMenu\(\{ kind: "project", project, x: e\.clientX, y: e\.clientY, fromPinned \}\);/);
  assert.match(controllerSource, /\| \{ kind: "project"; project: Project; x: number; y: number; fromPinned\?: boolean \}/);
  // 主列表行不传 fromPinned，因此它们不会出现定位项。
  assert.match(treeSource, /actions\.onContextMenuProject\(e, p\)/);
});

test("locate strings exist in both locales", () => {
  for (const source of [zhSource, enSource]) {
    assert.match(source, /"sidebar\.menu\.locate":/);
    assert.match(source, /"sidebar\.locate\.notFound":/);
    assert.match(source, /"sidebar\.locate\.notFoundDescription": "\{name\}/);
  }
});
