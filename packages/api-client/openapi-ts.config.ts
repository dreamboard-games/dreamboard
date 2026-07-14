import { defineConfig } from "@hey-api/openapi-ts";
import path from "node:path";

const packageRoot = import.meta.dirname;
const outputRoot = process.env.DREAMBOARD_GENERATED_OUTPUT_ROOT
  ? path.resolve(process.env.DREAMBOARD_GENERATED_OUTPUT_ROOT)
  : path.join(packageRoot, "src");

export default defineConfig({
  input: path.join(packageRoot, "openapi/documentation.yaml"),
  output: {
    path: outputRoot,
    // NodeNext consumers (e.g. workspace-codegen) require explicit .js specifiers in imports.
    module: { extension: ".js" },
  },
  plugins: [
    "@hey-api/client-fetch",
    "@hey-api/sdk",
    "@tanstack/react-query",
    {
      name: "zod",
      exportFromIndex: true,
    },
  ],
});
