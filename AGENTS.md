# AGENTS.md

Rules for AI coding agents (and humans) working in this repository.

## Project

`html2epub` converts the current web page into an EPUB (e.g. for a reMarkable tablet).

- **Entry point:** a bookmarklet. It must stay tiny: it only injects a loader script.
- **Code and libraries:** hosted on this repo's GitHub Pages site
  (`https://theboywho.github.io/html2epub/`). The bookmarklet loads everything from there.
- **No third-party CDNs at runtime.** Any library the converter needs is vendored into this
  repo and served from GitHub Pages, with its version and licence recorded.
- **Runs entirely in the browser.** No server, no uploading page content anywhere.

### Known constraints

- Some sites set a Content-Security-Policy that blocks scripts from other origins. The
  bookmarklet cannot bypass this; fail with a clear message rather than silently.
- Output must be a valid EPUB (check with [EPUBCheck](https://github.com/w3c/epubcheck)
  where possible).

## Workflow

1. **Always work in a branch.** Never commit directly to `main`.
2. **All changes land via a pull request.** No direct pushes to `main`.
3. **Commit as you go.** Make small, focused commits as each step of a task is done,
   rather than one large commit at the end.
4. **Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)**:
   `<type>(<optional scope>): <description>`
   - Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
   - Breaking changes: add `!` after the type/scope and a `BREAKING CHANGE:` footer.
   - Examples: `feat(bookmarklet): add loader`, `docs: update README`, `chore(vendor): add library`
5. **Fill in the PR template** (`.github/pull_request_template.md`) for every PR.
6. **Branch names** should be short and descriptive, e.g. `feat/bookmarklet-loader`,
   `fix/image-encoding`, `docs/agents`.

## Code guidelines

- Keep the bookmarklet minimal; put logic in the hosted scripts.
- Prefer plain, dependency-light JavaScript that runs in modern browsers without a build step,
  unless a build step is agreed in a PR.
- Don't pollute the host page: avoid leaking globals and clean up any injected UI.
- Update `README.md` when user-facing behaviour (install, usage) changes.
- Don't guess: if requirements are unclear, ask before implementing.
