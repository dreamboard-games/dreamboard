# @dreamboard-games/reducer-contract

Wire contract between Dreamboard reducer bundles and the runtime that executes
them.

This package is published as `@dreamboard-games/reducer-contract`. Dreamboard
workspace tooling may install it through the npm alias
`@dreamboard/reducer-contract` so generated and authored source can keep stable
import paths.

## Contents

- JSON Schema for reducer runtime messages.
- Generated TypeScript wire types and Zod validators.
- Generated effect builders.
- Canonical fixture corpus used for JS/Kotlin conformance checks.

The schema files in `schema/` are the authoritative contract. Generated
TypeScript and Kotlin artifacts are derived from that schema and should stay in
lockstep with it.

