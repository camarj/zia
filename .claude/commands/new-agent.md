---
name: new-agent
description: Scaffold a new agent ficha in agents/$ARGUMENTS with all required files.
---

Scaffold a new agent at `agents/$ARGUMENTS/` by copying from `agents/_template/` and filling in the unique fields.

## Steps

1. Verify `agents/$ARGUMENTS/` does NOT already exist. If it does, abort with an error.

2. Copy every file from `agents/_template/` to `agents/$ARGUMENTS/`:
   - `SOUL.md`
   - `POLICIES.md`
   - `KNOWLEDGE.md`
   - `MEMORY.md`
   - `profile.yaml`
   - `tools.yaml`
   - `mcp.yaml`

3. Use AskUserQuestion to collect the unique fields:
   - **name** (display name, e.g. "Asistente Financiero")
   - **email** (e.g. `finanzas@inteliside.com`)
   - **boss email** (the human boss's email)

4. Replace the placeholders in the copied files:
   - `profile.yaml`:
     - `agent.id`: `$ARGUMENTS-001`
     - `agent.name`: collected name
     - `agent.email`: collected email
     - `bosses[0].email`: collected boss email
   - `SOUL.md`: replace `[ROLE]` with the collected name.

5. After scaffolding, print a summary that includes:
   - Files created.
   - The env vars the user must export before running the agent (look in `profile.yaml` for every `*_env:` reference).
   - Next step: edit `SOUL.md` and `POLICIES.md`, then `pnpm --filter @zia/core validate-ficha agents/$ARGUMENTS`.

6. If `pnpm --filter @zia/core validate-ficha` exists (Phase 1+), run it and report.

## Do NOT

- Generate or include any actual API key, password, or token. Only env var names.
- Commit the new ficha — leave that to the user.
