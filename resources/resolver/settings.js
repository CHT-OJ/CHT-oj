import {
  clampSpeedIndex,
  normalizeAwardPlaces,
  normalizeSingleStepStartRank,
} from "./controller.js";

export const REVEAL_HIGHLIGHT_DURATIONS_MS = Object.freeze([0, 250, 500, 750, 1000]);
export const REVEAL_HOLD_DURATIONS_MS = Object.freeze([0, 250, 500, 750, 1000]);

export const DEFAULT_RESOLVER_SETTINGS = Object.freeze({
  baseline: "auto",
  speedIndex: 1,
  autoplayAfterStart: true,
  revealHighlightDurationMs: 500,
  revealHoldDurationMs: 500,
  autoScrollAutomatic: true,
  autoScrollManual: true,
  singleStepStartRank: 0,
  awardPlaces: 0,
  pauseAward: false,
  pauseFirstSolve: false,
});

function normalizeBoolean(value, fallback) {
  return value === undefined ? fallback : value === true;
}

export function normalizeRevealHighlightDuration(value) {
  const numeric = Number(value);
  return REVEAL_HIGHLIGHT_DURATIONS_MS.includes(numeric)
    ? numeric
    : DEFAULT_RESOLVER_SETTINGS.revealHighlightDurationMs;
}

export function normalizeResolverSettings(values = {}, contestantCount = 0) {
  return {
    baseline: ["auto", "beginning", "official-freeze"].includes(values.baseline)
      ? values.baseline
      : DEFAULT_RESOLVER_SETTINGS.baseline,
    speedIndex: clampSpeedIndex(values.speedIndex ?? DEFAULT_RESOLVER_SETTINGS.speedIndex),
    autoplayAfterStart: normalizeBoolean(
      values.autoplayAfterStart,
      DEFAULT_RESOLVER_SETTINGS.autoplayAfterStart,
    ),
    revealHighlightDurationMs: normalizeRevealHighlightDuration(values.revealHighlightDurationMs),
    revealHoldDurationMs: REVEAL_HOLD_DURATIONS_MS.includes(Number(values.revealHoldDurationMs))
      ? Number(values.revealHoldDurationMs)
      : DEFAULT_RESOLVER_SETTINGS.revealHoldDurationMs,
    autoScrollAutomatic: normalizeBoolean(
      values.autoScrollAutomatic,
      DEFAULT_RESOLVER_SETTINGS.autoScrollAutomatic,
    ),
    autoScrollManual: normalizeBoolean(
      values.autoScrollManual,
      DEFAULT_RESOLVER_SETTINGS.autoScrollManual,
    ),
    singleStepStartRank: normalizeSingleStepStartRank(values.singleStepStartRank, contestantCount),
    awardPlaces: normalizeAwardPlaces(values.awardPlaces, contestantCount),
    pauseAward: normalizeBoolean(values.pauseAward, DEFAULT_RESOLVER_SETTINGS.pauseAward),
    pauseFirstSolve: normalizeBoolean(
      values.pauseFirstSolve,
      DEFAULT_RESOLVER_SETTINGS.pauseFirstSolve,
    ),
  };
}

export function cloneResolverSettings(settings) {
  return { ...settings };
}

export class ResolverSettingsManager {
  constructor(settings = DEFAULT_RESOLVER_SETTINGS, contestantCount = 0) {
    this.contestantCount = contestantCount;
    this.active = normalizeResolverSettings(settings, contestantCount);
    this.draft = cloneResolverSettings(this.active);
    this.editing = false;
  }

  beginEdit() {
    this.draft = cloneResolverSettings(this.active);
    this.editing = true;
    return this.getDraft();
  }

  updateDraft(values) {
    this.draft = normalizeResolverSettings({ ...this.draft, ...values }, this.contestantCount);
    return this.getDraft();
  }

  cancelEdit() {
    this.draft = cloneResolverSettings(this.active);
    this.editing = false;
    return this.getActive();
  }

  commitDraft(values = this.draft) {
    this.active = normalizeResolverSettings(values, this.contestantCount);
    this.draft = cloneResolverSettings(this.active);
    this.editing = false;
    return this.getActive();
  }

  getActive() {
    return cloneResolverSettings(this.active);
  }

  getDraft() {
    return cloneResolverSettings(this.draft);
  }
}
