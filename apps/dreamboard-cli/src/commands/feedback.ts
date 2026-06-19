import { defineCommand } from "citty";
import consola from "consola";

const submitCommand = defineCommand({
  meta: {
    name: "submit",
    description: "Submit product feedback",
  },
  args: {
    message: {
      type: "positional",
      description: "Feedback message",
      required: false,
    },
  },
  async run() {
    consola.info(
      "Feedback submission is not yet connected to a public backend endpoint.",
    );
  },
});

export default defineCommand({
  meta: {
    name: "feedback",
    description: "Send feedback to Dreamboard",
  },
  subCommands: {
    submit: submitCommand,
  },
});
