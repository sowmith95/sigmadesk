# Default playbook

Edit this file (or point `project.playbook` at your own) to teach the desk how your repository works.
Every seat reads it on every run. Keep it short and concrete.

## How to test
- Find the project's test runner (package.json scripts, pytest.ini, Makefile, go.mod, Cargo.toml).
- Run only the tests related to your change. Never start long-running services.

## Conventions
- Follow the existing code style and directory layout; read neighbouring files before writing new ones.
- Every behaviour change ships with a test.

## Off limits
- Secrets files, deployment configuration, CI workflows, and anything that talks to production.
