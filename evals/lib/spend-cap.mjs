// The sweep-wide spend cap behind --max-total-usd. run-evals asks allows() before it starts
// each run and add()s the run's costUsd once it finishes, so a sweep stops at the first run
// boundary after the total reaches the cap. The last run that started can still carry the
// total past the cap by its own cost; --max-budget-usd on each claude call bounds that.
// With no cap (maxUsd undefined) every run is allowed.
export function createSpendCap(maxUsd) {
  let spent = 0;
  let stopped = false;
  return {
    limited: maxUsd !== undefined,
    get spent() { return spent; },
    // True once allows() has refused a run, i.e. the sweep skipped work it was asked to do.
    get stopped() { return stopped; },
    add(usd) { spent += usd ?? 0; },
    allows() {
      if (maxUsd === undefined || spent < maxUsd) return true;
      stopped = true;
      return false;
    },
  };
}
