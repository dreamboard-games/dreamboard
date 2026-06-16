import cmdAuth from "./commands/auth.js";
import cmdQuery from "./commands/query.js";
import { runDreamboardCli } from "./cli-main.js";

runDreamboardCli({ query: cmdQuery, auth: cmdAuth });
