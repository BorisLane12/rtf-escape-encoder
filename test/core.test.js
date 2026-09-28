import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeRtf, unescapeRtf, escapeRtfAscii } from '../src/index.js';

describe('escapeRtf', () => {
  it('passes plain ASCII through unchanged', () => {
    assert.equal(escapeRtf('Hello, world!'), 'Hello, world!');
  });

  it('escapes backslash, open brace, and close brace', () => {
    assert.equal(escapeRtf('a\\b{c}d'), 'a\\\\b\\{c\\}d');
  });

  it('escapes a non-ASCII character as \\uN?', () => {
    // U+00E9 (é) = 233, fits in unsigned 16-bit, no sign needed.
    assert.equal(escapeRtf('café'), 'caf\\u233?');
  });

  it('encodes a supplementary-plane character as a surrogate pair', () => {
    // U+1F600 (😀) = D83D DE00 in UTF-16.
    // D83D = 55357, DE00 = 56832. Both are > 0x7FFF so signed:
    //   55357 - 65536 = -10179
    //   56832 - 65536 = -8704
    assert.equal(escapeRtf('😀'), '\\u-10179?\\u-8704?');
  });

  it('escapes ASCII control characters', () => {
    // Tab (0x09) and newline (0x0A) are below 0x20.
    assert.equal(escapeRtf('\t\n'), '\\u9?\\u10?');
  });

  it('throws TypeError for non-string input', () => {
    assert.throws(() => escapeRtf(42), TypeError);
    assert.throws(() => escapeRtf(null), TypeError);
  });

  it('handles empty string', () => {
    assert.equal(escapeRtf(''), '');
  });
});

describe('escapeRtfAscii', () => {
  it('replaces non-ASCII with question mark', () => {
    assert.equal(escapeRtfAscii('café'), 'caf?');
  });

  it('still escapes control symbols', () => {
    assert.equal(escapeRtfAscii('a{b}c'), 'a\\{b\\}c');
  });

  it('replaces supplementary-plane characters with a single question mark', () => {
    assert.equal(escapeRtfAscii('x😀y'), 'x?y');
  });
});

describe('unescapeRtf', () => {
  it('passes plain text through', () => {
    assert.equal(unescapeRtf('Hello, world!'), 'Hello, world!');
  });

  it('decodes escaped backslash and braces', () => {
    assert.equal(unescapeRtf('a\\\\b\\{c\\}d'), 'a\\b{c}d');
  });

  it('decodes a \\uN? escape and skips the fallback byte', () => {
    assert.equal(unescapeRtf('caf\\u233?'), 'café');
  });

  it('decodes a negative \\uN? escape', () => {
    // U+00E9 = 233 unsigned = -65303 signed 16-bit.
    assert.equal(unescapeRtf('\\u-65303?'), 'é');
  });

  it('decodes a supplementary-plane surrogate pair', () => {
    assert.equal(unescapeRtf('\\u-10179?\\u-8704?'), '😀');
  });

  it('decodes a \\\'hh hex escape using Windows-1252 for 0x80-0x9F', () => {
    // 0x93 in Windows-1252 = U+201C (LEFT DOUBLE QUOTATION MARK).
    assert.equal(unescapeRtf("\\'93"), '\u201C');
  });

  it('decodes a \\\'hh hex escape using Latin-1 for other bytes', () => {
    // 0xE9 in Latin-1 = U+00E9 (é).
    assert.equal(unescapeRtf("\\'e9"), 'é');
  });

  it('decodes \\par and \\line as newline', () => {
    assert.equal(unescapeRtf('a\\par b\\line c'), 'a\nb\nc');
  });

  it('decodes \\tab as tab', () => {
    assert.equal(unescapeRtf('a\\tab b'), 'a\tb');
  });

  it('drops unknown control words', () => {
    assert.equal(unescapeRtf('a\\b b\\fs24 c'), 'abc');
  });

  it('handles a trailing backslash', () => {
    assert.equal(unescapeRtf('abc\\'), 'abc\\');
  });

  it('throws TypeError for non-string input', () => {
    assert.throws(() => unescapeRtf(42), TypeError);
  });
});

describe('round-trip', () => {
  it('escape then unescape recovers the original for BMP text', () => {
    const original = 'Hello, "wörld"! {test} \\end\\';
    assert.equal(unescapeRtf(escapeRtf(original)), original);
  });

  it('escape then unescape recovers supplementary-plane text', () => {
    const original = 'Emoji: 😀🎉 done.';
    assert.equal(unescapeRtf(escapeRtf(original)), original);
  });
});
