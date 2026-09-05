import { effectiveDelay, RESOLUTION_STEP_TYPES } from "./timing.js";
import { gettext } from "./i18n.js";
import { clone } from "./utils.js";

const RESULT_TYPES = new Set([
  RESOLUTION_STEP_TYPES.RESULT_MOVE,
  RESOLUTION_STEP_TYPES.RESULT_STAY,
  RESOLUTION_STEP_TYPES.RESULT_FAILED,
]);

function sameTarget(left, right) {
  return (
    left &&
    right &&
    String(left.contestantId) === String(right.contestantId) &&
    String(left.problemId) === String(right.problemId)
  );
}

function createDelay(durationMs) {
  let timer = null;
  let finish = null;
  return {
    promise: new Promise((resolve) => {
      finish = resolve;
      timer = globalThis.setTimeout(resolve, durationMs);
    }),
    cancel() {
      if (timer !== null) {
        globalThis.clearTimeout(timer);
        timer = null;
        finish();
      }
    },
  };
}

function initialPresentation() {
  return {
    selectedContestantId: null,
    selectedProblemId: null,
    resultType: null,
  };
}

export class ResolutionPlayer {
  constructor({
    session,
    planner,
    playbackSpeed = 1,
    wait = null,
    onBeforeStep = async () => null,
    onStep = async () => {},
    onRestore = async () => {},
    onChange = () => {},
  }) {
    this.session = session;
    this.planner = planner;
    this.playbackSpeed = playbackSpeed;
    this.wait = wait;
    this.onBeforeStep = onBeforeStep;
    this.onStep = onStep;
    this.onRestore = onRestore;
    this.onChange = onChange;

    this.running = false;
    this.complete = this.session.getResolvableCount() === 0;
    this.pauseKind = "idle";
    this.pauseReason = null;
    this.presentation = initialPresentation();
    this._plan = null;
    this._cursor = 0;
    this._runSerial = 0;
    this._activeDelay = null;
    this._activeRun = null;
    this._milestones = { awardZoneEntered: false };
    this._checkpoints = [this._makeCheckpoint("beginning", gettext("Resolver beginning"))];
    this._checkpointIndex = 0;
    this._atCheckpoint = true;
  }

  _makeCheckpoint(kind, reason) {
    return {
      kind,
      reason,
      historyCursor: this.session.getHistoryCursor(),
      plan: this._plan,
      cursor: this._cursor,
      presentation: clone(this.presentation),
      milestones: clone(this._milestones),
    };
  }

  _notify() {
    this.onChange(this.getState());
  }

  getState() {
    return {
      running: this.running,
      complete: this.complete,
      pauseKind: this.pauseKind,
      pauseReason: this.pauseReason,
      playbackSpeed: this.playbackSpeed,
      presentation: clone(this.presentation),
      checkpointIndex: this._checkpointIndex,
      checkpointCount: this._checkpoints.length,
      timing: this._plan?.timing ?? null,
      projection: this._plan
        ? {
            ...this._plan.metadata,
            projection: undefined,
          }
        : null,
      milestones: clone(this._milestones),
    };
  }

  getPlanningContext() {
    return clone(this._milestones);
  }

  setSpeed(playbackSpeed) {
    const speed = Number(playbackSpeed);
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new RangeError(gettext("Resolver playback speed must be greater than zero."));
    }
    this.playbackSpeed = speed;
    this._notify();
    return this.getState();
  }

  cancel(reason = gettext("Playback paused."), kind = "operator") {
    this._runSerial += 1;
    this.running = false;
    this.pauseKind = kind;
    this.pauseReason = reason;
    if (this._activeDelay) {
      this._activeDelay.cancel();
      this._activeDelay = null;
    }
    this._notify();
  }

  async _wait(durationMs, serial) {
    if (this.wait) {
      await this.wait(durationMs);
      return;
    }
    this._activeDelay = createDelay(durationMs);
    await this._activeDelay.promise;
    if (serial === this._runSerial) {
      this._activeDelay = null;
    }
  }

  _updatePresentation(step) {
    if (step.type === RESOLUTION_STEP_TYPES.SELECT_TEAM) {
      this.presentation.selectedContestantId = step.target.contestantId;
      this.presentation.selectedProblemId = null;
      this.presentation.resultType = null;
    } else if (step.type === RESOLUTION_STEP_TYPES.SELECT_PROBLEM) {
      this.presentation.selectedContestantId = step.target.contestantId;
      this.presentation.selectedProblemId = step.target.problemId;
      this.presentation.resultType = null;
    } else if (RESULT_TYPES.has(step.type)) {
      this.presentation.resultType = step.type;
    } else if (step.type === RESOLUTION_STEP_TYPES.DESELECT) {
      this.presentation = initialPresentation();
    }
  }

  _applyReveal(target) {
    const redo = this.session.getRedoTransition();
    if (redo && sameTarget(redo.target, target)) {
      this.session.forward();
      return redo;
    }
    const projection = this._plan?.metadata?.projection;
    if (
      projection &&
      sameTarget(projection.target, target) &&
      projection.revision === this.session.getRevision()
    ) {
      return this.session.commitProjection(projection);
    }
    return this.session.revealCell(target.contestantId, target.problemId);
  }

  _recordPause(step) {
    if (this._checkpointIndex < this._checkpoints.length - 1) {
      this._checkpoints.splice(this._checkpointIndex + 1);
    }
    this._checkpoints.push(this._makeCheckpoint(step.kind, step.reason));
    this._checkpointIndex = this._checkpoints.length - 1;
    this._atCheckpoint = true;
  }

  async _executeStep(step, includeDelays, serial) {
    if (step.type === RESOLUTION_STEP_TYPES.DELAY) {
      if (includeDelays && step.durationMs > 0) {
        await this._wait(effectiveDelay(step.durationMs, this.playbackSpeed), serial);
      }
      return null;
    }

    const beforeContext = await this.onBeforeStep(step, {
      plan: this._plan,
      presentation: clone(this.presentation),
    });
    let transition = null;
    if (step.type === RESOLUTION_STEP_TYPES.REVEAL_CELL) {
      transition = this._applyReveal(step.target);
      if (!transition) {
        throw new Error(gettext("Resolution plan targeted a cell that is no longer resolvable."));
      }
    }
    this._updatePresentation(step);
    await this.onStep(step, {
      beforeContext,
      plan: this._plan,
      presentation: clone(this.presentation),
      transition,
    });

    if (step.type === RESOLUTION_STEP_TYPES.PAUSE) {
      if (step.milestone) {
        this._milestones[step.milestone] = true;
      }
      this.pauseKind = step.kind;
      this.pauseReason = step.reason;
      this._recordPause(step);
      return step;
    }
    return null;
  }

  async _run(serial, includeDelays, stopAt) {
    while (serial === this._runSerial) {
      if (!this._plan || this._cursor >= this._plan.steps.length) {
        this._plan = this.planner.planNext(this.session, this.getPlanningContext());
        this._cursor = 0;
        if (!this._plan) {
          this.complete = true;
          this.pauseKind = "complete";
          this.pauseReason = gettext("Resolver complete — final standings reached.");
          return { complete: true, pause: null };
        }
      }

      const step = this._plan.steps[this._cursor];
      this._cursor += 1;
      if (step.type !== RESOLUTION_STEP_TYPES.PAUSE) {
        this._atCheckpoint = false;
      }
      const pause = await this._executeStep(step, includeDelays, serial);
      if (serial !== this._runSerial) {
        return { complete: false, cancelled: true, pause: null };
      }
      if (pause && (stopAt === "any" || pause.hard === true)) {
        return { complete: false, pause };
      }
    }
    return { complete: false, cancelled: true, pause: null };
  }

  _startRun(includeDelays, stopAt) {
    if (this.running) {
      return this._activeRun;
    }
    this.running = true;
    this.complete = false;
    this.pauseKind = null;
    this.pauseReason = null;
    this._atCheckpoint = false;
    const serial = ++this._runSerial;
    this._notify();
    const activeRun = this._run(serial, includeDelays, stopAt).finally(() => {
      if (serial === this._runSerial) {
        this.running = false;
        this._notify();
      }
      if (this._activeRun === activeRun) {
        this._activeRun = null;
      }
    });
    this._activeRun = activeRun;
    return this._activeRun;
  }

  playContinuous(includeDelays = true) {
    return this._startRun(includeDelays, "hard");
  }

  playToNextPause(includeDelays = true) {
    return this._startRun(includeDelays, "any");
  }

  fastForwardToNextPause() {
    return this.playToNextPause(false);
  }

  _restoreHistoryCursor(targetCursor) {
    while (this.session.getHistoryCursor() > targetCursor) {
      if (!this.session.back()) {
        throw new Error(gettext("Unable to rewind Resolver history to the requested pause."));
      }
    }
    while (this.session.getHistoryCursor() < targetCursor) {
      if (!this.session.forward()) {
        throw new Error(gettext("Unable to replay Resolver history to the requested pause."));
      }
    }
  }

  async rewindToPreviousPause() {
    if (this.running) {
      this.cancel(gettext("Playback paused for rewind."), "operator");
    }
    const targetIndex = this._atCheckpoint
      ? Math.max(0, this._checkpointIndex - 1)
      : this._checkpointIndex;
    const checkpoint = this._checkpoints[targetIndex];
    this._restoreHistoryCursor(checkpoint.historyCursor);
    this._plan = checkpoint.plan;
    this._cursor = checkpoint.cursor;
    this.presentation = clone(checkpoint.presentation);
    this._milestones = clone(checkpoint.milestones ?? { awardZoneEntered: false });
    this.complete = false;
    this.pauseKind = checkpoint.kind;
    this.pauseReason = checkpoint.reason;
    this._checkpointIndex = targetIndex;
    this._atCheckpoint = true;
    await this.onRestore(this.getState());
    this._notify();
    return this.getState();
  }

  async resetToBeginning() {
    if (this.running) {
      this.cancel(gettext("Playback reset."), "operator");
    }
    this.session.reset();
    this._plan = null;
    this._cursor = 0;
    this.presentation = initialPresentation();
    this._milestones = { awardZoneEntered: false };
    this.complete = false;
    this.pauseKind = "beginning";
    this.pauseReason = gettext("Resolver beginning");
    this._checkpoints = [this._makeCheckpoint("beginning", gettext("Resolver beginning"))];
    this._checkpointIndex = 0;
    this._atCheckpoint = true;
    await this.onRestore(this.getState());
    this._notify();
    return this.getState();
  }

  async reconfigure({
    planner = this.planner,
    playbackSpeed = this.playbackSpeed,
    resetAwardZoneMilestone = false,
    reason = gettext("Resolver settings applied."),
  } = {}) {
    if (this.running) {
      this.cancel(gettext("Playback paused while applying settings."), "settings");
    }
    const activeRun = this._activeRun;
    if (activeRun) {
      await activeRun;
    }
    const speed = Number(playbackSpeed);
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new RangeError(gettext("Resolver playback speed must be greater than zero."));
    }
    this.planner = planner;
    this.playbackSpeed = speed;
    if (this._checkpointIndex < this._checkpoints.length - 1) {
      this._checkpoints.splice(this._checkpointIndex + 1);
    }
    const currentHistoryCursor = this.session.getHistoryCursor();
    const replaceCurrentCheckpoint =
      this._checkpoints[this._checkpointIndex]?.historyCursor === currentHistoryCursor;
    this._checkpoints.forEach((checkpoint) => {
      checkpoint.plan = null;
      checkpoint.cursor = 0;
      if (resetAwardZoneMilestone) {
        checkpoint.milestones = { awardZoneEntered: false };
      }
    });
    this._plan = null;
    this._cursor = 0;
    this.presentation = initialPresentation();
    this.complete = this.session.getResolvableCount() === 0;
    this.pauseKind = "settings";
    this.pauseReason = reason;
    if (resetAwardZoneMilestone) {
      this._milestones = { awardZoneEntered: false };
    }
    const settingsCheckpoint = this._makeCheckpoint("settings", reason);
    if (replaceCurrentCheckpoint) {
      this._checkpoints[this._checkpointIndex] = settingsCheckpoint;
    } else {
      this._checkpoints.push(settingsCheckpoint);
      this._checkpointIndex = this._checkpoints.length - 1;
    }
    this._atCheckpoint = true;
    await this.onRestore(this.getState());
    this._notify();
    return this.getState();
  }

  checkpointBeforeExternalChange(reason) {
    // An operator can interrupt a reveal before its narrative pause is recorded.
    // Preserve that already-committed reveal so undoing the manual batch only
    // undoes the batch, rather than also removing the interrupted reveal.
    if (
      this._checkpoints[this._checkpointIndex]?.historyCursor !== this.session.getHistoryCursor()
    ) {
      this._recordPause({ kind: "before-manual", reason });
    }
  }

  async syncAfterExternalChange(reason = gettext("Resolver state changed manually.")) {
    if (this.running) {
      this.cancel(reason, "manual");
    }
    this._plan = null;
    this._cursor = 0;
    this.presentation = initialPresentation();
    this.complete = this.session.getResolvableCount() === 0;
    this.pauseKind = "manual";
    this.pauseReason = reason;
    if (this._checkpointIndex < this._checkpoints.length - 1) {
      this._checkpoints.splice(this._checkpointIndex + 1);
    }
    this._checkpoints.push(this._makeCheckpoint("manual", reason));
    this._checkpointIndex = this._checkpoints.length - 1;
    this._atCheckpoint = true;
    await this.onRestore(this.getState());
    this._notify();
    return this.getState();
  }
}
