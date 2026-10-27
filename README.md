# RTF Escape Encoder

Escapes and unescapes special characters in Rich Text Format (RTF) document text, including `\uN?` Unicode fallback escapes and surrogate-pair handling for supplementary-plane characters.

## Usage

```js
import { escapeRtf, unescapeRtf, escapeRtfAscii } from 'rtf-escape-encoder';

// Escape text for safe inclusion in an RTF document body.
const safe = escapeRtf('café — 😀');
// → 'caf\u233? \u8211?\u-10179?\u-8704?'

// Decode RTF escapes back to plain text.
const text = unescapeRtf('caf\\u233?');
// → 'café'

// ASCII-only variant: replaces non-ASCII with '?'.
const ascii = escapeRtfAscii('café');
// → 'caf?'
```

## Why this exists

RTF is an ASCII-only format. Any character outside the printable ASCII range must be represented as an escape sequence, and the `\uN?` Unicode escape uses a **signed 16-bit** integer — a detail that trips up naive encoders. Characters above U+FFFF (emoji, rare CJK) require a surrogate pair of `\uN?` sequences, which is what Microsoft Word actually emits. This library handles both directions correctly.

The trade-off: `unescapeRtf` is an **escape decoder**, not a full RTF parser. It handles `\uN?`, `\'hh`, `\\`, `\{`, `\}`, and a handful of control words with plain-text equivalents (`\par`, `\line`, `\tab`). Unknown control words (`\b`, `\fs24`, etc.) are dropped, because they are formatting metadata, not document text. If you need to preserve formatting, use a real RTF parser and feed this function only the extracted text runs.

## Edge cases you will hit

- **`\'hh` hex escapes** are decoded as Windows-1252 for bytes 0x80–0x9F and Latin-1 elsewhere. RTF has no declared encoding for these bytes; Windows-1252 is what Word uses.
- **The fallback byte after `\uN?`** is always skipped on decode. The RTF spec says a reader that can render the Unicode character must ignore the fallback; since our decoder always renders it, we always skip.
- **`escapeRtfAscii`** replaces each non-ASCII character with a single `?`, not a phonetically similar ASCII substitute. This matches what legacy RTF readers display.

## Design notes

The window stores values eagerly rather than keeping running aggregates. Running
sums drift with floating point over long streams, and recomputing from a small
buffer is cheap enough that the drift is not worth the speed.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

## Limitations

Values are coerced to floats, so very large integers lose precision. If you need
exact integer aggregates over a window, this is the wrong tool.

## Contributing

Issues and pull requests are welcome. Please keep the dependency list empty —
that constraint is the point of the project, not an oversight.

