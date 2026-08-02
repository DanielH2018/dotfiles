// A malformed pattern used to throw out of here and kill the whole sweep, discarding every
// paid run in that invocation — JS has no inline (?i) flag, and one case carrying it took
// down its entire agent group. A bad pattern now fails its own case and nothing else.
function compile(pat) {
  try {
    return new RegExp(pat, 'i');
  } catch (e) {
    return { invalid: `invalid regex ${pat}: ${e.message}` };
  }
}

export function checkAssertions(text, assert = {}) {
  const failures = [];
  for (const pat of assert.must_match || []) {
    const re = compile(pat);
    if (re.invalid) failures.push(re.invalid);
    else if (!re.test(text)) failures.push(`must_match not found: ${pat}`);
  }
  for (const pat of assert.must_not_match || []) {
    const re = compile(pat);
    if (re.invalid) failures.push(re.invalid);
    else if (re.test(text)) failures.push(`must_not_match matched: ${pat}`);
  }
  return { pass: failures.length === 0, failures };
}
