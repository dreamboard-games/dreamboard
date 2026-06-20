export type AccessToken = {
  readonly token: string;
  readonly expiresAt?: string;
  readonly audience: "dreamboard-api" | "dreamboard-git";
};

export type RefreshableUserSession = {
  readonly clerkAccessToken: string;
  readonly refreshToken: string;
  readonly clerkAccessExpiresAt?: string;
  readonly clerkOAuthIssuer?: string;
  readonly clerkOAuthClientId?: string;
  readonly clerkOAuthTokenUrl?: string;
  readonly environment?: string;
};

export type UserSessionStatus =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "active";
      readonly sessionKind: "access-only" | "refreshable";
      readonly apiToken: AccessToken;
      readonly repaired: boolean;
    }
  | {
      readonly kind: "degraded";
      readonly sessionKind: "refreshable";
      readonly message: string;
    }
  | {
      readonly kind: "invalid";
      readonly sessionKind: "access-only" | "refreshable";
      readonly message: string;
    };

export interface UserSessionManager {
  establishRefreshableSession(
    session: RefreshableUserSession,
  ): Promise<AccessToken>;
  establishAccessOnlySession(accessToken: string): Promise<void>;
  resolveApiToken(options?: {
    minValiditySeconds?: number;
  }): Promise<AccessToken | null>;
  resolveGitToken(): Promise<AccessToken>;
  inspectSession(): Promise<UserSessionStatus>;
  logout(): Promise<void>;
}
