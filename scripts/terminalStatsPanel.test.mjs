import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panelSource = readFileSync(
  new URL("../src/components/terminal/TerminalStatsPanel.tsx", import.meta.url),
  "utf8",
);

test("today project usage never renders stats from another project scope", () => {
  assert.match(panelSource, /const \[todayStatsState, setTodayStatsState\] = useState/);
  assert.match(panelSource, /const todayUsageScopeKey = useMemo/);
  assert.match(
    panelSource,
    /const todayStats = todayStatsState\?\.scopeKey === todayUsageScopeKey\s*\? todayStatsState\.value\s*: null/,
  );
  assert.match(
    panelSource,
    /setTodayStatsState\(\{ scopeKey: todayUsageScopeKey, value: result \}\)/,
  );
});
