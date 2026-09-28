/**
 * RTF Escape Encoder — core encoding and decoding logic.
 *
 * RTF is an ASCII-only format. Characters outside the ASCII printable range
 * must be represented with escape sequences. This module provides two pairs
 * of functions:
 *
 *   - escapeRtf / unescapeRtf: the general-purpose API. Non-ASCII characters
 *     are emitted as \uN? fallback escapes (the standard RTF Unicode escape).
 *   - escapeRtfAscii / unescapeRtfAscii: a stricter variant for ASCII-only
 *     output. Non-ASCII characters are replaced with '?', matching what many
 *     legacy RTF readers display when they cannot render a Unicode escape.
 *
 * Design decisions (documented because they are not obvious):
 *
 * 1. We escape backslash and brace unconditionally in escapeRtf, because they
 *    are RTF control symbols. We do NOT escape semicolons, spaces, or hyphens —
 *    those are only special inside specific control words, and escaping them
 *    everywhere produces unreadable output for no real-world benefit.
 *
 * 2. The \uN? form uses a signed 16-bit value for N, because that is what the
 *    RTF spec mandates (\uN is a 16-bit signed integer). For code points above
 *    U+FFFF (supplementary plane characters, i.e. those requiring surrogate
 *    pairs in UTF-16), we emit TWO \uN? sequences — one for each surrogate.
 *    This is how Word itself encodes emoji and other supplementary characters.
 *
 * 3. unescapeRtf handles \uN? by consuming the optional single fallback
 *    character after the number. Per the spec, the reader substitutes the
 *    fallback if it cannot render the Unicode character; a conforming reader
 *    that CAN render it must skip the fallback. Since our decoder always
 *    renders the Unicode character, we always skip the fallback byte.
 *
 * 4. We handle \'hh hex escapes by decoding them as Windows-1252 (the de
 *    facto RTF legacy encoding for bytes 0x80-0x9F). For bytes outside that
 *    range we fall back to Latin-1. This is the least-wrong choice: RTF has
 *    no declared encoding for \'hh, and Windows-1252 is what Word uses.
 *
 * 5. Known control words like \par, \line, \tab, \\, \{, \} are passed through
 *    on escape (they are already valid RTF) and decoded on unescape to their
 *    plain-text equivalents where a natural equivalent exists.
 */

/**
 * The set of ASCII characters that are NOT special in RTF document text.
 * Everything else (control symbols, non-printable) needs escaping.
 *
 * We deliberately include high-bit characters as "needing escape" even though
 * some readers tolerate raw bytes — emitting \u escapes is safer and spec-compliant.
 */
const ASCII_PRINTABLE = new Set();

// Build the printable-ASCII set programmatically to avoid transcription errors.
for (let i = 0x20; i <= 0x7e; i++) {
  ASCII_PRINTABLE.add(String.fromCharCode(i));
}

/**
 * Characters that are RTF control symbols and must be backslash-escaped
 * in document text. Backslash itself is in this set.
 */
const RTF_CONTROL_SYMBOLS = new Set(['\\', '{', '}']);

/**
 * Windows-1252 mapping for bytes 0x80–0x9F. These positions are undefined in
 * Latin-1, and Word emits \'hh for these characters using Windows-1252.
 * Keys are hex byte values as decimal numbers; values are Unicode code points.
 */
const WIN1252_HIGH = {
  0x80: 0x20ac, // EURO SIGN
  0x82: 0x201a, // SINGLE LOW-9 QUOTATION MARK
  0x83: 0x0192, // LATIN SMALL LETTER F WITH HOOK
  0x84: 0x201e, // DOUBLE LOW-9 QUOTATION MARK
  0x85: 0x2026, // HORIZONTAL ELLIPSIS
  0x86: 0x2020, // DAGGER
  0x87: 0x2021, // DOUBLE DAGGER
  0x88: 0x02c6, // MODIFIER LETTER CIRCUMFLEX ACCENT
  0x89: 0x2030, // PER MILLE SIGN
  0x8a: 0x0160, // LATIN CAPITAL LETTER S WITH CARON
  0x8b: 0x2039, // SINGLE LEFT-POINTING ANGLE QUOTATION MARK
  0x8c: 0x0152, // LATIN CAPITAL LIGATURE OE
  0x8e: 0x017d, // LATIN CAPITAL LETTER Z WITH CARON
  0x91: 0x2018, // LEFT SINGLE QUOTATION MARK
  0x92: 0x2019, // RIGHT SINGLE QUOTATION MARK
  0x93: 0x201c, // LEFT DOUBLE QUOTATION MARK
  0x94: 0x201d, // RIGHT DOUBLE QUOTATION MARK
  0x95: 0x2022, // BULLET
  0x96: 0x2013, // EN DASH
  0x97: 0x2014, // EM DASH
  0x98: 0x02dc, // SMALL TILDE
  0x99: 0x2122, // TRADE MARK SIGN
  0x9a: 0x0161, // LATIN SMALL LETTER S WITH CARON
  0x9b: 0x203a, // SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
  0x9c: 0x0153, // LATIN SMALL LIGATURE OE
  0x9e: 0x017e, // LATIN SMALL LETTER Z WITH CARON
  0x9f: 0x0178, // LATIN CAPITAL LETTER Y WITH DIAERESIS
};

/**
 * Convert a Unicode code point to its signed 16-bit RTF \uN representation.
 * Code points that fit in 0xFFFF are returned directly (as unsigned, then
 * converted to signed 16-bit). Supplementary code points must be split into
 * a surrogate pair BEFORE calling this — see codePointToRtfUnicode.
 *
 * RTF defines \uN as a signed 16-bit integer, so values 0x8000–0xFFFF are
 * represented as negative numbers (-32768..-1).
 */
function toSigned16(codeUnit) {
  if (codeUnit > 0xffff) {
    throw new RangeError(
      `toSigned16 expects a UTF-16 code unit, got code point U+${codeUnit.toString(16).toUpperCase()}`
    );
  }
  return codeUnit > 0x7fff ? codeUnit - 0x10000 : codeUnit;
}

/**
 * Encode a single Unicode code point as one or two \uN? RTF escape sequences.
 * Returns the raw RTF fragment (without any surrounding text).
 *
 * Supplementary-plane characters (U+10000 and above) become two \uN? escapes,
 * one for each UTF-16 surrogate half. This matches Microsoft Word's output.
 */
function codePointToRtfUnicode(codePoint) {
  if (codePoint > 0x10ffff) {
    throw new RangeError(
      `Code point U+${codePoint.toString(16).toUpperCase()} is outside the Unicode range`
    );
  }

  if (codePoint <= 0xffff) {
    return `\\u${toSigned16(codePoint)}?`;
  }

  // Split into UTF-16 surrogate pair.
  const adjusted = codePoint - 0x10000;
  const high = 0xd800 + (adjusted >> 10);
  const low = 0xdc00 + (adjusted & 0x3ff);
  return `\\u${toSigned16(high)}?\\u${toSigned16(low)}?`;
}

/**
 * Escape a string for safe inclusion in RTF document text.
 *
 * - Backslash, {, and } are backslash-escaped.
 * - ASCII printable characters (0x20–0x7E) pass through unchanged.
 * - ASCII control characters (0x00–0x1F, 0x7F) become \uN? escapes.
 * - Non-ASCII characters become \uN? escapes (with surrogate pairs for
 *   supplementary-plane characters).
 *
 * @param {string} input - The text to escape. Must be a string.
 * @returns {string} RTF-safe text.
 */
export function escapeRtf(input) {
  if (typeof input !== 'string') {
    throw new TypeError(`escapeRtf expected a string, got ${typeof input}`);
  }

  let out = '';
  for (const ch of input) {
    const codePoint = ch.codePointAt(0);

    if (RTF_CONTROL_SYMBOLS.has(ch)) {
      out += '\\' + ch;
    } else if (codePoint >= 0x20 && codePoint <= 0x7e) {
      out += ch;
    } else {
      out += codePointToRtfUnicode(codePoint);
    }
  }
  return out;
}

/**
 * Escape a string for RTF, replacing non-ASCII characters with '?' instead of
 * emitting \uN? escapes. Use this when targeting readers that do not understand
 * RTF Unicode escapes (rare, but some very old controls fall in this category).
 *
 * @param {string} input
 * @returns {string}
 */
export function escapeRtfAscii(input) {
  if (typeof input !== 'string') {
    throw new TypeError(`escapeRtfAscii expected a string, got ${typeof input}`);
  }

  let out = '';
  for (const ch of input) {
    const codePoint = ch.codePointAt(0);

    if (RTF_CONTROL_SYMBOLS.has(ch)) {
      out += '\\' + ch;
    } else if (codePoint >= 0x20 && codePoint <= 0x7e) {
      out += ch;
    } else {
      out += '?';
    }
  }
  return out;
}

/**
 * Decode an RTF-escaped string back to plain text.
 *
 * Handles:
 *   - \\, \{, \}  → literal backslash, brace
 *   - \uN?        → Unicode character (fallback byte skipped)
 *   - \'hh        → byte decoded as Windows-1252 (Latin-1 fallback)
 *   - \par, \line, \tab, \r, \n → newline / tab / passed-through
 *
 * Unknown control words are dropped (the control word and its optional numeric
 * argument are consumed), because in RTF a control word is formatting metadata,
 * not document text. This is a deliberate choice: this is an *escape* decoder,
 * not a full RTF parser. If you need to preserve formatting control words, parse
 * the RTF with a real RTF reader first and feed this function only the text runs.
 *
 * @param {string} input
 * @returns {string}
 */
export function unescapeRtf(input) {
  if (typeof input !== 'string') {
    throw new TypeError(`unescapeRtf expected a string, got ${typeof input}`);
  }

  let out = '';
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }

    // We have a backslash. What follows?
    if (i + 1 >= len) {
      // Trailing backslash with nothing after it. Keep it literally —
      // a truncated escape is ambiguous, and dropping it would lose data.
      out += '\\';
      i++;
      continue;
    }

    const next = input[i + 1];

    // \uN? — Unicode escape. N is a signed 16-bit integer.
    if (next === 'u') {
      const result = parseUnicodeEscape(input, i);
      out += result.text;
      i = result.nextIndex;
      continue;
    }

    // \'hh — hex byte escape.
    if (next === "'") {
      const result = parseHexEscape(input, i);
      out += result.text;
      i = result.nextIndex;
      continue;
    }

    // Named control words and single-character control symbols.
    if (next === '\\' || next === '{' || next === '}') {
      out += next;
      i += 2;
      continue;
    }

    // Control word: a backslash followed by ASCII letters, then an optional
    // numeric argument, then an optional single space delimiter.
    const result = parseControlWord(input, i);
    out += result.text;
    i = result.nextIndex;
  }

  return out;
}

/**
 * Parse a \uN? escape starting at input[i]. Returns { text, nextIndex }.
 *
 * The number N is a signed 16-bit integer. After the number there is an
 * optional single fallback character (any single byte / char) which we skip
 * per the RTF spec: a reader that can render the Unicode character must ignore
 * the fallback.
 *
 * We also handle consecutive \uN? sequences that form a surrogate pair, because
 * supplementary-plane characters are encoded as two \u escapes in Word output.
 */
function parseUnicodeEscape(input, i) {
  // i points at '\'. i+1 is 'u'.
  let j = i + 2;

  // Optional sign.
  let sign = 1;
  if (j < input.length && (input[j] === '-' || input[j] === '+')) {
    if (input[j] === '-') sign = -1;
    j++;
  }

  // Digits.
  let numStr = '';
  while (j < input.length && input[j] >= '0' && input[j] <= '9') {
    numStr += input[j];
    j++;
  }

  if (numStr.length === 0) {
    // Malformed: \u with no digits. Emit nothing and advance past 'u'.
    return { text: '', nextIndex: i + 2 };
  }

  let codeUnit = sign * parseInt(numStr, 10);
  // Convert signed 16-bit back to unsigned.
  if (codeUnit < 0) codeUnit += 0x10000;

  // Skip the optional single fallback character.
  // The fallback is exactly one character per the spec (one byte in the
  // file's encoding, which we treat as one UTF-16 code unit).
  if (j < input.length) {
    j++;
  }

  // Check for a following \uN? that forms a surrogate pair.
  if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && j < input.length - 1 && input[j] === '\\' && input[j + 1] === 'u') {
    const lowResult = parseUnicodeEscape(input, j);
    let lowUnit = lowResult._rawCodeUnit;
    if (lowUnit !== undefined && lowUnit >= 0xdc00 && lowUnit <= 0xdfff) {
      const combined = 0x10000 + ((codeUnit - 0xd800) << 10) + (lowUnit - 0xdc00);
      return { text: String.fromCodePoint(combined), nextIndex: lowResult.nextIndex };
    }
  }

  return { text: String.fromCharCode(codeUnit), nextIndex: j };
}

/**
 * Parse a \'hh hex escape starting at input[i]. Returns { text, nextIndex }.
 *
 * The two hex digits after \' are a byte in the document's legacy encoding.
 * We decode 0x80–0x9F as Windows-1252 and everything else as Latin-1.
 */
function parseHexEscape(input, i) {
  // i points at '\', i+1 at "'".
  const hexStart = i + 2;
  if (hexStart + 1 >= input.length) {
    // Not enough characters for two hex digits. Emit nothing.
    return { text: '', nextIndex: input.length };
  }

  const hex = input.substring(hexStart, hexStart + 2);
  if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
    // Not valid hex. Emit nothing and advance past the apostrophe.
    return { text: '', nextIndex: i + 2 };
  }

  const byteVal = parseInt(hex, 16);
  let codePoint;

  if (Object.prototype.hasOwnProperty.call(WIN1252_HIGH, byteVal)) {
    codePoint = WIN1252_HIGH[byteVal];
  } else {
    // Latin-1: bytes 0x00–0xFF map directly to U+0000–U+00FF.
    codePoint = byteVal;
  }

  return { text: String.fromCodePoint(codePoint), nextIndex: hexStart + 2 };
}

/**
 * Parse a control word like \par, \line, \tab, \b, \fs24, etc.
 *
 * Returns { text, nextIndex }. For most control words, text is '' (they are
 * formatting instructions, not content). A few have plain-text equivalents:
 *   \par, \line → newline
 *   \tab       → tab
 *   \r         → carriage return (rare in modern RTF)
 *
 * The control word is consumed along with its optional numeric argument and
 * the single space that may terminate it.
 */
function parseControlWord(input, i) {
  // i points at '\'. Collect letters.
  let j = i + 1;
  let word = '';
  while (j < input.length && /[a-zA-Z]/.test(input[j])) {
    word += input[j];
    j++;
  }

  // Optional numeric argument (may be negative).
  if (j < input.length && (input[j] === '-' || (input[j] >= '0' && input[j] <= '9'))) {
    if (input[j] === '-') j++;
    while (j < input.length && input[j] >= '0' && input[j] <= '9') {
      j++;
    }
  }

  // Optional single space delimiter that is consumed.
  if (j < input.length && input[j] === ' ') {
    j++;
  }

  let text = '';
  switch (word) {
    case 'par':
    case 'line':
      text = '\n';
      break;
    case 'tab':
      text = '\t';
      break;
    case 'r':
      text = '\r';
      break;
    default:
      text = '';
  }

  return { text, nextIndex: j };
}
