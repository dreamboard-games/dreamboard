import { defineCommand } from "citty";
import consola from "consola";

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Check the local Dreamboard CLI installation",
  },
  async run() {
    consola.success("Dreamboard CLI is installed.");
  },
});
