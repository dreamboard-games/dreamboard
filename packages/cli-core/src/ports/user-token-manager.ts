export type AccessToken = {
  readonly token: string;
  readonly expiresAt?: string;
  readonly audience: "dreamboard-api" | "dreamboard-git";
};

export interface UserTokenManager {
  resolveApiToken(options?: {
    minValiditySeconds?: number;
  }): Promise<AccessToken | null>;
  resolveGitToken(): Promise<AccessToken>;
  logout(): Promise<void>;
}
