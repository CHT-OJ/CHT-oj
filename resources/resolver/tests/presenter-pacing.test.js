import assert from "node:assert/strict";
import test from "node:test";

import { captureRowPositions } from "../animation.js";
import { ResolverSession } from "../core.js";
import { ResolverPage } from "../page.js";
import { ResolutionPlanner } from "../planner.js";
import { ResolutionPlayer } from "../player.js";
import { RowSweepPolicy } from "../policies.js";
import { DEFAULT_RESOLVER_SETTINGS, normalizeResolverSettings } from "../settings.js";
import { defaultPayload } from "./fixtures.js";

const pacingPayload = { ...defaultPayload, contestants: defaultPayload.contestants.slice(0, 2) };

function presenter(t, hold = 500) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalWindow = globalThis.window;
  // Reading time must also work with motion and highlights disabled.
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  const session = new ResolverSession(pacingPayload, { baseline: "beginning", tieOrder: "source" });
  const table = {
    children: [],
    querySelectorAll: () => table.children,
    insertBefore(row, current) {
      table.children.splice(table.children.indexOf(row), 1);
      table.children.splice(
        current ? table.children.indexOf(current) : table.children.length,
        0,
        row,
      );
    },
  };
  table.children = session.getStandings().map((standing) => {
    const row = {
      dataset: { contestantId: String(standing.contestantId) },
      getBoundingClientRect: () => ({ top: table.children.indexOf(row) * 50 }),
    };
    return row;
  });
  const page = Object.assign(Object.create(ResolverPage.prototype), {
    session,
    nodes: { tableBody: table },
    rowElements: new Map(table.children.map((row) => [row.dataset.contestantId, row])),
    heldRowOrder: null,
    revealHoldDurationMs: hold,
    revealHighlightDurationMs: 0,
    autoScrollAutomatic: false,
    pendingSetupOpen: false,
    manualActions: { flush: async () => {} },
    policyName: "row-sweep",
    _render() {
      const contestants = new Map(
        this.session.getState().contestants.map((row) => [String(row.participationId), row]),
      );
      const rows = this.session.getStandings().map((standing) => {
        const row = this.rowElements.get(String(standing.contestantId));
        row.rank = standing.rank;
        row.score = contestants.get(row.dataset.contestantId).score;
        return row;
      });
      this._reorderTableBody(rows);
    },
  });
  page._render();
  return {
    page,
    session,
    table,
    order: () => table.children.map((row) => row.dataset.contestantId),
  };
}

test("presenter hold accepts supported durations and defaults safely", () => {
  assert.equal(DEFAULT_RESOLVER_SETTINGS.revealHoldDurationMs, 500);
  for (const duration of [0, 250, 500, 750, 1000]) {
    assert.equal(
      normalizeResolverSettings({ revealHoldDurationMs: String(duration) }).revealHoldDurationMs,
      duration,
    );
  }
  for (const duration of [-1, NaN, Infinity, "invalid", 50000, undefined]) {
    assert.equal(
      normalizeResolverSettings({ revealHoldDurationMs: duration }).revealHoldDurationMs,
      500,
    );
  }
});

for (const hold of [250, 500]) {
  test(`new score and rank stay at the old row for ${hold} ms, including intervening renders`, async (t) => {
    const { page, session, table, order } = presenter(t, hold);
    const before = order();
    const target = table.children.at(-1).dataset.contestantId;
    const previousPositions = captureRowPositions(table);
    const transition = session.revealCell(target, 101);
    const expected = session.getStandings().map((standing) => String(standing.contestantId));
    assert.notDeepEqual(before, expected);
    const animation = page._animateReveal(transition, previousPositions);
    assert.deepEqual(order(), before);
    assert.equal(page.rowElements.get(target).rank, 1);
    assert.ok(page.rowElements.get(target).score > 0);
    t.mock.timers.tick(hold - 1);
    page._render(); // Pause, speed changes and HUD refresh also re-render.
    assert.deepEqual(order(), before);
    t.mock.timers.tick(1);
    await animation;
    assert.deepEqual(order(), expected);
    assert.equal(page.heldRowOrder, null);
    assert.equal(session.getHistoryCursor(), 1);
  });
}

test("hold Off moves immediately without a reading timer", async (t) => {
  const { page, session, table, order } = presenter(t, 0);
  const previousPositions = captureRowPositions(table);
  const target = order().at(-1);
  const transition = session.revealCell(target, 101);
  await page._animateReveal(transition, previousPositions);
  assert.deepEqual(
    order(),
    session.getStandings().map((standing) => String(standing.contestantId)),
  );
});

test("a result that stays in place does not incur a movement hold", async (t) => {
  const { page, session, table, order } = presenter(t);
  const before = order();
  const previousPositions = captureRowPositions(table);
  const transition = session.revealCell(before[0], 101);
  await page._animateReveal(transition, previousPositions);
  assert.deepEqual(order(), before);
});

test("Back during the hold cancels autoplay without rewinding an in-flight reveal; Back afterwards is exact", async (t) => {
  const { page, session, order } = presenter(t);
  const initial = session.getState();
  const before = order();
  const policy = new RowSweepPolicy(defaultPayload.problems.map((problem) => problem.id));
  const player = new ResolutionPlayer({
    session,
    planner: new ResolutionPlanner({
      payload: pacingPayload,
      targetSelector: (current) => policy.select(current),
    }),
    playbackSpeed: 4,
    onBeforeStep: (step) => page._beforePlayerStep(step),
    onStep: (step, context) => page._performPlayerStep(step, context),
    onChange: () => page._render(),
    onRestore: () => page._restorePlayerView(),
  });
  page.player = player;
  const running = player.playContinuous(false);
  for (let i = 0; i < 100 && !page.heldRowOrder; i += 1) await Promise.resolve();
  assert.ok(page.heldRowOrder);
  assert.equal(page.busy, true);
  assert.equal(session.getHistoryCursor(), 1);
  await page._rewind();
  assert.equal(player.running, false);
  assert.equal(session.getHistoryCursor(), 1);
  assert.deepEqual(order(), before);
  t.mock.timers.tick(500);
  await running;
  assert.equal(page.busy, false);
  assert.equal(session.getHistoryCursor(), 1, "no second reveal after cancellation");
  await page._rewind();
  assert.deepEqual(session.getState(), initial);
  assert.deepEqual(order(), before);
});
