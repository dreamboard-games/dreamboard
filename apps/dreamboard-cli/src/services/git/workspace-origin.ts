import {
  SystemGit,
  configureDreamboardGitRepository,
} from "@dreamboard-games/cli-core";

export async function configureWorkspaceGitOrigin(options: {
  projectRoot: string;
  cloneUrl: string;
}): Promise<void> {
  const git = new SystemGit();
  await git.init(options.projectRoot, "main");
  await git.setRemote(options.projectRoot, "origin", options.cloneUrl);
  await configureDreamboardGitRepository({
    git,
    root: options.projectRoot,
    credentialHelper: "!dreamboard auth git-credential",
  });
}
