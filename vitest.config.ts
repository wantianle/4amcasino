import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `.slim/worktrees/**` is throwaway git-worktree scaffolding (oh-my-opencode-slim).
    // A checked-out worktree carries its own copy of every test file; the root suite
    // must not run those duplicates as if they were this repository's tests.
    exclude: [...configDefaults.exclude, '.slim/**'],
  },
});
