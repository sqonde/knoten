import { describe, test, expect } from 'bun:test';
import { __internals } from './query';

// These exercise the SHIPPED helpers directly (via the non-public __internals
// seam), so they cannot drift from the real implementation. Hook-level behavior
// lives in query.hooks.test.ts. Both run under bun test.
const { serializeKey, isPrefixMatch, isAbortError } = __internals;

describe('serializeKey', () => {
  test('serializes string arrays', () => {
    expect(serializeKey(['admin', 'users'])).toBe('["admin","users"]');
  });

  test('serializes single element', () => {
    expect(serializeKey(['metrics'])).toBe('["metrics"]');
  });

  test('serializes mixed types', () => {
    expect(serializeKey(['admin', 'user', 42])).toBe('["admin","user",42]');
  });

  test('serializes empty array', () => {
    expect(serializeKey([])).toBe('[]');
  });
});

describe('isPrefixMatch', () => {
  const match = (prefix: unknown[], key: unknown[]) =>
    isPrefixMatch(serializeKey(prefix), serializeKey(key));

  test('exact match returns true', () => {
    expect(match(['admin', 'users'], ['admin', 'users'])).toBe(true);
  });

  test('prefix matches longer key', () => {
    expect(match(['admin'], ['admin', 'users'])).toBe(true);
  });

  test('prefix matches deeply nested key', () => {
    expect(match(['admin'], ['admin', 'users', 'detail'])).toBe(true);
  });

  test('non-matching prefix returns false', () => {
    expect(match(['metrics'], ['admin', 'users'])).toBe(false);
  });

  test('longer prefix does not match shorter key', () => {
    expect(match(['admin', 'users'], ['admin'])).toBe(false);
  });

  test('partial string overlap is not a match', () => {
    // ['admin'] must NOT match ['administrator']
    expect(match(['admin'], ['administrator'])).toBe(false);
  });

  test('single element exact match', () => {
    expect(match(['metrics'], ['metrics'])).toBe(true);
  });

  test('empty prefix matches nothing (documented edge case)', () => {
    expect(match([], ['admin', 'users'])).toBe(false);
  });
});

describe('isAbortError', () => {
  test('true for a DOMException named AbortError', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  test('false for an ordinary Error', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
  });

  test('false for a DOMException with a different name', () => {
    expect(isAbortError(new DOMException('nope', 'NotFoundError'))).toBe(false);
  });

  test('false for non-error values', () => {
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});
