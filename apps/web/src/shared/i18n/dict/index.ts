// Merged dictionary.
//
// Every `*.ts` module in this folder (except this index) default-exports a flat
// `Record<string, string>` mapping an English source string to its Chinese
// translation. They are discovered at build time via Vite's `import.meta.glob`
// with `{ eager: true }`, so adding a new domain is just dropping a file here
// (e.g. `dict/lobby.ts`) — this file never needs editing.
//
// Key collision policy: later modules win. Glob keys are sorted by path, so the
// merge order is deterministic.
const modules = import.meta.glob<{ default: Record<string, string> }>('./*.ts', {
  eager: true,
});

const dict: Record<string, string> = {};
for (const [path, mod] of Object.entries(modules)) {
  if (path.endsWith('/index.ts')) continue;
  Object.assign(dict, mod.default);
}

export default dict;
