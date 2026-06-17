import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./openapi/documentation.yaml",
  output: {
    path: "src",
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
