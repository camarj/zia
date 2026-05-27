# Contributing to zia

Thanks for considering a contribution. zia is built and used by the [Inteliside](https://inteliside.com) team in Guayaquil, Ecuador, and opened to the community as a byproduct.

## Development workflow

We use **Spec-Driven Development** via [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai). Every non-trivial feature follows 4 phases with artifacts in `docs/SDD/`:

1. `/sdd-design` — architectural sketch (model: Opus).
2. `/sdd-spec` — detailed spec with interfaces and acceptance criteria (Opus).
3. `/sdd-implement` — TDD implementation against the spec (Sonnet).
4. `/sdd-review` — adversarial review against the spec (Sonnet).

For trivial changes (typo fixes, doc updates), skip SDD and open a PR directly.

## Setup

```bash
pnpm install
gentle-ai sdd-init
pnpm typecheck && pnpm test
```

See [`docs/SETUP.md`](docs/SETUP.md) for the full setup including Claude Code skills.

## Code standards

- TypeScript strict mode, no `any`.
- ESM only (no CommonJS).
- Tests with vitest. Add a test for every behavior change.
- Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- Run `pnpm typecheck && pnpm test && pnpm lint` before submitting.

## Where things live

- New tool? → `packages/tools/builtins/` or `packages/tools/adapters/`.
- New gateway (channel)? → `packages/gateways/platforms/`.
- New LLM provider? → `packages/providers/`.
- New role template? → `agents/_templates/<role>/`.
- Architecture decisions? → `docs/SDD/<feature>/design.md`.

## Reporting bugs

Use the GitHub issue templates in `.github/ISSUE_TEMPLATE/`. Include:

- zia version (`pnpm zia --version`).
- pi.dev SDK version.
- Minimal repro (a ficha that triggers the issue).
- Audit log excerpt if relevant.

## Pull requests

- One concern per PR.
- Link the SDD spec when applicable (`Closes #<issue>` or `Refs docs/SDD/<feature>`).
- Make sure CI passes (typecheck + test).
- Be patient — reviewers might take a few days.

## Code of Conduct

We follow the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md). Be kind. Disagree with arguments, not people.

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
