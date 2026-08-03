import assert from "node:assert/strict";
import test from "node:test";

import { positionAdvCubismMotionQueueEntry } from "../../src/web-runtime/rendering/cubism/AdvCubismMotionPosition.ts";

class TestMotion {
  constructor(duration, loopDuration = duration) {
    this.duration = duration;
    this.loopDuration = loopDuration;
    this.loop = false;
    this.began = null;
  }

  getDuration() {
    return this.duration;
  }

  getLoopDuration() {
    return this.loopDuration;
  }

  getLoop() {
    return this.loop;
  }

  setBeganMotionHandler(callback) {
    this.began = callback;
  }

  setupMotionQueueEntry(entry, now) {
    if (entry.isStarted()) return;
    entry.setIsStarted(true);
    entry.setStartTime(now);
    entry.setFadeInStartTime(now);
    entry.setEndTime(this.duration > 0 ? now + this.duration : -1);
    this.began?.(this);
  }
}

function entryFor(motion) {
  let started = false;
  let start = -1;
  let fadeInStart = 0;
  let end = -1;
  let lastEventCheck = 0;
  return {
    _motion: motion,
    isStarted: () => started,
    setIsStarted: (value) => { started = value; },
    getStartTime: () => start,
    setStartTime: (value) => { start = value; },
    getFadeInStartTime: () => fadeInStart,
    setFadeInStartTime: (value) => { fadeInStart = value; },
    getEndTime: () => end,
    setEndTime: (value) => { end = value; },
    getLastCheckEventSeconds: () => lastEventCheck,
    setLastCheckEventSeconds: (value) => { lastEventCheck = value; },
  };
}

test("absolute motion positioning rebases start, fade, end and event clocks", () => {
  const motion = new TestMotion(8);
  const entry = entryFor(motion);
  let began = 0;
  motion.setBeganMotionHandler(() => { began += 1; });

  const position = positionAdvCubismMotionQueueEntry(entry, motion, 12, 3.25);

  assert.equal(position, 3.25);
  assert.equal(began, 1);
  assert.equal(entry.isStarted(), true);
  assert.equal(entry.getStartTime(), 8.75);
  assert.equal(entry.getFadeInStartTime(), 8.75);
  assert.equal(entry.getEndTime(), 16.75);
  assert.equal(entry.getLastCheckEventSeconds(), 12);
});

test("loop restore wraps phase without mutating the cached motion loop mode", () => {
  const motion = new TestMotion(4);
  const entry = entryFor(motion);

  const position = positionAdvCubismMotionQueueEntry(entry, motion, 10, 9.5, { loop: true });

  assert.equal(position, 1.5);
  assert.equal(entry.getStartTime(), 8.5);
  assert.equal(entry.getEndTime(), 12.5);
  assert.equal(motion.getLoop(), false);
});

test("non-loop restore keeps an absolute phase and sanitizes invalid clocks", () => {
  const motion = new TestMotion(4);
  const absolute = entryFor(motion);
  const sanitized = entryFor(motion);

  assert.equal(positionAdvCubismMotionQueueEntry(absolute, motion, 10, 9.5), 9.5);
  assert.equal(absolute.getStartTime(), 0.5);
  assert.equal(absolute.getEndTime(), 4.5);

  assert.equal(positionAdvCubismMotionQueueEntry(sanitized, motion, Number.NaN, -2), 0);
  assert.equal(sanitized.getStartTime(), 0);
  assert.equal(sanitized.getFadeInStartTime(), 0);
  assert.equal(sanitized.getEndTime(), 4);
});
