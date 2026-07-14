import type { BootstrapGit } from "../ports/bootstrap-git.js";

export async function configureDreamboardGitRepository(input: {
  git: Pick<BootstrapGit, "setLocalConfig">;
  root: string;
  credentialHelper: string;
  hooksPath?: string;
}): Promise<void> {
  await input.git.setLocalConfig(input.root, "credential.useHttpPath", "true");
  await input.git.setLocalConfig(input.root, "credential.helper", "");
  await input.git.setLocalConfig(
    input.root,
    "--add credential.helper",
    input.credentialHelper,
  );
  await input.git.setLocalConfig(input.root, "http.followRedirects", "false");
  await input.git.setLocalConfig(
    input.root,
    "core.hooksPath",
    input.hooksPath ?? ".dreamboard/hooks",
  );
}
