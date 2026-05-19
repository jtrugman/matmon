# Matmon — instructions for Claude

This file is auto-loaded into every Claude Code session that touches this repo. It encodes hard project rules. Read it before doing anything that touches git or the UI.

## 🚫 NEVER push directly to `main`. ALWAYS open a PR.

The single hardest rule in this repo. Every code change goes through a feature branch + pull request that Justin reviews and merges himself. Do not push to `main` even for "obvious" fixes, even for the first commit, even when no other contributors exist.

## 🚫 Don't commit or push without explicit permission

Beyond the PR rule: do not run `git commit` or `git push` on ANY branch (including the open feature/PR branch) until Justin explicitly asks. Make changes, run tests, report what's ready, then STOP. Wait for "commit it" / "push" / "ship it" / etc.

**Workflow for any change:**

```bash
git checkout -b <type>/<short-description>   # e.g. fix/onboarding-shell, feat/brokerage-drilldown
# ...edit, test, build...
git add -A
git commit -m "..."
git push -u origin <branch-name>
gh pr create --base main --title "..." --body "..."
```

Branch prefixes to use:
- `fix/` — bug fixes
- `feat/` — new features
- `chore/` — tooling, deps, refactors
- `docs/` — README / CONTRIBUTING / etc.

**The only exception:** Justin explicitly says "push to main" or "no PR needed" in his message. Otherwise default to PR every time. When confirming an action, say "I'll open a PR" so the rule is visibly being honored.

This rule exists because Justin had to undo a direct-to-main initial commit on 2026-05-17 and was (rightly) very annoyed.

## UI / copy rules

- **No em dashes** anywhere — Justin's global preference. Use commas, parens, semicolons. The one Unicode hyphen `—` is acceptable only for "no data" fallback displays.
- **No Hebrew** in user-facing UI. Single italicized Hebrew word in the About section's etymology blurb is the maximum. Everywhere else: English only.
- **No "demo data" in production builds.** Real users on first launch get the onboarding flow. Demo data is opt-in via a "Try with a sample portfolio" button in the welcome step. The Tweaks panel is dev-only (gated by `import.meta.env.DEV`).
- **Avoid double window-frame chrome.** When `isTauri()` is true, hide the prototype's fake titlebar and let the page background fill edge-to-edge. The same applies to the onboarding shell.

## Tech stack invariants (from PRD §6)

- Tauri 2 + React 18 + TypeScript + Vite + SQLite (`tauri-plugin-sql`)
- Yahoo Finance chart endpoint for quotes (the `/v7/quote` endpoint now requires a crumb token, do not use)
- All financial data stays local. Only outbound calls: anonymous ticker lookups to Yahoo. Network log surfaced in Settings → Privacy.
- Browser dev mode uses a localStorage-backed shim for the DB so `npm run dev` works without Rust installed.

## Things to NOT touch unless explicitly asked

- The PRD (`PRD.md` at repo root) — that's Justin's spec. Don't edit.
- `app/example_csv/` — gitignored real brokerage exports. Never commit; never copy values into committed files. Anonymized fixtures live under `app/src/lib/importers/__fixtures__/`.
- The `MATMON_DATA` demo dataset in `app/src/data.ts` — that's the seeded sample portfolio for opt-in demo mode.

## Quality bars before opening a PR

```bash
cd app
npm test       # all tests must pass (205+ as of 2026-05-17)
npm run build  # tsc --noEmit + vite production build, both green
```

Also do a quick paranoia scan if you touched anything near the importers or fixtures.

Real account numbers and CUSIPs from Justin's actual portfolio (kept in a local-only file at `~/.matmon-fingerprints`) must NEVER land in committed files, including code comments, lint scripts, READMEs, or paranoia-check regexes. Run the check below before any commit; the regex pattern is loaded from the local-only fingerprint file so the literals never enter the repo.

```bash
cd /Users/justintrugman/Development/matmon
FINGERPRINTS_FILE="$HOME/.matmon-fingerprints"
if [ -f "$FINGERPRINTS_FILE" ]; then
  PATTERN=$(tr '\n' '|' < "$FINGERPRINTS_FILE" | sed 's/|$//')
  git diff --cached | grep -E "$PATTERN" && echo "LEAK" || echo "clean"
else
  echo "skip: no $FINGERPRINTS_FILE on this machine"
fi
```

The `~/.matmon-fingerprints` file holds one literal per line (account numbers, CUSIPs, anything else that uniquely identifies Justin's real portfolio). It is outside the repo and never tracked. If a contributor doesn't have one, the check is a no-op; if Justin does, every staged diff is scanned before commit. The security audit on 2026-05-17 found that the prior version of this check leaked the very literals it was meant to catch; do not reintroduce them.
