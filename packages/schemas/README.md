# `packages/schemas` — the single source of truth

JSON Schema files here are the contract in **three places at once** (`TD §4`):

```
packages/schemas/*.json  ──┬──▶ Pydantic models  (datamodel-code-generator) → backend validation
                           ├──▶ TypeScript types (json-schema-to-typescript) → renderer input
                           └──▶ output_config.format (passed verbatim)       → the LLM contract
```

**Never hand-edit a generated model.** Edit the schema and regenerate. A hand-edit makes the
LLM contract and the renderer silently disagree, and the failure surfaces as a mysteriously
empty section in a user's study guide rather than as an error.

Generated output is committed, and CI fails on a stale diff:

```bash
npm run schemas:generate
git diff --exit-code        # must be empty
```

The six artifact schemas (`TD §4.2`–`§4.7`) and the generation pipeline are authored in **T-005**.
This directory is scaffold until then.
