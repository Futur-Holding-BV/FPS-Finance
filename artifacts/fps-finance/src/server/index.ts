import { createFinanceApp } from "./app";

const rawPort = process.env.PORT;
if (!rawPort) throw new Error("PORT environment variable is required.");
const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0) throw new Error("PORT must be a positive integer.");

const app = await createFinanceApp();
app.listen(port, () => {
  process.stdout.write(`FPS Finance server listening on ${port}\n`);
});