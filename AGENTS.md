# Agent instructions

## Commits and pull requests

- Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope): description`, with `!` before the colon for a breaking change. Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- PRs are squash-merged and the commit on `main` is the PR title alone, so the title is the commit message that stays.
- No coding-agent attribution in commits or PR titles: no `Co-authored-by:` trailer for Claude, Codex, Cursor, Copilot or any other assistant, and no "Generated with …" line. CI (`.github/workflows/pr-conventions.yml`) fails a PR that has one. Leave it out of PR descriptions as well; a footer a GitHub tool appends there by itself may stay (the description never reaches `main`, and CI doesn't check it).

## Workflow

- `main` takes changes only through pull requests, with CI green; nobody pushes to it, agents included.
- Work in a worktree of your own, branched from `origin/main` (`git worktree add ../engenty-wizards-<name> -b <type>/<name> origin/main`), never in the shared main checkout.
- Push the branch, open a pull request with `gh pr create`, and turn on auto-merge (`gh pr merge --auto --squash`) once the work is done; it merges when CI is green.
- Releases are pull requests too: `pnpm release` commits on `release/vX.Y.Z`; after the merge, `pnpm release:tag` tags main's release commit and pushes the tag (docs/development.md).

## Copy

- Words people read follow [docs/copy-style.md](docs/copy-style.md); `pnpm copy:check` checks it.
