import {
  SystemGit,
  configureDreamboardGitRepository,
} from "@dreamboard-games/cli-core";

const DREAMBOARD_GIT_CREDENTIAL_HELPER = "!dreamboard auth git-credential";

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
    credentialHelper: DREAMBOARD_GIT_CREDENTIAL_HELPER,
  });
}

export async function cloneDreamboardGitRepository(options: {
  cloneUrl: string;
  destination: string;
}): Promise<void> {
  const git = new SystemGit();
  await git.clone(options.cloneUrl, options.destination, {
    config: [
      ["credential.useHttpPath", "true"],
      ["credential.helper", ""],
      ["credential.helper", DREAMBOARD_GIT_CREDENTIAL_HELPER],
      ["http.followRedirects", "false"],
    ],
  });
  await configureDreamboardGitRepository({
    git,
    root: options.destination,
    credentialHelper: DREAMBOARD_GIT_CREDENTIAL_HELPER,
  });
}
