import { snapshotDatabase } from "../infrastructure/database/snapshot-database.js";

const source = valueFor("--source");
const destination = valueFor("--dest");
if (!source || !destination) {
  throw new Error("Usage: pnpm db:snapshot -- --source <sqlite> --dest <sqlite>");
}
process.stdout.write(`${JSON.stringify(snapshotDatabase(source, destination), null, 2)}\n`);

function valueFor(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}
