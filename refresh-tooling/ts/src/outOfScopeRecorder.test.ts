/**
 * Unit tests for the Out-of-Scope Recorder (Scope Control, CC scope review).
 *
 * Requirements covered: 16.5, 16.6.
 *
 * Feature: codebase-modernization-refresh
 */
import {
  OutOfScopeRecorder,
  createSeededOutOfScopeRecorder,
  SEEDED_OUT_OF_SCOPE_ENTRIES,
  NO_BEHAVIOR_PRESERVING_OPTION_INDICATION,
} from './outOfScopeRecorder';

describe('recordBehaviorAlteringChange (Req 16.5)', () => {
  it('records the change + reason as a behavior-altering-beyond-upgrade exclusion', () => {
    const recorder = new OutOfScopeRecorder();
    const entry = recorder.recordBehaviorAlteringChange({
      change: 'Refactor the cell router to a new routing algorithm',
      reason: 'Changes externally observable routing behavior beyond the version bump',
    });

    expect(entry.kind).toBe('behavior-altering-beyond-upgrade');
    expect(entry.requirement).toBe('16.5');
    expect(entry.change).toContain('cell router');
    expect(entry.reason).toContain('beyond');
    // the change is recorded, not applied: behavior is left unchanged
    expect(entry.behaviorUnchanged).toBe(true);
  });

  it('keeps the entry in the list and leaves behavior unchanged across the report', () => {
    const recorder = new OutOfScopeRecorder();
    recorder.recordBehaviorAlteringChange({ change: 'change A', reason: 'reason A' });
    const report = recorder.report();
    expect(report.entries).toHaveLength(1);
    expect(report.behaviorAlteringCount).toBe(1);
    expect(report.noBehaviorPreservingOptionCount).toBe(0);
    expect(report.behaviorPreserved).toBe(true);
  });
});

describe('recordNoBehaviorPreservingOption (Req 16.6)', () => {
  it('records the upgrade WITH the mandated no-behavior-preserving-option indication', () => {
    const recorder = new OutOfScopeRecorder();
    const entry = recorder.recordNoBehaviorPreservingOption({
      change: 'Upgrade dependency X to 5.0',
    });

    expect(entry.kind).toBe('no-behavior-preserving-option');
    expect(entry.requirement).toBe('16.6');
    expect(entry.reason).toBe(NO_BEHAVIOR_PRESERVING_OPTION_INDICATION);
    expect(entry.reason).toMatch(/no behavior-preserving option exists/i);
    expect(entry.behaviorUnchanged).toBe(true);
  });

  it('appends caller-supplied context to the mandated indication', () => {
    const recorder = new OutOfScopeRecorder();
    const entry = recorder.recordNoBehaviorPreservingOption({
      change: 'Upgrade dependency Y',
      reason: 'every 5.x release changes the public API shape.',
    });
    expect(entry.reason.startsWith(NO_BEHAVIOR_PRESERVING_OPTION_INDICATION)).toBe(true);
    expect(entry.reason).toContain('public API shape');
  });
});

describe('list / report aggregation', () => {
  it('counts both exclusion kinds and preserves insertion order', () => {
    const recorder = new OutOfScopeRecorder();
    recorder.recordBehaviorAlteringChange({ change: 'first', reason: 'r1' });
    recorder.recordNoBehaviorPreservingOption({ change: 'second' });
    recorder.recordBehaviorAlteringChange({ change: 'third', reason: 'r3' });

    const report = recorder.report();
    expect(report.entries.map((e) => e.change)).toEqual(['first', 'second', 'third']);
    expect(report.behaviorAlteringCount).toBe(2);
    expect(report.noBehaviorPreservingOptionCount).toBe(1);
    expect(report.behaviorPreserved).toBe(true);
  });

  it('entries() returns a defensive copy that cannot mutate the recorder', () => {
    const recorder = new OutOfScopeRecorder();
    recorder.recordBehaviorAlteringChange({ change: 'only', reason: 'r' });
    const list = recorder.entries();
    list.pop();
    expect(recorder.entries()).toHaveLength(1);
  });
});

describe('validation guards', () => {
  it('rejects a duplicate entry id', () => {
    const recorder = new OutOfScopeRecorder();
    recorder.recordBehaviorAlteringChange({ id: 'dup', change: 'a', reason: 'r' });
    expect(() =>
      recorder.recordBehaviorAlteringChange({ id: 'dup', change: 'b', reason: 'r' })
    ).toThrow(/already recorded/);
  });

  it('rejects an empty change or reason', () => {
    const recorder = new OutOfScopeRecorder();
    expect(() =>
      recorder.recordBehaviorAlteringChange({ change: '   ', reason: 'r' })
    ).toThrow(/change/);
    expect(() =>
      recorder.recordBehaviorAlteringChange({ change: 'c', reason: '' })
    ).toThrow(/reason/);
  });
});

describe('seeded planning exclusions', () => {
  it('seeds the already-identified out-of-scope items with reasons', () => {
    const recorder = createSeededOutOfScopeRecorder();
    const report = recorder.report();

    expect(report.entries.length).toBe(SEEDED_OUT_OF_SCOPE_ENTRIES.length);
    expect(report.behaviorPreserved).toBe(true);

    const ids = report.entries.map((e) => e.id);
    expect(ids).toContain('lambda-python-314-forward-move');
    expect(ids).toContain('vscode-server-drop-ubuntu-22');

    // each seeded entry records both a change and a reason (Req 16.5)
    for (const e of report.entries) {
      expect(e.change.length).toBeGreaterThan(0);
      expect(e.reason.length).toBeGreaterThan(0);
      expect(e.behaviorUnchanged).toBe(true);
    }
  });

  it('the Python 3.14 forward-move is recorded as behavior-altering-beyond-upgrade', () => {
    const recorder = createSeededOutOfScopeRecorder();
    const entry = recorder
      .entries()
      .find((e) => e.id === 'lambda-python-314-forward-move');
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe('behavior-altering-beyond-upgrade');
    expect(entry?.reason).toMatch(/3\.14/);
  });

  it('allows recording further exclusions on top of the seed', () => {
    const recorder = createSeededOutOfScopeRecorder();
    recorder.recordNoBehaviorPreservingOption({ change: 'late discovery' });
    expect(recorder.report().noBehaviorPreservingOptionCount).toBe(1);
    expect(recorder.entries().length).toBe(SEEDED_OUT_OF_SCOPE_ENTRIES.length + 1);
  });
});
