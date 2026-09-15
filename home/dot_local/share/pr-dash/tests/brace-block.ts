// Shared by structural tests that need the exact body of a specific block (a function, an
// `if` statement, an arrow's block body) rather than a fixed-size text window after it. A
// window breaks on correct code once a comment or reformat pushes the real content past its
// length; counting braces is exact for well-formed source and does not depend on line length
// or comment density.
//
// Callers should run `stripComments` on the source first: an unbalanced brace inside a
// comment (a doc example showing `{ ... }`) would otherwise throw off the count. A brace
// inside a string or template-literal interpolation is not similarly guarded — this scan
// does not track string state, only brace characters — so it remains a hazard for any target
// file whose block of interest embeds one. None of this project's current structural-test
// targets do.

/** The balanced `{ ... }` block starting at the first `{` at or after `from`. */
export function braceBlock(text: string, from: number): string {
  const start = text.indexOf('{', from);
  if (start === -1) throw new Error('expected a { at or after the given position');
  let depth = 0;
  let i = start;
  for (; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }
  return text.slice(start, i);
}
