/**
 * Out-of-Scope Recorder for scope control (Design Component 16 / Scope Control, CC scope review).
 *
 * Maintains the refresh's out-of-scope list: a record of every change or upgrade
 * that is EXCLUDED from the behavior-preserving refresh, together with the reason
 * for the exclusion. The recorder never applies anything — recording an entry is
 * the deliverable, and existing behavior is left unchanged by construction.
 *
 * Behavior (Requirements 16.5, 16.6):
 *   - 16.5: IF a proposed change alters externally observable functional behavior
 *     beyond what an upgrade requires, THEN the change is EXCLUDED and recorded in
 *     the out-of-scope list identifying the change and the reason for exclusion,
 *     while leaving existing behavior unchanged. Recorded via
 *     {@link OutOfScopeRecorder.recordBehaviorAlteringChange} (kind
 *     `behavior-altering-beyond-upgrade`).
 *   - 16.6: IF a required security or version upgrade has no available option that
 *     preserves externally observable functional behavior, THEN the upgrade is
 *     EXCLUDED and recorded in the out-of-scope list WITH an indication that no
 *     behavior-preserving option exists. Recorded via
 *     {@link OutOfScopeRecorder.recordNoBehaviorPreservingOption} (kind
 *     `no-behavior-preserving-option`).
 *
 * Scope-control invariant: because an out-of-scope entry is a record of an
 * exclusion (the change/upgrade is NOT applied), every entry carries
 * `behaviorUnchanged: true`, and the aggregate report's `behaviorPreserved` flag
 * is true whenever the list holds only recorded (un-applied) exclusions.
 *
 * Interface: `recordBehaviorAlteringChange(...)`, `recordNoBehaviorPreservingOption(...)`,
 * `add(entry)`, `entries()`, `report() -> OutOfScopeReport`.
 *
 * Feature: codebase-modernization-refresh
 */
import type { OutOfScopeEntry, OutOfScopeReport } from './models';

/** Input for recording a Req 16.5 behavior-altering-beyond-upgrade exclusion. */
export interface BehaviorAlteringChangeInput {
  /** the proposed change that is excluded */
  change: string;
  /** why the change alters behavior beyond what the upgrade requires */
  reason: string;
  /** optional explicit id; a slug is derived from the change when omitted */
  id?: string;
}

/** Input for recording a Req 16.6 no-behavior-preserving-option exclusion. */
export interface NoBehaviorPreservingOptionInput {
  /** the required security/version upgrade that is excluded */
  change: string;
  /**
   * optional extra context appended to the mandated "no behavior-preserving
   * option exists" indication.
   */
  reason?: string;
  /** optional explicit id; a slug is derived from the change when omitted */
  id?: string;
}

/** The exact indication Req 16.6 mandates be recorded for an excluded upgrade. */
export const NO_BEHAVIOR_PRESERVING_OPTION_INDICATION =
  'No behavior-preserving option exists for this upgrade.';

/** Derive a stable, readable slug id from free text (deterministic). */
function slug(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base.length > 0 ? base : 'entry';
}

/**
 * Recorder for the out-of-scope list. Entries are immutable once added; the
 * recorder rejects a duplicate id so the list stays a clean record. The instance
 * holds the list in insertion order.
 */
export class OutOfScopeRecorder {
  private readonly _entries: OutOfScopeEntry[] = [];
  private readonly _ids = new Set<string>();

  /** Construct a recorder, optionally seeded with already-identified entries. */
  constructor(seed: OutOfScopeEntry[] = []) {
    for (const e of seed) {
      this.add(e);
    }
  }

  /** Add a fully-formed entry, enforcing the scope-control invariant and id uniqueness. */
  add(entry: OutOfScopeEntry): OutOfScopeEntry {
    if (this._ids.has(entry.id)) {
      throw new Error(`out-of-scope entry id already recorded: ${entry.id}`);
    }
    if (entry.change.trim().length === 0) {
      throw new Error('out-of-scope entry requires a non-empty change description');
    }
    if (entry.reason.trim().length === 0) {
      throw new Error('out-of-scope entry requires a non-empty reason');
    }
    // The change is recorded, not applied: behavior is always left unchanged.
    const recorded: OutOfScopeEntry = { ...entry, behaviorUnchanged: true };
    this._entries.push(recorded);
    this._ids.add(recorded.id);
    return recorded;
  }

  /**
   * Record a Req 16.5 exclusion: a change that alters externally observable
   * behavior beyond what an upgrade requires. The change is excluded (not applied)
   * and recorded with its reason; existing behavior is left unchanged.
   */
  recordBehaviorAlteringChange(input: BehaviorAlteringChangeInput): OutOfScopeEntry {
    return this.add({
      id: input.id ?? slug(input.change),
      kind: 'behavior-altering-beyond-upgrade',
      change: input.change,
      reason: input.reason,
      behaviorUnchanged: true,
      requirement: '16.5',
    });
  }

  /**
   * Record a Req 16.6 exclusion: a required security/version upgrade for which no
   * behavior-preserving option exists. The upgrade is excluded (not applied) and
   * recorded WITH the mandated "no behavior-preserving option exists" indication;
   * any caller-supplied context is appended to that indication.
   */
  recordNoBehaviorPreservingOption(
    input: NoBehaviorPreservingOptionInput
  ): OutOfScopeEntry {
    const reason = input.reason
      ? `${NO_BEHAVIOR_PRESERVING_OPTION_INDICATION} ${input.reason}`
      : NO_BEHAVIOR_PRESERVING_OPTION_INDICATION;
    return this.add({
      id: input.id ?? slug(input.change),
      kind: 'no-behavior-preserving-option',
      change: input.change,
      reason,
      behaviorUnchanged: true,
      requirement: '16.6',
    });
  }

  /** The recorded entries, in insertion order (defensive copy). */
  entries(): OutOfScopeEntry[] {
    return [...this._entries];
  }

  /**
   * Produce the aggregate out-of-scope list / report (Req 16.5, 16.6). The
   * `behaviorPreserved` flag asserts the scope-control contract: every recorded
   * entry leaves behavior unchanged (the change was recorded, not applied).
   */
  report(): OutOfScopeReport {
    const entries = this.entries();
    return {
      entries,
      behaviorAlteringCount: entries.filter(
        (e) => e.kind === 'behavior-altering-beyond-upgrade'
      ).length,
      noBehaviorPreservingOptionCount: entries.filter(
        (e) => e.kind === 'no-behavior-preserving-option'
      ).length,
      behaviorPreserved: entries.every((e) => e.behaviorUnchanged === true),
    };
  }
}

/**
 * The out-of-scope items already identified during planning of this refresh,
 * seeded as documented exclusions with their reasons (per the design's Target
 * Version Matrix and assumption log).
 *
 * These are OPTIONAL forward-moves / deferred bumps that would change behavior or
 * environment beyond the minimal behavior-preserving objective; they are recorded,
 * not applied, leaving the refresh behavior unchanged (Req 16.5).
 */
export const SEEDED_OUT_OF_SCOPE_ENTRIES: OutOfScopeEntry[] = [
  {
    id: 'lambda-python-314-forward-move',
    kind: 'behavior-altering-beyond-upgrade',
    change:
      'Move the Lambda Python runtime (LambdaFunctionConstruct.ts) and the Flask ' +
      'container from Python 3.13 to Python 3.14.',
    reason:
      'Python 3.14 is GA in Lambda (Nov 2025) and is an OPTIONAL forward move ' +
      '[maintainer-confirm], not required by the refresh. The in-scope defect is the ' +
      'Flask container/Lambda runtime mismatch; the minimal behavior-preserving fix ' +
      'retains 3.13 and aligns the container to it. A 3.13 -> 3.14 jump exceeds the ' +
      'upgrade objective and could alter runtime behavior, so it is excluded pending ' +
      'maintainer confirmation.',
    behaviorUnchanged: true,
    requirement: '16.5',
  },
  {
    id: 'cdk-nag-3x-major-bump',
    kind: 'behavior-altering-beyond-upgrade',
    change: 'Adopt cdk-nag 3.x (major version bump from the selected 2.38.2).',
    reason:
      'cdk-nag 3.0.1 is published and peer-compatible with aws-cdk-lib 2.260.0, but a ' +
      'major bump can introduce new/changed nag rules that alter the set of reported ' +
      'findings. To preserve behavior the refresh pins the latest 2.x (2.38.2); ' +
      'adopting 3.x is deferred to maintainer review and excluded from this refresh.',
    behaviorUnchanged: true,
    requirement: '16.5',
  },
  {
    id: 'vscode-server-drop-ubuntu-22',
    kind: 'behavior-altering-beyond-upgrade',
    change:
      "Drop 'Ubuntu-22' from the vscode-server InstanceOperatingSystem allowed-values list.",
    reason:
      'Ubuntu-22 may be dropped in favor of Ubuntu-24, but both remain supported, so ' +
      'retention is the behavior-preserving choice (it does not change the default or ' +
      'remove an EOL option). Narrowing the allowed list alters the environment options ' +
      'offered to participants beyond the upgrade need [confirm], so the drop is recorded ' +
      'as out-of-scope pending maintainer decision (Req 17.1, 17.9).',
    behaviorUnchanged: true,
    requirement: '16.5',
  },
];

/**
 * Build a recorder seeded with the already-identified planning exclusions
 * ({@link SEEDED_OUT_OF_SCOPE_ENTRIES}). Callers may continue to record further
 * exclusions discovered during execution.
 */
export function createSeededOutOfScopeRecorder(): OutOfScopeRecorder {
  return new OutOfScopeRecorder(SEEDED_OUT_OF_SCOPE_ENTRIES);
}
