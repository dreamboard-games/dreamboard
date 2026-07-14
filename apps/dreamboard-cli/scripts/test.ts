import path from "node:path";

const projectRoot = path.resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const excludePackage = args.includes("--exclude-package");
const requestedPatterns = args.filter((arg) => arg !== "--exclude-package");
const discoveredFiles: string[] = [];

for await (const file of new Bun.Glob("src/**/*.test.ts").scan({
  cwd: projectRoot,
  absolute: false,
})) {
  discoveredFiles.push(file);
}

discoveredFiles.sort();

const filesToRun =
  requestedPatterns.length === 0
    ? discoveredFiles.filter(
        (filePath) =>
          !excludePackage || filePath !== "src/published-package-smoke.test.ts",
      )
    : discoveredFiles.filter((filePath) =>
        requestedPatterns.some((pattern) => filePath.includes(pattern)),
      );

if (filesToRun.length === 0) {
  const requestedSummary =
    requestedPatterns.length === 0
      ? "the CLI package"
      : requestedPatterns.join(", ");
  throw new Error(`No test files matched ${requestedSummary}.`);
}

const bunExecutable = Bun.which("bun") ?? process.execPath;

for (const filePath of filesToRun) {
  console.log(`\n==> bun test ${filePath}`);
  const result = Bun.spawnSync({
    cmd: [bunExecutable, "test", filePath],
    cwd: projectRoot,
    stdout: "inherit",
    stderr: "inherit",
  });

  if (result.exitCode !== 0) {
    process.exit(result.exitCode ?? 1);
  }
}
