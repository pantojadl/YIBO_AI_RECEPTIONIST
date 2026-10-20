import { resolve } from "node:path";
import { validateAsteriskTemplates } from "../launch/asterisk-templates.js";

const directory = resolve(process.argv[3] && process.argv[2] === "--dir" ? process.argv[3] : "deploy/asterisk");
const errors = validateAsteriskTemplates(directory);
if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Asterisk templates ok: ${directory}\n`);
