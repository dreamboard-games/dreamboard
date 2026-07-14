export const CONFIG_FLAG_ARGS = {
  env: {
    type: "string" as const,
    description: "Environment: local | staging | prod",
  },
  token: {
    type: "string" as const,
    description: "Auth token (Dreamboard bearer JWT)",
  },
};
