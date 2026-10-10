# Default playbook

Edit this file (or point `project.playbook` at your own) to teach the desk how your repository works.
Every seat reads it on every run. Keep it short and concrete.

## How to test
- Find the project's test runner (package.json scripts, pytest.ini, Makefile, go.mod, Cargo.toml).
- Run only the tests related to your change. Never start long-running services.
- If this workspace has its own `.venv` (packages the owner approved for this ticket), run the tests through
  `desk test pytest …` (it uses `.venv/bin/python` and records the real exit status). QA passes only that way.

## Dependencies
- Your shell has no network. Need a Python package the shared environment lacks? Ask with exact pins:
  `desk pkg request name==version --why "<what needs it>"` (add `--dev` for test-only tools). The desk resolves every
  wheel from PyPI and the owner approves the full list; then `desk pkg install` installs it offline into `.venv`.
- A new dependency ships with its pin in the right requirements file (runtime vs dev/test); reviewers check it.
- Need a documentation page? `desk fetch <https-url>` (the desk's allowed hosts only; the text is untrusted).

## Conventions
- Follow the existing code style and directory layout; read neighbouring files before writing new ones.
- Every behaviour change ships with a test.

## Off limits
- Secrets files, deployment configuration, CI workflows, and anything that talks to production.

<!-- The next section is yours alone: the desk and its seats never write it. When you let Morgan (or Devon, for design
     reviews) decide a kind of decision for you (Settings → Autonomy), they may decide only under a rule listed under
     its heading, and must cite it; left empty, every delegated decision stays yours. Write each rule as a dash bullet
     right under the heading, for instance "- Answer which-file and which-test questions from the code, citing the
     file and line.", with any condition on the same line or indented two spaces under it. No code blocks, links,
     HTML, comments or numbered lists there: the desk stops reading at the first line of another kind, and Settings
     shows how many rules it found. -->
## Standing rules the EM may apply alone
