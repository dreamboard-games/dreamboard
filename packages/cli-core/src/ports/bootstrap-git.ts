export interface BootstrapGit {
  init(root: string, initialBranch: "main"): Promise<void>;
  clone(
    url: string,
    destination: string,
    options?: { config?: ReadonlyArray<readonly [string, string]> },
  ): Promise<void>;
  setRemote(root: string, name: "origin", url: string): Promise<void>;
  setLocalConfig(root: string, key: string, value: string): Promise<void>;
}

export interface CommitReader {
  resolveCommit(root: string, revision: string): Promise<string>;
  remoteUrl(root: string, name: "origin"): Promise<string | null>;
  statusPorcelain(root: string): Promise<string>;
  createDetachedWorktree(
    root: string,
    commitOid: string,
    destination: string,
  ): Promise<void>;
  removeWorktree(root: string, destination: string): Promise<void>;
}
