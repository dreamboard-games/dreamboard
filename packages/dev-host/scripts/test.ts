import path from "node:path";

const projectRoot = path.resolve(import.meta.dir, "..");
const requestedPatterns = process.argv.slice(2);
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
    ? discoveredFiles
    : discoveredFiles.filter((filePath) =>
        requestedPatterns.some((pattern) => filePath.includes(pattern)),
      );

if (filesToRun.length === 0) {
  const requestedSummary =
    requestedPatterns.length === 0
      ? "the dev-host package"
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
