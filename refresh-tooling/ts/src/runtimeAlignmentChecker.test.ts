/**
 * Unit tests for the Runtime Alignment Checker (Design Component 4, CC4).
 *
 * Requirements covered: 4.3, 4.4.
 *
 * Feature: codebase-modernization-refresh
 */
import {
  checkAlignment,
  assertAligned,
  extractMajorMinor,
  loadLambdaPythonVersion,
  loadFlaskBaseImageVersion,
} from './runtimeAlignmentChecker';

describe('extractMajorMinor', () => {
  it('parses the Lambda enum form PYTHON_3_13', () => {
    expect(extractMajorMinor('Runtime.PYTHON_3_13')).toBe('3.13');
    expect(extractMajorMinor('PYTHON_3_13')).toBe('3.13');
  });

  it('parses the container image form python:3.13-slim', () => {
    expect(
      extractMajorMinor('public.ecr.aws/docker/library/python:3.13-slim')
    ).toBe('3.13');
    expect(extractMajorMinor('python:3.13')).toBe('3.13');
  });

  it('parses the Lambda runtime id form python3.13', () => {
    expect(extractMajorMinor('python3.13')).toBe('3.13');
  });

  it('parses an already-normalized major.minor', () => {
    expect(extractMajorMinor('3.13')).toBe('3.13');
  });

  it('returns null for a token without a major.minor pair', () => {
    expect(extractMajorMinor('nodejs20')).toBeNull();
    expect(extractMajorMinor('')).toBeNull();
  });
});

describe('checkAlignment — aligned (Req 4.3)', () => {
  it('reports aligned when Lambda, Flask, and bootstrap all reference 3.13', () => {
    const report = checkAlignment({
      lambdaRuntime: 'Runtime.PYTHON_3_13',
      flaskBaseImage: 'public.ecr.aws/docker/library/python:3.13-slim',
      bootstrapRuntimes: ['python3.13', 'python3.13'],
    });

    expect(report.aligned).toBe(true);
    expect(report.mismatches).toEqual([]);
    expect(report.lambdaPython).toBe('3.13');
    expect(report.flaskBaseImage).toBe('3.13');
  });

  it('is aligned with no bootstrap runtimes supplied', () => {
    const report = checkAlignment({
      lambdaRuntime: 'python3.13',
      flaskBaseImage: 'python:3.13-slim',
      bootstrapRuntimes: [],
    });
    expect(report.aligned).toBe(true);
  });
});

describe('checkAlignment — mismatch (Req 4.4)', () => {
  it('flags a Flask base image that lags the Lambda runtime', () => {
    const report = checkAlignment({
      lambdaRuntime: 'Runtime.PYTHON_3_13',
      flaskBaseImage: 'python:3.12-slim',
      bootstrapRuntimes: [],
    });

    expect(report.aligned).toBe(false);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]).toMatch(/Flask base image Python 3\.12/);
  });

  it('flags a bootstrap inline-Lambda runtime that does not match the baseline', () => {
    const report = checkAlignment({
      lambdaRuntime: 'python3.13',
      flaskBaseImage: 'python:3.13-slim',
      bootstrapRuntimes: ['python3.13', 'python3.11'],
    });

    expect(report.aligned).toBe(false);
    expect(report.mismatches.some((m) => /3\.11/.test(m))).toBe(true);
  });

  it('flags an unparseable runtime token', () => {
    const report = checkAlignment({
      lambdaRuntime: 'Runtime.PYTHON_3_13',
      flaskBaseImage: 'not-a-python-image',
      bootstrapRuntimes: [],
    });
    expect(report.aligned).toBe(false);
    expect(
      report.mismatches.some((m) => /does not encode a Python major\.minor/.test(m))
    ).toBe(true);
  });
});

describe('assertAligned — halt contract (Req 4.4)', () => {
  it('returns the report unchanged when aligned', () => {
    const report = checkAlignment({
      lambdaRuntime: 'PYTHON_3_13',
      flaskBaseImage: 'python:3.13-slim',
      bootstrapRuntimes: ['python3.13'],
    });
    expect(assertAligned(report)).toBe(report);
  });

  it('throws and enumerates mismatches when not aligned', () => {
    const report = checkAlignment({
      lambdaRuntime: 'Runtime.PYTHON_3_13',
      flaskBaseImage: 'python:3.12-slim',
      bootstrapRuntimes: [],
    });
    expect(() => assertAligned(report)).toThrow(/refresh halted/i);
    expect(() => assertAligned(report)).toThrow(/3\.12/);
  });
});

describe('repository-sourced values (Req 4.3)', () => {
  it('reads Lambda Python 3.13 from the construct and Flask 3.13 from the dockerfile, and they align', () => {
    const lambdaPython = loadLambdaPythonVersion();
    const flaskBaseImage = loadFlaskBaseImageVersion();

    // These sources exist in the repo; if either cannot be resolved the loaders
    // return null and the test surfaces that as a failure rather than passing silently.
    expect(lambdaPython).toBe('3.13');
    expect(flaskBaseImage).toBe('3.13');

    const report = checkAlignment({
      lambdaRuntime: lambdaPython!,
      flaskBaseImage: flaskBaseImage!,
      bootstrapRuntimes: ['python3.13'],
    });
    expect(report.aligned).toBe(true);
  });
});
