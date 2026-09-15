// Shared by every test that reads a source file and matches an identifier or call against
// its text: import-convention.test.ts, app-source.test.ts, and startup-order.test.ts. Without
// this, a prose mention inside a comment (a doc example, "see foo() above") satisfies an
// assertion meant to find real code, so a mutation that deletes the real call and replaces it
// with a comment describing it leaves the check green.
//
// Replaces every comment span with spaces, keeping newlines so that every byte offset in the
// result still maps to the same line as in the original text.
//
// A string literal is left intact: a specifier or identifier a scan is looking for can live
// inside one, and `//` inside a URL string is not a comment opener. Single, double and
// backtick quotes are all tracked, and so are regex literals — a regex is skipped rather than
// blanked, since it is code, but its contents must not be read as comment openers. `/\//` and
// `/[/*]/` are the two shapes that mattered: the first reads as a line comment from its
// escaped slash onward, the second as a block comment running to the next `*/`, and either
// silently hides a real match on the same line.
//
// One case is knowingly out of reach without a real tokenizer and is left alone rather than
// half-handled: `${...}` interpolation inside a template literal is treated as string
// content, so a comment written inside one is not stripped. That direction is a false
// positive, not a missed real match, and the pattern does not appear in this codebase.
export function stripComments(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let j = from; j < to; j += 1) {
      if (out[j] !== '\n') out[j] = ' ';
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      i = skipStringLiteral(text, i);
    } else if (ch === '/' && opensRegexLiteral(out, i)) {
      // The comment branches above come first deliberately: neither `//` nor `/*` can open
      // a regex literal, since an empty regex is not valid JavaScript.
      const end = skipRegexLiteral(text, i);
      i = end === -1 ? i + 1 : end;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

// Where a value can begin, a `/` opens a regex literal; after a value, it is division.
// Distinguishing them exactly needs a tokenizer, so this reads the preceding significant
// character instead. `)` and `]` are deliberately absent: they end a value, so a slash after
// one is division.
//
// Getting this wrong in the permissive direction does not swallow the text that follows —
// the regex branch in `stripComments` advances `i` without calling `blank()`, so a misread
// division skips text rather than blanking it, and a match after it is still found. What it
// actually costs is a false positive: the skip runs to the first slash of a following `//`,
// leaving that comment unstripped, so a prose mention inside it matches when it should not.
const REGEX_PRECEDING_CHARS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>',
  '~', '^', '\n',
]);

// Keywords a regex literal can directly follow. An identifier or a literal before the slash
// means division; these are the words that read as operators instead.
const REGEX_PRECEDING_WORDS = [
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield',
  'await',
];

/**
 * Whether the `/` at `slash` in `chars` opens a regex literal rather than dividing. Reads
 * `chars` — the partially stripped output — not the original text, so a comment already
 * blanked to spaces does not count as the preceding token.
 */
function opensRegexLiteral(chars: readonly string[], slash: number): boolean {
  let i = slash - 1;
  while (i >= 0 && (chars[i] === ' ' || chars[i] === '\t')) i -= 1;
  if (i < 0) return true;
  const ch = chars[i]!;
  if (REGEX_PRECEDING_CHARS.has(ch)) return true;
  if (!/[A-Za-z0-9_$]/.test(ch)) return false;
  // Longest keyword above is 6 characters, plus one for the boundary character before it.
  const window = chars.slice(Math.max(0, i - 7), i + 1).join('');
  return REGEX_PRECEDING_WORDS.some((word) =>
    new RegExp(`(^|[^A-Za-z0-9_$])${word}$`).test(window),
  );
}

/**
 * The offset just past the regex literal opening at `start`, or -1 when the literal does
 * not close before the end of its line — in which case the `/` was not one after all.
 * Tracks character classes, because a `/` inside `[...]` does not close the literal.
 */
function skipRegexLiteral(text: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n') return -1;
    if (inClass) {
      if (ch === ']') inClass = false;
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === '/') {
      return i + 1;
    }
    i += 1;
  }
  return -1;
}

// Returns the offset just past the string literal opening at `start`. An unterminated single-
// or double-quoted string ends at the newline: that is invalid JavaScript, and stopping there
// keeps one stray quote from swallowing the rest of the file.
function skipStringLiteral(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === '\n' && quote !== '`') return i;
    i += 1;
  }
  return i;
}
