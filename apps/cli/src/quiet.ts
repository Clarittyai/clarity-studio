/**
 * Silence one warning, before anything else loads.
 *
 * This lives in its own module because ES module imports are hoisted and
 * evaluated in order: a filter written inline in the entry file runs *after*
 * every import has already executed, which is exactly when the warning fires.
 * Importing this first is the only placement that works.
 *
 * Node's built-in SQLite is still flagged experimental. Using it is a
 * deliberate trade (no native modules, so `npm install` never needs a C++
 * toolchain — see packages/db/src/schema.ts), and the warning is not something
 * a user can act on. Every other warning still gets through.
 */

const original = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (text.includes('SQLite is an experimental feature')) return;
  return (original as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
