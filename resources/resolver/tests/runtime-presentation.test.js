import assert from "node:assert/strict";
import test from "node:test";

import { animateRevealHighlight, ensureRowVisible, isRowWithinSafeViewport } from "../animation.js";
import { ResolverSession, resolveResolverBaseline } from "../core.js";
import { ManualActionCoordinator } from "../manual-actions.js";
import { ResolutionPlanner } from "../planner.js";
import { ResolutionPlayer } from "../player.js";
import { RESOLUTION_STEP_TYPES } from "../timing.js";
import { RowSweepPolicy } from "../policies.js";
import {
  DEFAULT_RESOLVER_SETTINGS,
  ResolverSettingsManager,
  normalizeResolverSettings,
} from "../settings.js";
import { defaultPayload, icpcPayload } from "./fixtures.js";

function semanticSnapshot(session) {
  return {
    state: session.getState(),
    standings: session.getStandings(),
    historyCursor: session.getHistoryCursor(),
    historyLength: session.getHistoryLength(),
    resolvableCount: session.getResolvableCount(),
  };
}

function plannerFor(payload, session, options = {}) {
  const policy = new RowSweepPolicy(payload.problems.map((problem) => problem.id));
  return new ResolutionPlanner({
    payload,
    targetSelector: (currentSession) => policy.select(currentSession),
    singleStepStartRank: options.singleStepStartRank ?? 0,
    awardPlaces: options.awardPlaces ?? 0,
    hardPauses: options.hardPauses ?? { award: false, firstSolve: false },
  });
}

test("settings Cancel preserves exact semantic Resolver state", () => {
  const session = new ResolverSession(defaultPayload, { baseline: "beginning", seed: "settings" });
  session.revealCell(11, 101);
  session.revealCell(22, 101);
  const before = semanticSnapshot(session);
  const manager = new ResolverSettingsManager(DEFAULT_RESOLVER_SETTINGS, 3);

  manager.beginEdit();
  manager.updateDraft({
    revealHighlightDurationMs: 750,
    revealHoldDurationMs: 250,
    autoScrollAutomatic: false,
    autoScrollManual: true,
  });
  manager.cancelEdit();
  assert.deepEqual(semanticSnapshot(session), before);
  assert.deepEqual(manager.getActive(), normalizeResolverSettings(DEFAULT_RESOLVER_SETTINGS, 3));
});

test("runtime Apply preserves checkpoints and replans future playback with new settings", async () => {
  const session = new ResolverSession(defaultPayload, {
    baseline: "beginning",
    seed: "settings-apply",
    tieOrder: "source",
  });
  const manager = new ResolverSettingsManager(DEFAULT_RESOLVER_SETTINGS, 3);

  const player = new ResolutionPlayer({
    session,
    planner: plannerFor(defaultPayload, session),
    wait: async () => {},
  });
  await player.fastForwardToNextPause();
  await player.fastForwardToNextPause();
  await player.fastForwardToNextPause();
  const before = semanticSnapshot(session);
  const checkpointsBefore = player.getState().checkpointCount;
  manager.beginEdit();
  const applied = manager.commitDraft({
    ...manager.getDraft(),
    speedIndex: 3,
    revealHighlightDurationMs: 750,
    revealHoldDurationMs: 250,
    autoScrollAutomatic: false,
    autoScrollManual: true,
    singleStepStartRank: 3,
    awardPlaces: 1,
    pauseAward: true,
    pauseFirstSolve: true,
  });
  await player.reconfigure({
    planner: plannerFor(defaultPayload, session, {
      singleStepStartRank: applied.singleStepStartRank,
      awardPlaces: applied.awardPlaces,
      hardPauses: { award: applied.pauseAward, firstSolve: applied.pauseFirstSolve },
    }),
    playbackSpeed: 4,
    resetAwardZoneMilestone: true,
  });

  assert.deepEqual(semanticSnapshot(session), before);
  assert.equal(player.getState().playbackSpeed, 4);
  assert.equal(applied.revealHighlightDurationMs, 750);
  assert.equal(applied.revealHoldDurationMs, 250);
  assert.equal(applied.autoScrollAutomatic, false);
  assert.equal(applied.autoScrollManual, true);
  assert.equal(player.getState().checkpointCount, checkpointsBefore);
  assert.equal(player.getState().checkpointIndex, checkpointsBefore - 1);

  await player.rewindToPreviousPause();
  assert.equal(
    session.getHistoryCursor(),
    before.historyCursor - 1,
    "Back reaches a pre-Apply reveal",
  );
  const replanned = await player.playContinuous(false);
  assert.equal(replanned.pause.kind, "single-step-team", "new Top N timing is used after rewind");
  assert.equal(session.getHistoryCursor(), before.historyCursor - 1);
  assert.equal(player.getState().timing, "single-step");

  await player.playToNextPause(false);
  await player.playToNextPause(false);
  assert.equal(session.getHistoryCursor(), before.historyCursor);
  assert.deepEqual(
    semanticSnapshot(session),
    before,
    "semantic redo remains exact under the new planner",
  );
});

test("runtime Apply after rewind drops stale future checkpoints but preserves semantic redo", async () => {
  const session = new ResolverSession(defaultPayload, {
    baseline: "beginning",
    tieOrder: "source",
  });
  const player = new ResolutionPlayer({
    session,
    planner: plannerFor(defaultPayload, session),
    wait: async () => {},
  });
  await player.fastForwardToNextPause();
  await player.fastForwardToNextPause();
  await player.fastForwardToNextPause();
  const thirdReveal = session.getState();
  await player.rewindToPreviousPause();
  assert.equal(session.getHistoryCursor(), 2);
  assert.equal(session.getHistoryLength(), 3);

  await player.reconfigure({
    planner: plannerFor(defaultPayload, session, { singleStepStartRank: 3 }),
  });
  assert.equal(player.getState().checkpointCount, 3, "future presentation checkpoints are removed");
  assert.equal(session.getHistoryLength(), 3, "semantic redo history is preserved");

  await player.playContinuous(false);
  await player.playToNextPause(false);
  await player.playToNextPause(false);
  assert.equal(session.getHistoryCursor(), 3);
  assert.deepEqual(session.getState(), thirdReveal);
});

test("baseline selection is distinguishable from runtime-safe settings and requires explicit restart", () => {
  const session = new ResolverSession(icpcPayload, { baseline: "official-freeze" });
  session.revealCell(101, 42);
  const before = semanticSnapshot(session);

  assert.equal(resolveResolverBaseline(icpcPayload, "auto"), "official-freeze");
  assert.equal(resolveResolverBaseline(icpcPayload, "beginning"), "beginning");
  assert.notEqual(resolveResolverBaseline(icpcPayload, "beginning"), session.baseline);
  assert.deepEqual(
    semanticSnapshot(session),
    before,
    "detecting restart does not mutate the session",
  );

  const restarted = new ResolverSession(icpcPayload, { baseline: "beginning" });
  assert.equal(restarted.getHistoryCursor(), 0);
  assert.equal(restarted.baseline, "beginning");
  assert.notDeepEqual(restarted.getState(), session.getState());
});

test("a manual action requested during an atomic autoplay reveal is queued and executed once", async () => {
  let busy = true;
  let cancelled = 0;
  let resolvable = true;
  const executed = [];
  const coordinator = new ManualActionCoordinator({
    cancelPlayback: () => {
      cancelled += 1;
    },
    isBusy: () => busy,
    execute: async (action) => {
      if (!resolvable) return null;
      resolvable = false;
      executed.push(action);
      return action;
    },
  });

  const queued = coordinator.request({ type: "problem", problemId: 101 });
  const repeated = coordinator.request({ type: "problem", problemId: 101 });
  assert.deepEqual(coordinator.getState().pending, { type: "problem", problemId: 101 });
  assert.equal(executed.length, 0);
  busy = false;
  await coordinator.flush();
  await Promise.all([queued, repeated]);

  assert.equal(cancelled, 2, "each presenter request immediately cancels autoplay");
  assert.deepEqual(executed, [{ type: "problem", problemId: 101 }]);
  assert.equal(coordinator.getState().pending, null);
  assert.equal(coordinator.getState().running, false);

  await coordinator.request({ type: "problem", problemId: 101 });
  assert.equal(executed.length, 1, "the target is revalidated before execution");
});

test("manual batch after an interrupted reveal has its own exact undo boundary", async () => {
  const session = new ResolverSession(defaultPayload, {
    baseline: "beginning",
    tieOrder: "source",
  });
  let player;
  player = new ResolutionPlayer({
    session,
    planner: plannerFor(defaultPayload, session),
    onStep: (step) => {
      if (step.type === RESOLUTION_STEP_TYPES.REVEAL_CELL) player.cancel("Manual request");
    },
  });
  await player.playContinuous(false);
  const interruptedState = session.getState();
  assert.equal(session.getHistoryCursor(), 1);
  assert.equal(player.getState().checkpointIndex, 0, "no narrative checkpoint yet");
  player.checkpointBeforeExternalChange("Manual batch");
  const checkpoints = player.getState().checkpointCount;
  player.checkpointBeforeExternalChange("Manual batch");
  assert.equal(player.getState().checkpointCount, checkpoints, "boundary is not duplicated");
  session.revealBatch(session.getResolvableCellsForContestant(11));
  await player.syncAfterExternalChange("Manual batch");
  assert.equal(session.getHistoryCursor(), 2);
  await player.rewindToPreviousPause();
  assert.equal(session.getHistoryCursor(), 1);
  assert.deepEqual(session.getState(), interruptedState);
});

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }
}

function fakeNode() {
  const properties = new Map();
  return {
    classList: new FakeClassList(),
    style: {
      setProperty: (key, value) => properties.set(key, value),
      removeProperty: (key) => properties.delete(key),
      getPropertyValue: (key) => properties.get(key) ?? "",
    },
  };
}

function fakeRow(problemIds) {
  const row = fakeNode();
  row._resolverRefs = {
    problemCells: new Map(problemIds.map((problemId) => [String(problemId), fakeNode()])),
  };
  return row;
}

test("yellow reveal attention highlights deduplicated rows and changed cells for 500 ms by default", async () => {
  assert.equal(DEFAULT_RESOLVER_SETTINGS.revealHighlightDurationMs, 500);
  const first = fakeRow(["A", "B"]);
  const second = fakeRow(["A", "B"]);
  const rows = new Map([
    ["1", first],
    ["2", second],
  ]);
  let waited = null;
  const animation = animateRevealHighlight(
    rows,
    [
      { contestantId: 1, problemId: "A" },
      { contestantId: 1, problemId: "B" },
      { contestantId: 1, problemId: "B" },
    ],
    undefined,
    {
      reducedMotion: false,
      wait: async (duration) => {
        waited = duration;
        assert.equal(first.classList.contains("resolver-row--reveal-highlight"), true);
        assert.equal(
          first._resolverRefs.problemCells
            .get("A")
            .classList.contains("resolver-cell--reveal-highlight"),
          true,
        );
      },
    },
  );
  const result = await animation;
  assert.deepEqual(result, { rows: 1, cells: 2 });
  assert.equal(waited, 500);
  assert.equal(first.classList.contains("resolver-row--reveal-highlight"), false);
  assert.equal(
    first._resolverRefs.problemCells.get("A").classList.contains("resolver-cell--reveal-highlight"),
    false,
  );

  const problemBatch = await animateRevealHighlight(
    rows,
    [
      { contestantId: 1, problemId: "A" },
      { contestantId: 2, problemId: "A" },
    ],
    250,
    {
      subtleRows: true,
      reducedMotion: false,
      wait: async () => {
        assert.equal(first.classList.contains("resolver-row--reveal-highlight-subtle"), true);
        assert.equal(second.classList.contains("resolver-row--reveal-highlight-subtle"), true);
      },
    },
  );
  assert.deepEqual(problemBatch, { rows: 2, cells: 2 });
});

test("highlight Off and reduced motion skip the attention animation cleanly", async () => {
  const row = fakeRow(["A"]);
  const rows = new Map([["1", row]]);
  let waits = 0;
  const wait = async () => {
    waits += 1;
  };
  assert.deepEqual(
    await animateRevealHighlight(rows, [{ contestantId: 1, problemId: "A" }], 0, {
      reducedMotion: false,
      wait,
    }),
    { rows: 0, cells: 0 },
  );
  assert.deepEqual(
    await animateRevealHighlight(rows, [{ contestantId: 1, problemId: "A" }], 1000, {
      reducedMotion: true,
      wait,
    }),
    { rows: 0, cells: 0 },
  );
  assert.equal(waits, 0);
});

test("smart row follow scrolls only outside the comfortable viewport band", () => {
  assert.equal(isRowWithinSafeViewport({ top: 250, bottom: 300 }, 1000), true);
  assert.equal(isRowWithinSafeViewport({ top: 40, bottom: 90 }, 1000), false);

  const calls = [];
  const visible = {
    getBoundingClientRect: () => ({ top: 250, bottom: 300 }),
    scrollIntoView: (options) => calls.push(options),
  };
  const outside = {
    getBoundingClientRect: () => ({ top: 920, bottom: 980 }),
    scrollIntoView: (options) => calls.push(options),
  };
  assert.equal(ensureRowVisible(visible, { viewportHeight: 1000 }), false);
  assert.equal(ensureRowVisible(outside, { viewportHeight: 1000 }), true);
  assert.deepEqual(calls, [{ block: "center", behavior: "smooth" }]);
});
