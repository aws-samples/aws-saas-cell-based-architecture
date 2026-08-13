/**
 * Property-based tests for the Answer-Key Synchronizer + byte-comparator
 * (Design Component 9 sub-component, CC10: "Answer-key lockstep across four
 * locations"), task 14.3.
 *
 * Feature: codebase-modernization-refresh, Property 11
 *
 * Property 11: Answer-key content equivalence across four locations
 * Validates: Requirements 14.2, 14.3, 14.4, 14.5 (and the 14.6 completion gate)
 *
 * For an arbitrary refreshed source content and four copies (markdown,
 * staticSolution, solutionZip, repoSolution) — each INDEPENDENTLY equal,
 * divergent, or absent — `syncAnswerKey` MUST report:
 *
 *   - allByteIdentical === true  IFF  all four copies are present and each is
 *     byte-for-byte identical to the refreshed source (Req 14.2, 14.3);
 *   - every present-but-differing copy appears in `divergentLocations` (Req 14.4);
 *   - every absent copy appears in `missingLocations` (Req 14.5);
 *   - isActivityComplete === true  IFF  there are no missing and no divergent
 *     copies (Req 14.6).
 *
 * The expected outcome for each location is derived directly from the generated
 * intent (equal | divergent | absent) — NOT by calling `compareToSource` — so
 * the property is a genuine cross-check of the aggregator rather than a
 * tautology. Generators emit adversarial byte content: empty strings, ASCII,
 * whitespace-only, embedded newlines, multi-byte unicode/emoji, and divergences
 * that are deliberately subtle (a single flipped byte, an added trailing space,
 * an added newline, a homoglyph/unicode tweak).
 */
import fc from 'fast-check';
import {
  ANSWER_KEY_LOCATIONS,
  syncAnswerKey,
  isActivityComplete,
  isSyncFailure,
  syncFailureMessages,
  toBuffer,
  type AnswerKeyLocation,
  type AnswerKeyCopies,
  type CopyContent,
} from './answerKeySynchronizer';

/* --------------------------------- Generators --------------------------------- */

/** Per-location intent: how the generated copy relates to the refreshed source. */
type CopyIntent = 'equal' | 'divergent' | 'absent';

/**
 * Adversarial refreshed-source content. A mix of empty/ascii/whitespace/newline
 * and full-unicode (multi-byte) strings so byte-level comparison is stressed.
 */
const sourceArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  fc.constant(' '),
  fc.constant('\n'),
  fc.constant('export const cell = 42;'),
  fc.string(),
  fc.fullUnicodeString(),
  fc.constantFrom(
    'café',
    'naïve',
    '🚀🌟',
    'tab\there',
    'line1\nline2\n',
    'mixed 🚀 café\tval\r\n'
  )
);

/**
 * Produce a copy buffer guaranteed to differ byte-for-byte from `source`,
 * applying a deliberately subtle mutation. Falls back to appending a byte so the
 * result is ALWAYS different even for empty or pathological sources.
 */
function makeDivergent(source: Buffer, kind: number): Buffer {
  let out: Buffer;
  switch (kind % 5) {
    case 0:
      // Trailing whitespace (subtle, easy to miss visually).
      out = Buffer.concat([source, Buffer.from(' ')]);
      break;
    case 1:
      // Trailing newline.
      out = Buffer.concat([source, Buffer.from('\n')]);
      break;
    case 2:
      // Flip the last byte if there is one.
      if (source.length > 0) {
        out = Buffer.from(source);
        out[out.length - 1] = out[out.length - 1] ^ 0x01;
      } else {
        out = Buffer.from('x');
      }
      break;
    case 3:
      // Inject a multi-byte unicode codepoint.
      out = Buffer.concat([source, Buffer.from('é', 'utf8')]);
      break;
    default:
      // Prepend a zero byte.
      out = Buffer.concat([Buffer.from([0x00]), source]);
      break;
  }
  // Guarantee divergence regardless of the mutation chosen.
  if (out.length === source.length && out.equals(source)) {
    out = Buffer.concat([source, Buffer.from([0x21])]);
  }
  return out;
}

/** Whether a generated "equal" copy is delivered as a string or as a Buffer. */
const equalAsBufferArb = fc.boolean();
/** Whether a generated "absent" copy is delivered as undefined or null. */
const absentAsNullArb = fc.boolean();

const intentArb: fc.Arbitrary<CopyIntent> = fc.constantFrom(
  'equal',
  'divergent',
  'absent'
);

/** Generate the four per-location intents independently. */
const intentsArb: fc.Arbitrary<Record<AnswerKeyLocation, CopyIntent>> = fc.record({
  markdown: intentArb,
  staticSolution: intentArb,
  solutionZip: intentArb,
  repoSolution: intentArb,
});

interface Scenario {
  source: string;
  intents: Record<AnswerKeyLocation, CopyIntent>;
  copies: AnswerKeyCopies;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    source: sourceArb,
    intents: intentsArb,
    equalAsBuffer: equalAsBufferArb,
    absentAsNull: absentAsNullArb,
    divergenceKinds: fc.record({
      markdown: fc.nat(),
      staticSolution: fc.nat(),
      solutionZip: fc.nat(),
      repoSolution: fc.nat(),
    }),
  })
  .map(({ source, intents, equalAsBuffer, absentAsNull, divergenceKinds }) => {
    const sourceBuf = Buffer.from(source, 'utf8');
    const copies: AnswerKeyCopies = {};
    for (const location of ANSWER_KEY_LOCATIONS) {
      const intent = intents[location];
      let content: CopyContent;
      if (intent === 'equal') {
        content = equalAsBuffer ? Buffer.from(source, 'utf8') : source;
      } else if (intent === 'divergent') {
        content = makeDivergent(sourceBuf, divergenceKinds[location]);
      } else {
        content = absentAsNull ? null : undefined;
      }
      copies[location] = content;
    }
    return { source, intents, copies };
  });

/* --------------------------------- Properties --------------------------------- */

describe('Feature: codebase-modernization-refresh, Property 11 — Answer-key content equivalence across four locations', () => {
  it('classifies every copy by its intent and gates completion on full equivalence (Req 14.2, 14.3, 14.4, 14.5, 14.6)', () => {
    fc.assert(
      fc.property(scenarioArb, ({ source, intents, copies }) => {
        const key = syncAnswerKey('k', 'lib/CellStack.ts', source, copies);

        const expectedMissing = ANSWER_KEY_LOCATIONS.filter(
          (l) => intents[l] === 'absent'
        );
        const expectedDivergent = ANSWER_KEY_LOCATIONS.filter(
          (l) => intents[l] === 'divergent'
        );
        const allEqual =
          expectedMissing.length === 0 && expectedDivergent.length === 0;

        // Req 14.5: every absent copy is reported missing, in canonical order.
        expect(key.missingLocations).toEqual(expectedMissing);
        // Req 14.4: every present-but-differing copy is reported divergent.
        expect(key.divergentLocations).toEqual(expectedDivergent);

        // Req 14.2/14.3: allByteIdentical IFF all four present & byte-identical.
        expect(key.allByteIdentical).toBe(allEqual);

        // Req 14.6: activity may complete IFF there are no failures.
        expect(isActivityComplete(key)).toBe(allEqual);
        expect(isSyncFailure(key)).toBe(!allEqual);

        // One failure message per failing location, naming key + location.
        const messages = syncFailureMessages(key);
        expect(messages).toHaveLength(
          expectedMissing.length + expectedDivergent.length
        );
        for (const loc of [...expectedMissing, ...expectedDivergent]) {
          expect(messages.some((m) => m.includes(loc))).toBe(true);
          expect(messages.every((m) => m.includes('"k"'))).toBe(true);
        }
      }),
      { numRuns: 300 }
    );
  });

  it('allByteIdentical is true precisely when all four copies are present and byte-equal (Req 14.2, 14.3)', () => {
    fc.assert(
      fc.property(sourceArb, equalAsBufferArb, (source, asBuffer) => {
        const copy: CopyContent = asBuffer ? Buffer.from(source, 'utf8') : source;
        const copies: AnswerKeyCopies = {
          markdown: copy,
          staticSolution: copy,
          solutionZip: copy,
          repoSolution: copy,
        };
        const key = syncAnswerKey('k', 'lib/x.ts', source, copies);
        expect(key.allByteIdentical).toBe(true);
        expect(key.missingLocations).toEqual([]);
        expect(key.divergentLocations).toEqual([]);
        expect(isActivityComplete(key)).toBe(true);
      }),
      { numRuns: 150 }
    );
  });

  it('any single absent copy blocks completion and is the only missing location (Req 14.5)', () => {
    fc.assert(
      fc.property(
        sourceArb,
        fc.constantFrom<AnswerKeyLocation>(...ANSWER_KEY_LOCATIONS),
        fc.boolean(),
        (source, absentLoc, useNull) => {
          const copies: AnswerKeyCopies = {};
          for (const loc of ANSWER_KEY_LOCATIONS) {
            copies[loc] = loc === absentLoc ? (useNull ? null : undefined) : source;
          }
          const key = syncAnswerKey('k', 'lib/x.ts', source, copies);
          expect(key.missingLocations).toEqual([absentLoc]);
          expect(key.divergentLocations).toEqual([]);
          expect(key.allByteIdentical).toBe(false);
          expect(isActivityComplete(key)).toBe(false);
        }
      ),
      { numRuns: 150 }
    );
  });

  it('any single subtly-divergent copy blocks completion and is the only divergent location (Req 14.4)', () => {
    fc.assert(
      fc.property(
        sourceArb,
        fc.constantFrom<AnswerKeyLocation>(...ANSWER_KEY_LOCATIONS),
        fc.nat(),
        (source, divergentLoc, kind) => {
          const sourceBuf = Buffer.from(source, 'utf8');
          const copies: AnswerKeyCopies = {};
          for (const loc of ANSWER_KEY_LOCATIONS) {
            copies[loc] =
              loc === divergentLoc ? makeDivergent(sourceBuf, kind) : source;
          }
          // Sanity: the divergent copy really differs byte-for-byte.
          expect(toBuffer(copies[divergentLoc])!.equals(sourceBuf)).toBe(false);

          const key = syncAnswerKey('k', 'lib/x.ts', source, copies);
          expect(key.divergentLocations).toEqual([divergentLoc]);
          expect(key.missingLocations).toEqual([]);
          expect(key.allByteIdentical).toBe(false);
          expect(isActivityComplete(key)).toBe(false);
        }
      ),
      { numRuns: 150 }
    );
  });
});
