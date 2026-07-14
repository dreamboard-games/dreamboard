import path from "node:path";
import type { Plugin } from "vite";

export function createDevHmrGuardPlugin(options: {
  projectRoot: string;
}): Plugin {
  return {
    name: "dreamboard-dev-hmr-guard",
    handleHotUpdate(context) {
      if (shouldHandleProjectHotUpdate(options.projectRoot, context.file)) {
        return undefined;
      }

      context.server.config.logger.info(
        `[dreamboard] ignored HMR outside project: ${path.relative(
          options.projectRoot,
          context.file,
        )}`,
      );
      return [];
    },
  };
}

export function shouldHandleProjectHotUpdate(
  projectRoot: string,
  file: string,
): boolean {
  const normalizedProjectRoot = path.resolve(projectRoot);
  const normalizedFile = path.resolve(file);
  const relativePath = path.relative(normalizedProjectRoot, normalizedFile);
  const isInsideProject =
    relativePath === "" ||
    (relativePath.length > 0 &&
      !relativePath.startsWith("..") &&
      !path.isAbsolute(relativePath));

  if (!isInsideProject) {
    return false;
  }

  const pathSegments = relativePath.split(path.sep);
  return (
    !pathSegments.includes(".dreamboard") &&
    !pathSegments.includes("node_modules")
  );
}
