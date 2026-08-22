import { createFinanceApp } from "./app";

const rawPort = process.env.PORT;
if (!rawPort) throw new Error("PORT environment variable is required.");
const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0) throw new Error("PORT must be a positive integer.");
const host = process.env.HOST?.trim() || "0.0.0.0";

const app = await createFinanceApp();
const server = app.listen(port, host, () => {
  process.stdout.write(`FPS Finance server listening on ${host}:${port}\n`);
});

server.on("error", (error) => {
  process.stderr.write(`FPS Finance server failed before listening: ${error.message}\n`);
  process.exitCode = 1;
});