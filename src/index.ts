import express from "express";
import path from "path";
import { createServer } from "http";
import { ChatDatabase } from "./db";
import { manager } from "./websocket";
import { createRouter } from "./routes";

async function main() {
  const app = express();
  const PORT = parseInt(process.env.PORT || "10000", 10);
  const HOST = process.env.HOST || "127.0.0.1";

  // Initialize database
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), "chatbot.db");
  const db = await ChatDatabase.create(dbPath);

  // Middleware
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));

  // Static files
  app.use("/static", express.static(path.join(__dirname, "..", "public")));

  // Main page (before auth middleware)
  app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  // Favicon (before auth middleware)
  app.get("/favicon.ico", (_req, res) => {
    res.setHeader("Content-Type", "image/svg+xml");
    res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">&#x1F60A;</text></svg>`);
  });

  // Create HTTP server
  const server = createServer(app);

  // Setup WebSocket
  manager.setup(server);

  // API routes (includes auth middleware)
  app.use(createRouter(db));

  // Start server
  server.listen(PORT, HOST, () => {
    console.log(`aiaio server running at http://${HOST}:${PORT}`);
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("Shutting down...");
    db.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("Shutting down...");
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
