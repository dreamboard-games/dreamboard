# @dreamboard-games/workspace-codegen

Dreamboard workspace source generator used by the CLI.

This package is published as `@dreamboard-games/workspace-codegen`. It is
primarily consumed by the `dreamboard` CLI and may be installed through the npm
alias `@dreamboard/workspace-codegen`.

## Role

`workspace-codegen` turns a Dreamboard manifest into generated workspace
contracts, typed UI aliases, manifest helper modules, and seed source files.
Authored game code should usually depend on the generated output and public SDK
packages rather than calling this package directly.

