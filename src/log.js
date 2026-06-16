const listeners = new Set();

export function addLogListener(fn) { listeners.add(fn); }
export function removeLogListener(fn) { listeners.delete(fn); }

export function log(type, message) {
  const entry = { type, message, time: new Date().toISOString() };
  for (const fn of listeners) fn(entry);
}
