export type ScaffoldingOwnership = {
  version: number;
  allowedPaths: {
    rootFiles: string[];
    directoryPrefixes: string[];
  };
  dynamic: {
    generatedFiles: string[];
    seedFiles: string[];
    seedFilePatterns: Array<{ prefix: string; suffix: string }>;
  };
  cliStatic: {
    exactFiles: string[];
    directoryPrefixes: string[];
  };
  preservedUserFiles: string[];
};

export const SCAFFOLD_OWNERSHIP: ScaffoldingOwnership = {
  version: 30,
  allowedPaths: {
    rootFiles: [
      ".npmrc",
      "package.json",
      "pnpm-lock.yaml",
      "package-lock.json",
      "manifest.ts",
      "manifest.tsconfig.json",
      "rule.md",
    ],
    directoryPrefixes: ["app/", "manifest/", "ui/", "shared/", "test/"],
  },
  dynamic: {
    generatedFiles: [
      "shared/manifest-literals.ts",
      "shared/manifest-types.ts",
      "shared/manifest-static.json",
      "shared/manifest-runtime.ts",
      "shared/manifest-contract.ts",
      "shared/generated/ui-contract.ts",
      "app/index.ts",
      "app/tsconfig.framework.json",
      "ui/tsconfig.framework.json",
    ],
    seedFiles: [
      "app/README.md",
      "ui/App.tsx",
      "app/game-contract.ts",
      "app/authoring.ts",
      "app/game.ts",
      "app/setup-profiles.ts",
      "app/reducer-support.ts",
      "app/derived.ts",
      "ui/interaction-routes.tsx",
      "ui/setup-screen.tsx",
      "ui/styles.ts",
      "ui/ui-contract-typing-smoke.tsx",
    ],
    seedFilePatterns: [{ prefix: "app/phases/", suffix: ".ts" }],
  },
  cliStatic: {
    exactFiles: [
      ".npmrc",
      "package.json",
      "app/tsconfig.json",
      "ui/index.tsx",
      "ui/package.json",
      "ui/style.css",
      "ui/tsconfig.json",
    ],
    directoryPrefixes: [],
  },
  preservedUserFiles: [],
};
