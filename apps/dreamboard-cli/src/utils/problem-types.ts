import {
  CLIENT_PROBLEM_TYPES,
  SERVER_PROBLEM_TYPES,
} from "@dreamboard-games/api-client/problem-types";

export { CLIENT_PROBLEM_TYPES, SERVER_PROBLEM_TYPES };

export const CLI_PROBLEM_TYPES = {
  ...SERVER_PROBLEM_TYPES,
  ...CLIENT_PROBLEM_TYPES,
} as const;

export type CliProblemType =
  (typeof CLI_PROBLEM_TYPES)[keyof typeof CLI_PROBLEM_TYPES];
