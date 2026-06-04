import { getDb } from "./db/index.js";

async function main() {
  const db = getDb();
  const accounts = await db.query.accounts.findMany();
  console.log("ACCOUNTS:", JSON.stringify(accounts, null, 2));
}
main().catch(console.error);
