import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { ChatDatabase } from "./db";
import { manager } from "./websocket";
import { textStreamer } from "./openai";
import { SUMMARY_PROMPT } from "./prompts";

const TEMP_DIR = path.join(require("os").tmpdir(), "aiaio_uploads");
fs.mkdirSync(TEMP_DIR, { recursive: true });

const upload = multer({ dest: TEMP_DIR });

function generateSafeFilename(originalFilename: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = path.extname(originalFilename);
  const base = path
    .basename(originalFilename, ext)
    .replace(/[^\w\-_]/g, "_");
  return `${base}_${timestamp}${ext}`;
}

/** Helper to safely extract a route param as string */
function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val;
}

export function createRouter(db: ChatDatabase): Router {
  const router = Router();

  // --- Auth middleware ---
  // Simple token-based auth: store valid tokens in memory
  const validTokens = new Set<string>();

  function generateToken(): string {
    return Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
  }

  function requireAuth(req: Request, res: Response, next: Function): void {
    const token = req.headers["x-auth-token"] as string;
    if (!token || !validTokens.has(token)) {
      res.status(401).json({ detail: "Unauthorized" });
      return;
    }
    next();
  }

  // --- Auth endpoints (no auth required) ---
  router.post("/auth/login", (req: Request, res: Response) => {
    try {
      const { code } = req.body;
      const storedCode = db.getAccessCode();
      if (!storedCode || code !== storedCode) {
        res.status(401).json({ detail: "Invalid access code" });
        return;
      }
      const token = generateToken();
      validTokens.add(token);
      res.json({ token });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.post("/auth/change-code", requireAuth, (req: Request, res: Response) => {
    try {
      const { new_code } = req.body;
      if (!new_code || new_code.length < 4) {
        res.status(400).json({ detail: "Access code must be at least 4 characters" });
        return;
      }
      db.setAccessCode(new_code);
      // Invalidate all existing tokens to force re-login
      validTokens.clear();
      res.json({ status: "success" });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.get("/auth/status", (req: Request, res: Response) => {
    res.json({ needs_code_change: db.getAccessCode() === "aiaio-ts" });
  });

  // --- Apply auth middleware to all API routes below ---
  router.use(requireAuth);

  // --- Version ---
  router.get("/version", (_req: Request, res: Response) => {
    res.json({ version: "0.10.0" });
  });

  // --- Conversations ---
  router.get("/conversations", (req: Request, res: Response) => {
    try {
      const projectId = req.query.project_id as string | undefined;
      const conversations = db.getAllConversations(projectId);
      res.json({ conversations });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.get("/conversations/:conversation_id", (req: Request, res: Response) => {
    try {
      const conversationId = param(req, "conversation_id");
      const history = db.getConversationHistory(conversationId);
      if (!history.length) {
        res.status(404).json({ detail: "Conversation not found" });
        return;
      }
      res.json({ messages: history });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.post("/create_conversation", (req: Request, res: Response) => {
    try {
      const projectId = req.body?.project_id;
      const conversationId = db.createConversation(projectId);
      manager.broadcast({ type: "conversation_created", conversation_id: conversationId });
      res.json({ conversation_id: conversationId });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.post("/conversations/:conversation_id/messages", (req: Request, res: Response) => {
    try {
      const { role, content, content_type, attachments } = req.body;
      const messageId = db.addMessage(
        param(req, "conversation_id"),
        role,
        content,
        content_type || "text",
        attachments
      );
      res.json({ message_id: messageId });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.put("/messages/:message_id", (req: Request, res: Response) => {
    try {
      const { content } = req.body;
      const success = db.editMessage(param(req, "message_id"), content);
      if (!success) {
        res.status(404).json({ detail: "Message not found" });
        return;
      }

      // Get message role for broadcast
      const msgRole = db.getMessageRole(param(req, "message_id"));

      manager.broadcast({
        type: "message_edited",
        message_id: param(req, "message_id"),
        content,
        role: msgRole,
      });

      res.json({ status: "success" });
    } catch (e: any) {
      if (e.message === "System messages cannot be edited") {
        res.status(403).json({ detail: e.message });
      } else {
        res.status(500).json({ detail: e.message });
      }
    }
  });

  router.get("/messages/:message_id/raw", (req: Request, res: Response) => {
    try {
      const content = db.getMessageContent(param(req, "message_id"));

      if (content === undefined) {
        res.status(404).json({ detail: "Message not found" });
        return;
      }
      res.json({ content });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.delete("/conversations/:conversation_id", (req: Request, res: Response) => {
    try {
      db.deleteConversation(param(req, "conversation_id"));
      manager.broadcast({ type: "conversation_deleted", conversation_id: param(req, "conversation_id") });
      res.json({ status: "success" });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.put("/conversations/:conversation_id/title", (req: Request, res: Response) => {
    try {
      const { title } = req.body;
      db.updateConversationSummary(param(req, "conversation_id"), title);
      manager.broadcast({
        type: "summary_updated",
        conversation_id: param(req, "conversation_id"),
        summary: title,
      });
      res.json({ status: "success" });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  // --- System Prompt ---
  router.get("/get_system_prompt", (req: Request, res: Response) => {
    try {
      const conversationId = req.query.conversation_id as string | undefined;

      if (conversationId) {
        const history = db.getConversationHistory(conversationId);
        const systemMessages = history.filter((m) => m.role === "system");
        if (systemMessages.length > 0) {
          res.json({ system_prompt: systemMessages[systemMessages.length - 1].content });
          return;
        }

        const project = db.getProjectForConversation(conversationId);
        if (project?.system_prompt) {
          res.json({ system_prompt: project.system_prompt });
          return;
        }
      }

      const activePrompt = db.getActivePrompt();
      res.json({ system_prompt: activePrompt?.prompt_text || "You are a helpful assistant." });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  // --- Chat ---
  router.post(
    "/chat",
    upload.array("files", 20),
    async (req: Request, res: Response) => {
      try {
        const { message, system_prompt, conversation_id, client_id } = req.body;
        const files = req.files as Express.Multer.File[] | undefined;

        // Verify conversation exists
        let history = db.getConversationHistory(conversation_id);
        if (history.length > 0) {
          const systemMessages = history.filter((m) => m.role === "system");
          const lastSystem = systemMessages.length > 0
            ? systemMessages[systemMessages.length - 1].content
            : "";
          if (lastSystem !== system_prompt) {
            db.addMessage(conversation_id, "system", system_prompt);
          }
        }

        // Handle file uploads
        let userMessage = message;
        const fileInfoList: Array<{
          name: string;
          path: string;
          type: string;
          size: number;
        }> = [];

        if (files && files.length > 0) {
          for (const file of files) {
            const safeFilename = generateSafeFilename(file.originalname);
            const destPath = path.join(TEMP_DIR, safeFilename);
            fs.copyFileSync(file.path, destPath);

            fileInfoList.push({
              name: file.originalname,
              path: destPath,
              type: file.mimetype,
              size: file.size,
            });

            // Try to read text content
            try {
              const textContent = fs.readFileSync(destPath, "utf-8");
              userMessage += `\n\n--- File: ${file.originalname} ---\n${textContent}`;
            } catch {
              // Not a text file
            }
          }
        }

        if (history.length === 0) {
          db.addMessage(conversation_id, "system", system_prompt);
        }

        db.addMessage(
          conversation_id,
          "user",
          userMessage,
          "text",
          fileInfoList.length > 0 ? fileInfoList : undefined
        );

        // Re-fetch history
        history = db.getConversationHistory(conversation_id);

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        let fullResponse = "";

        try {
          for await (const chunk of textStreamer(history, client_id, db, manager)) {
            fullResponse += chunk;
            res.write(chunk);
          }
        } catch (err: any) {
          if (!res.writableEnded) {
            res.write(`__ERROR__:${err.message}`);
          }
        }

        res.end();

        // Store complete response
        const messageId = db.addMessage(
          conversation_id,
          "assistant",
          fullResponse
        );

        manager.broadcast({
          type: "message_added",
          conversation_id,
          message_id: messageId,
        });

        // Generate summary for first user message
        if (history.length === 2 && history[1].role === "user") {
          try {
            const provider = db.getDefaultProvider();
            let summary: string;

            if (provider?.use_for_summarization) {
              const allUserMessages = history
                .filter((m) => m.role === "user")
                .map((m) => m.content);
              const summaryMessages = [
                { ...({ message_id: "", conversation_id: "", content_type: "text", created_at: 0 } as any), role: "system", content: SUMMARY_PROMPT },
                { ...({ message_id: "", conversation_id: "", content_type: "text", created_at: 0 } as any), role: "user", content: JSON.stringify(allUserMessages) },
              ];
              let summaryText = "";
              for await (const chunk of textStreamer(summaryMessages, client_id, db, manager)) {
                summaryText += chunk;
              }
              summary = summaryText.trim();
            } else {
              const userMsg = history[1].content;
              const firstLine = userMsg.split("\n")[0];
              summary = firstLine.substring(0, 50);
              if (firstLine.length > 50) summary += "...";
            }

            db.updateConversationSummary(conversation_id, summary);
            manager.broadcast({
              type: "summary_updated",
              conversation_id,
              summary,
            });
          } catch (err: any) {
            console.error("Failed to generate summary:", err.message);
          }
        }
      } catch (e: any) {
        console.error("Error in chat endpoint:", e.message);
        if (!res.headersSent) {
          res.status(500).json({ detail: e.message });
        }
      }
    }
  );

  // --- Regenerate ---
  router.post(
    "/regenerate_response",
    upload.none(),
    async (req: Request, res: Response) => {
      try {
        const { message, system_prompt, conversation_id, message_id, client_id } = req.body;

        let history = db.getConversationHistoryUptoMessageId(
          conversation_id,
          message_id
        );

        if (!history.length) {
          res.status(404).json({ detail: "No conversation history found" });
          return;
        }

        const systemMessages = history.filter((m) => m.role === "system");
        const lastSystem = systemMessages.length > 0
          ? systemMessages[systemMessages.length - 1].content
          : "";
        if (lastSystem !== system_prompt) {
          db.addMessage(conversation_id, "system", system_prompt);
          history = db.getConversationHistoryUptoMessageId(conversation_id, message_id);
        }

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        let fullResponse = "";

        for await (const chunk of textStreamer(history, client_id, db, manager)) {
          fullResponse += chunk;
          res.write(chunk);
        }

        res.end();

        // Update the existing message
        db.editMessage(message_id, fullResponse);

        manager.broadcast({
          type: "message_added",
          conversation_id,
        });
      } catch (e: any) {
        console.error("Error in regenerate endpoint:", e.message);
        if (!res.headersSent) {
          res.status(500).json({ detail: e.message });
        }
      }
    }
  );

  // --- Providers ---
  router.get("/providers", (_req: Request, res: Response) => {
    try {
      res.json({ providers: db.getAllProviders() });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.get("/default_provider", (_req: Request, res: Response) => {
    try {
      const provider = db.getDefaultProvider();
      if (!provider) {
        res.status(404).json({ detail: "No default provider found" });
        return;
      }
      res.json(provider);
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.get("/providers/:provider_id", (req: Request, res: Response) => {
    try {
      const provider = db.getProviderById(Number(param(req, "provider_id")));
      if (!provider) {
        res.status(404).json({ detail: "Provider not found" });
        return;
      }
      res.json(provider);
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.post("/providers", (req: Request, res: Response) => {
    try {
      const providerId = db.addProvider(req.body);
      res.json({ status: "success", id: providerId });
    } catch (e: any) {
      if (e.message?.includes("UNIQUE")) {
        res.status(409).json({ detail: "A provider with this name already exists" });
      } else {
        res.status(500).json({ detail: e.message });
      }
    }
  });

  router.put("/providers/:provider_id", (req: Request, res: Response) => {
    try {
      const success = db.updateProvider(Number(param(req, "provider_id")), req.body);
      if (!success) {
        res.status(404).json({ detail: "Provider not found" });
        return;
      }
      res.json({ status: "success" });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.delete("/providers/:provider_id", (req: Request, res: Response) => {
    try {
      const success = db.deleteProvider(Number(param(req, "provider_id")));
      if (!success) {
        res.status(404).json({ detail: "Provider not found" });
        return;
      }
      res.json({ status: "success" });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.post("/providers/:provider_id/set_default", (req: Request, res: Response) => {
    try {
      const success = db.setDefaultProvider(Number(param(req, "provider_id")));
      if (!success) {
        res.status(404).json({ detail: "Provider not found" });
        return;
      }
      res.json({ status: "success" });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  // --- Models ---
  router.get("/providers/:provider_id/models", (req: Request, res: Response) => {
    try {
      res.json({ models: db.getModelsByProvider(Number(param(req, "provider_id"))) });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.post("/providers/:provider_id/models", (req: Request, res: Response) => {
    try {
      const modelId = db.addModel(
        Number(param(req, "provider_id")),
        req.body.model_name,
        req.body.is_multimodal
      );
      res.json({ status: "success", id: modelId });
    } catch (e: any) {
      if (e.message?.includes("UNIQUE")) {
        res.status(409).json({ detail: "This model already exists for this provider" });
      } else {
        res.status(400).json({ detail: e.message });
      }
    }
  });

  router.delete("/models/:model_id", (req: Request, res: Response) => {
    try {
      const success = db.deleteModel(Number(param(req, "model_id")));
      if (!success) {
        res.status(404).json({ detail: "Model not found" });
        return;
      }
      res.json({ status: "success" });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.post("/models/:model_id/set_default", (req: Request, res: Response) => {
    try {
      const success = db.setDefaultModel(Number(param(req, "model_id")));
      if (!success) {
        res.status(404).json({ detail: "Model not found" });
        return;
      }
      res.json({ status: "success" });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  // --- Projects ---
  router.get("/projects", (_req: Request, res: Response) => {
    try {
      res.json({ projects: db.getProjects() });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.get("/projects/:project_id", (req: Request, res: Response) => {
    try {
      const project = db.getProject(param(req, "project_id"));
      if (!project) {
        res.status(404).json({ detail: "Project not found" });
        return;
      }
      res.json(project);
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.post("/projects", (req: Request, res: Response) => {
    try {
      const { name, description, system_prompt } = req.body;
      const projectId = db.createProject(name, description || "", system_prompt || "");
      res.json({ status: "success", id: projectId });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.put("/projects/:project_id", (req: Request, res: Response) => {
    try {
      const { name, description, system_prompt } = req.body;
      const success = db.updateProject(
        param(req, "project_id"),
        name,
        description || "",
        system_prompt || ""
      );
      if (!success) {
        res.status(404).json({ detail: "Project not found" });
        return;
      }
      res.json({ status: "success" });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.delete("/projects/:project_id", (req: Request, res: Response) => {
    try {
      const success = db.deleteProject(param(req, "project_id"));
      if (!success) {
        res.status(404).json({ detail: "Project not found" });
        return;
      }
      res.json({ status: "success" });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  // --- Prompts ---
  router.get("/prompts", (_req: Request, res: Response) => {
    try {
      const prompts = db.getAllPrompts();
      const formatted = prompts.map((p) => ({
        id: p.id,
        name: p.prompt_name,
        content: p.prompt_text,
        is_active: !!p.is_active,
      }));
      res.json({ prompts: formatted });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.get("/prompts/active", (_req: Request, res: Response) => {
    try {
      let prompt = db.getActivePrompt();
      if (!prompt) {
        const defaultPrompt = db.getPromptByName("default");
        if (defaultPrompt) {
          db.setActivePrompt(defaultPrompt.id);
          prompt = defaultPrompt;
        }
      }
      if (!prompt) {
        res.status(404).json({ detail: "No active or default prompt found" });
        return;
      }
      res.json({ id: prompt.id, name: prompt.prompt_name, content: prompt.prompt_text });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.get("/prompts/:prompt_id", (req: Request, res: Response) => {
    try {
      const prompt = db.getPromptById(Number(param(req, "prompt_id")));
      if (!prompt) {
        res.status(404).json({ detail: "Prompt not found" });
        return;
      }
      res.json({
        id: prompt.id,
        name: prompt.prompt_name,
        content: prompt.prompt_text,
      });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.post("/prompts", (req: Request, res: Response) => {
    try {
      const { name, text } = req.body;
      const promptId = db.addSystemPrompt(name, text);
      res.json({ id: promptId });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.put("/prompts/:prompt_id", (req: Request, res: Response) => {
    try {
      const { name, text } = req.body;
      const success = db.editSystemPrompt(Number(param(req, "prompt_id")), name, text);
      if (!success) {
        res.status(404).json({ detail: "Prompt not found" });
        return;
      }
      res.json({ status: "success" });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.delete("/prompts/:prompt_id", (req: Request, res: Response) => {
    try {
      const prompt = db.getPromptById(Number(param(req, "prompt_id")));
      if (!prompt) {
        res.status(404).json({ detail: "Prompt not found" });
        return;
      }
      if (prompt.prompt_name === "default") {
        res.status(403).json({ detail: "Cannot delete the default prompt" });
        return;
      }
      const success = db.deleteSystemPrompt(Number(param(req, "prompt_id")));
      if (!success) {
        res.status(500).json({ detail: "Failed to delete prompt" });
        return;
      }
      res.json({ status: "success" });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.post("/prompts/:prompt_id/activate", (req: Request, res: Response) => {
    try {
      const success = db.setActivePrompt(Number(param(req, "prompt_id")));
      if (!success) {
        res.status(404).json({ detail: "Prompt not found" });
        return;
      }
      res.json({ status: "success" });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  // --- Attachments ---
  router.get("/attachments/:attachment_id", (req: Request, res: Response) => {
    try {
      const attachment = db.getAttachment(param(req, "attachment_id"));
      if (!attachment) {
        res.status(404).json({ detail: "Attachment not found" });
        return;
      }
      const filePath = attachment.file_path;
      if (!fs.existsSync(filePath)) {
        res.status(404).json({ detail: "File not found" });
        return;
      }
      res.sendFile(filePath, { headers: { "Content-Type": attachment.file_type } });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  return router;
}
