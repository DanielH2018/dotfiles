export function checkAssertions(text, assert = {}) {
  const failures = [];
  for (const pat of assert.must_match || []) {
    if (!new RegExp(pat, 'i').test(text)) failures.push(`must_match not found: ${pat}`);
  }
  for (const pat of assert.must_not_match || []) {
    if (new RegExp(pat, 'i').test(text)) failures.push(`must_not_match matched: ${pat}`);
  }
  return { pass: failures.length === 0, failures };
}
