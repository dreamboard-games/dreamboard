export function getPublishedPackageFiles(
  hasPublicSkillRoot: boolean,
): string[] {
  return hasPublicSkillRoot
    ? ["dist", "README.md", "LICENSE", "NOTICE", "skills"]
    : ["dist", "README.md", "LICENSE", "NOTICE"];
}
