// Limits QuickJS interrupt callbacks across the whole invocation, including async segments.
// This is a deterministic work budget, NOT an exact instruction count or elapsed milliseconds.
const states = new WeakMap();
const MAX_CALLBACKS = 2000;
export function installExecutionBudget(runtime) {
  let state = states.get(runtime);
  if (!state) { state = { callbacks: 0, limit: MAX_CALLBACKS }; states.set(runtime, state); }
  runtime.setInterruptHandler(() => ++state.callbacks >= state.limit);
}
export function readExecutionBudget(runtime) {
  return states.get(runtime) || { callbacks: 0, limit: MAX_CALLBACKS };
}
