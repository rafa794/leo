# Copilot instructions

Everything an agent needs to work on Orion is in [`AGENTS.md`](../AGENTS.md) at the repository root:
what the project is, its rules (free, local, no GPU required, no paid services, translations for every UI text),
the architecture, commands, tests, release process and known traps. **Read it before making changes.**

Short version:
- Talk to the maintainer in Spanish; code and docs in English; UI text in Spanish first + `src/i18n/{en,fr,pt}.json`.
- Tracks are ordered top → bottom and the top one is in front; keep both timelines in that order.
- Before finishing: `npx tsc --noEmit -p .`, `npm test`, `npm run test:app`, then rebuild the app (`npm run mac:build`).
- Never commit secrets or signing keys, and never reference the maintainer's employer or work accounts.
