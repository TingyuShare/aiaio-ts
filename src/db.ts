import initSqlJs from "sql.js";
type SqlJsDatabase = import("sql.js").Database;
import { v4 as uuidv4 } from "uuid";
import { SYSTEM_PROMPTS } from "./prompts";
import fs from "fs";

const DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
    conversation_id TEXT PRIMARY KEY,
    created_at REAL DEFAULT (strftime('%s.%f', 'now')),
    updated_at REAL DEFAULT (strftime('%s.%f', 'now')),
    last_updated REAL DEFAULT (strftime('%s.%f', 'now')),
    summary TEXT,
    project_id TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT,
    role TEXT CHECK(role IN ('user', 'assistant', 'system')),
    content_type TEXT CHECK(content_type IN ('text', 'image', 'audio', 'video', 'file')),
    content TEXT,
    created_at REAL DEFAULT (strftime('%s.%f', 'now')),
    updated_at REAL DEFAULT (strftime('%s.%f', 'now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
);

CREATE TABLE IF NOT EXISTS attachments (
    attachment_id TEXT PRIMARY KEY,
    message_id TEXT,
    file_name TEXT,
    file_path TEXT,
    file_type TEXT,
    file_size INTEGER,
    created_at REAL DEFAULT (strftime('%s.%f', 'now')),
    updated_at REAL DEFAULT (strftime('%s.%f', 'now')),
    FOREIGN KEY (message_id) REFERENCES messages(message_id)
);

CREATE TABLE IF NOT EXISTS providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    is_default BOOLEAN NOT NULL DEFAULT 0,
    temperature REAL DEFAULT 1.0,
    top_p REAL DEFAULT 0.95,
    reasoning_effort TEXT DEFAULT 'none',
    use_for_summarization BOOLEAN DEFAULT 0,
    host TEXT NOT NULL,
    api_key TEXT DEFAULT '',
    api_key_header TEXT DEFAULT 'Authorization',
    created_at REAL DEFAULT (strftime('%s.%f', 'now')),
    updated_at REAL DEFAULT (strftime('%s.%f', 'now'))
);

CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id INTEGER NOT NULL,
    model_name TEXT NOT NULL,
    is_default BOOLEAN DEFAULT 0,
    is_multimodal BOOLEAN DEFAULT 0,
    created_at REAL DEFAULT (strftime('%s.%f', 'now')),
    updated_at REAL DEFAULT (strftime('%s.%f', 'now')),
    FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
    UNIQUE(provider_id, model_name)
);

CREATE TABLE IF NOT EXISTS system_prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_name TEXT NOT NULL UNIQUE,
    prompt_text TEXT NOT NULL,
    is_active BOOLEAN DEFAULT 0,
    created_at REAL DEFAULT (strftime('%s.%f', 'now')),
    updated_at REAL DEFAULT (strftime('%s.%f', 'now'))
);

CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    system_prompt TEXT,
    created_at REAL DEFAULT (strftime('%s.%f', 'now')),
    updated_at REAL DEFAULT (strftime('%s.%f', 'now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

export interface Provider {
  id: number;
  name: string;
  is_default: boolean;
  temperature: number;
  top_p: number;
  reasoning_effort: string;
  use_for_summarization: boolean;
  host: string;
  api_key: string;
  api_key_header: string;
  created_at: number;
  updated_at: number;
}

export interface Model {
  id: number;
  provider_id: number;
  model_name: string;
  is_default: boolean;
  is_multimodal: boolean;
  created_at: number;
  updated_at: number;
}

export interface Conversation {
  conversation_id: string;
  created_at: number;
  updated_at: number;
  last_updated: number;
  summary: string | null;
  project_id: string | null;
  message_count?: number;
  last_message_at?: number;
}

export interface Message {
  message_id: string;
  conversation_id: string;
  role: string;
  content_type: string;
  content: string;
  created_at: number;
  updated_at: number;
  attachments?: Attachment[];
}

export interface Attachment {
  attachment_id: string;
  message_id: string;
  file_name: string;
  file_path: string;
  file_type: string;
  file_size: number;
  created_at: number;
  updated_at: number;
}

export interface SystemPrompt {
  id: number;
  prompt_name: string;
  prompt_text: string;
  is_active: boolean;
  created_at: number;
  updated_at: number;
}

export interface Project {
  project_id: string;
  name: string;
  description: string;
  system_prompt: string;
  created_at: number;
  updated_at: number;
}

export class ChatDatabase {
  private db!: SqlJsDatabase;
  private dbPath: string = "";
  private saveInterval: ReturnType<typeof setInterval> | null = null;

  static async create(dbPath: string = "chatbot.db"): Promise<ChatDatabase> {
    const instance = new ChatDatabase();
    instance.dbPath = dbPath;

    const SQL = await initSqlJs();

    if (fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      instance.db = new SQL.Database(fileBuffer);
    } else {
      instance.db = new SQL.Database();
    }

    instance.db.run("PRAGMA foreign_keys = ON");
    instance.initDb();

    // Auto-save every 5 seconds
    instance.saveInterval = setInterval(() => instance.save(), 5000);

    return instance;
  }

  private initDb(): void {
    this.db.run(DB_SCHEMA);

    // Migration: add api_key_header column if it doesn't exist
    try {
      const columns = this.db.exec("PRAGMA table_info(providers)");
      const colNames = (columns[0]?.values || []).map((row: any) => row[1] as string);
      if (!colNames.includes("api_key_header")) {
        this.db.run("ALTER TABLE providers ADD COLUMN api_key_header TEXT DEFAULT 'Authorization'");
      }
    } catch {
      // Column might already exist
    }

    const result = this.db.exec("SELECT COUNT(*) as count FROM providers");
    const count = result.length > 0 ? (result[0].values[0][0] as number) : 0;

    if (count === 0) {
      this.seedDefaults();
    }

    const projectResult = this.db.exec("SELECT COUNT(*) as count FROM projects");
    const projectCount = projectResult.length > 0 ? (projectResult[0].values[0][0] as number) : 0;

    if (projectCount === 0) {
      const defaultProjectId = uuidv4();
      this.db.run(
        "INSERT INTO projects (project_id, name, description, system_prompt) VALUES (?, ?, ?, ?)",
        [defaultProjectId, "General", "Default project for general conversations", SYSTEM_PROMPTS.default.trim()]
      );
    }

    // Set default access code if none exists
    const existingCode = this.getAccessCode();
    if (!existingCode) {
      this.setAccessCode("aiaio-ts");
    }

    this.save();
  }

  private seedDefaults(): void {
    this.db.run(
      `INSERT INTO providers (name, is_default, temperature, top_p, reasoning_effort, use_for_summarization, host, api_key, api_key_header)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["OpenAI", 1, 1.0, 0.95, "low", 1, "https://api.openai.com/v1", "", "Authorization"]
    );
    const r = this.db.exec("SELECT last_insert_rowid()");
    const openaiId = r[0].values[0][0];
    this.db.run("INSERT INTO models (provider_id, model_name, is_default, is_multimodal) VALUES (?, ?, ?, ?)", [openaiId, "gpt-5.4", 1, 1]);
    this.db.run("INSERT INTO models (provider_id, model_name, is_default, is_multimodal) VALUES (?, ?, ?, ?)", [openaiId, "gpt-5.4-mini", 0, 1]);
    this.db.run("INSERT INTO models (provider_id, model_name, is_default, is_multimodal) VALUES (?, ?, ?, ?)", [openaiId, "gpt-5.4-nano", 0, 1]);

    this.db.run("INSERT INTO system_prompts (prompt_name, prompt_text, is_active) VALUES (?, ?, ?)", ["summary", SYSTEM_PROMPTS.summary.trim(), 0]);
    this.db.run("INSERT INTO system_prompts (prompt_name, prompt_text, is_active) VALUES (?, ?, ?)", ["default", SYSTEM_PROMPTS.default.trim(), 1]);
  }

  save(): void {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  private queryAll(sql: string, params: any[] = []): Record<string, any>[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const results: Record<string, any>[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }

  private queryOne(sql: string, params: any[] = []): Record<string, any> | undefined {
    const results = this.queryAll(sql, params);
    return results.length > 0 ? results[0] : undefined;
  }

  // --- Conversations ---
  createConversation(projectId?: string): string {
    const conversationId = uuidv4();
    if (projectId) {
      this.db.run("INSERT INTO conversations (conversation_id, project_id) VALUES (?, ?)", [conversationId, projectId]);
    } else {
      const proj = this.queryOne("SELECT project_id FROM projects ORDER BY created_at ASC LIMIT 1");
      if (proj) {
        this.db.run("INSERT INTO conversations (conversation_id, project_id) VALUES (?, ?)", [conversationId, proj.project_id]);
      } else {
        this.db.run("INSERT INTO conversations (conversation_id) VALUES (?)", [conversationId]);
      }
    }
    this.save();
    return conversationId;
  }

  addMessage(
    conversationId: string,
    role: string,
    content: string,
    contentType: string = "text",
    attachments?: Array<{ name: string; path: string; type: string; size: number }>
  ): string {
    const messageId = uuidv4();
    const currentTime = Date.now() / 1000;

    this.db.run(
      `INSERT INTO messages (message_id, conversation_id, role, content_type, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [messageId, conversationId, role, contentType, content, currentTime]
    );

    this.db.run("UPDATE conversations SET last_updated = ? WHERE conversation_id = ?", [currentTime, conversationId]);

    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        this.db.run(
          `INSERT INTO attachments (attachment_id, message_id, file_name, file_path, file_type, file_size, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), messageId, att.name, att.path, att.type, att.size, currentTime]
        );
      }
    }

    this.save();
    return messageId;
  }

  getConversationHistory(conversationId: string): Message[] {
    const rows = this.queryAll(
      `SELECT m.*, a.attachment_id, a.file_name, a.file_path, a.file_type, a.file_size
       FROM messages m LEFT JOIN attachments a ON m.message_id = a.message_id
       WHERE m.conversation_id = ? ORDER BY m.created_at ASC`,
      [conversationId]
    );

    const messageMap = new Map<string, Message>();
    for (const row of rows) {
      const mid = row.message_id as string;
      if (!messageMap.has(mid)) {
        messageMap.set(mid, {
          message_id: mid,
          conversation_id: row.conversation_id as string,
          role: row.role as string,
          content_type: row.content_type as string,
          content: row.content as string,
          created_at: row.created_at as number,
          updated_at: row.updated_at as number,
          attachments: [],
        });
      }
      if (row.attachment_id) {
        messageMap.get(mid)!.attachments!.push({
          attachment_id: row.attachment_id as string,
          message_id: mid,
          file_name: row.file_name as string,
          file_path: row.file_path as string,
          file_type: row.file_type as string,
          file_size: row.file_size as number,
          created_at: row.created_at as number,
          updated_at: row.updated_at as number,
        });
      }
    }
    return Array.from(messageMap.values());
  }

  getConversationHistoryUptoMessageId(conversationId: string, messageId: string): Message[] {
    const rows = this.queryAll(
      `SELECT m.*, a.attachment_id, a.file_name, a.file_path, a.file_type, a.file_size
       FROM messages m LEFT JOIN attachments a ON m.message_id = a.message_id
       WHERE m.conversation_id = ? AND m.created_at < (
           SELECT created_at FROM messages WHERE message_id = ?
       ) ORDER BY m.created_at ASC`,
      [conversationId, messageId]
    );

    const messageMap = new Map<string, Message>();
    for (const row of rows) {
      const mid = row.message_id as string;
      if (!messageMap.has(mid)) {
        messageMap.set(mid, {
          message_id: mid,
          conversation_id: row.conversation_id as string,
          role: row.role as string,
          content_type: row.content_type as string,
          content: row.content as string,
          created_at: row.created_at as number,
          updated_at: row.updated_at as number,
          attachments: [],
        });
      }
      if (row.attachment_id) {
        messageMap.get(mid)!.attachments!.push({
          attachment_id: row.attachment_id as string,
          message_id: mid,
          file_name: row.file_name as string,
          file_path: row.file_path as string,
          file_type: row.file_type as string,
          file_size: row.file_size as number,
          created_at: row.created_at as number,
          updated_at: row.updated_at as number,
        });
      }
    }
    return Array.from(messageMap.values());
  }

  deleteConversation(conversationId: string): void {
    this.db.run("DELETE FROM attachments WHERE message_id IN (SELECT message_id FROM messages WHERE conversation_id = ?)", [conversationId]);
    this.db.run("DELETE FROM messages WHERE conversation_id = ?", [conversationId]);
    this.db.run("DELETE FROM conversations WHERE conversation_id = ?", [conversationId]);
    this.save();
  }

  getAllConversations(projectId?: string): Conversation[] {
    let sql = `SELECT c.*, COUNT(m.message_id) as message_count, MAX(m.created_at) as last_message_at
       FROM conversations c LEFT JOIN messages m ON c.conversation_id = m.conversation_id`;
    const params: any[] = [];
    if (projectId) {
      sql += " WHERE c.project_id = ?";
      params.push(projectId);
    }
    sql += " GROUP BY c.conversation_id ORDER BY c.created_at ASC";
    return this.queryAll(sql, params) as unknown as Conversation[];
  }

  updateConversationSummary(conversationId: string, summary: string): void {
    this.db.run("UPDATE conversations SET summary = ?, updated_at = strftime('%s.%f', 'now') WHERE conversation_id = ?", [summary, conversationId]);
    this.save();
  }

  editMessage(messageId: string, newContent: string): boolean {
    const msg = this.queryOne("SELECT role FROM messages WHERE message_id = ?", [messageId]);
    if (!msg) return false;
    if (msg.role === "system") throw new Error("System messages cannot be edited");
    this.db.run("UPDATE messages SET content = ?, updated_at = strftime('%s.%f', 'now') WHERE message_id = ?", [newContent, messageId]);
    this.save();
    return true;
  }

  getMessageRole(messageId: string): string | undefined {
    const msg = this.queryOne("SELECT role FROM messages WHERE message_id = ?", [messageId]);
    return msg?.role as string | undefined;
  }

  getMessageContent(messageId: string): string | undefined {
    const msg = this.queryOne("SELECT content FROM messages WHERE message_id = ?", [messageId]);
    return msg?.content as string | undefined;
  }

  // --- Attachments ---
  getAttachment(attachmentId: string): Attachment | undefined {
    return this.queryOne("SELECT * FROM attachments WHERE attachment_id = ?", [attachmentId]) as unknown as Attachment | undefined;
  }

  // --- Providers ---
  getDefaultProvider(): Provider | undefined {
    return this.queryOne("SELECT * FROM providers WHERE is_default = 1") as unknown as Provider | undefined;
  }

  getAllProviders(): Provider[] {
    return this.queryAll("SELECT * FROM providers ORDER BY name") as unknown as Provider[];
  }

  getProviderById(providerId: number): Provider | undefined {
    return this.queryOne("SELECT * FROM providers WHERE id = ?", [providerId]) as unknown as Provider | undefined;
  }

  addProvider(provider: { name: string; temperature?: number; top_p?: number; reasoning_effort?: string; use_for_summarization?: boolean; host: string; api_key?: string; api_key_header?: string }): number {
    this.db.run(
      `INSERT INTO providers (name, temperature, top_p, reasoning_effort, use_for_summarization, host, api_key, api_key_header) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [provider.name, provider.temperature ?? 1.0, provider.top_p ?? 0.95, provider.reasoning_effort ?? "none", provider.use_for_summarization ? 1 : 0, provider.host, provider.api_key ?? "", provider.api_key_header ?? "Authorization"]
    );
    const r = this.db.exec("SELECT last_insert_rowid()");
    this.save();
    return Number(r[0].values[0][0]);
  }

  updateProvider(providerId: number, provider: { name: string; temperature?: number; top_p?: number; reasoning_effort?: string; use_for_summarization?: boolean; host: string; api_key?: string; api_key_header?: string }): boolean {
    this.db.run(
      `UPDATE providers SET name=?, temperature=?, top_p=?, reasoning_effort=?, use_for_summarization=?, host=?, api_key=?, api_key_header=?, updated_at=strftime('%s.%f','now') WHERE id=?`,
      [provider.name, provider.temperature ?? 1.0, provider.top_p ?? 0.95, provider.reasoning_effort ?? "none", provider.use_for_summarization ? 1 : 0, provider.host, provider.api_key ?? "", provider.api_key_header ?? "Authorization", providerId]
    );
    this.save();
    return true;
  }

  deleteProvider(providerId: number): boolean {
    // Check if this provider is the default
    const provider = this.queryOne("SELECT is_default FROM providers WHERE id = ?", [providerId]);
    const wasDefault = provider?.is_default;

    // Delete provider (cascade deletes models)
    this.db.run("DELETE FROM providers WHERE id = ?", [providerId]);

    // If it was the default, set another provider as default
    if (wasDefault) {
      const remaining = this.queryOne("SELECT id FROM providers ORDER BY id ASC LIMIT 1");
      if (remaining) {
        this.db.run("UPDATE providers SET is_default = 1 WHERE id = ?", [remaining.id]);
      }
    }

    this.save();
    return true;
  }

  setDefaultProvider(providerId: number): boolean {
    this.db.run("UPDATE providers SET is_default = 0 WHERE is_default = 1");
    this.db.run("UPDATE providers SET is_default = 1 WHERE id = ?", [providerId]);
    this.save();
    return true;
  }

  // --- Models ---
  getModelsByProvider(providerId: number): Model[] {
    return this.queryAll("SELECT * FROM models WHERE provider_id = ? ORDER BY is_default DESC, model_name", [providerId]) as unknown as Model[];
  }

  getDefaultModel(providerId: number): Model | undefined {
    return this.queryOne("SELECT * FROM models WHERE provider_id = ? AND is_default = 1", [providerId]) as unknown as Model | undefined;
  }

  addModel(providerId: number, modelName: string, isMultimodal: boolean = false): number {
    const existing = this.queryOne("SELECT COUNT(*) as count FROM models WHERE provider_id = ?", [providerId]);
    let isDefault = false;
    if ((existing?.count as number) || 0 === 0) isDefault = true;
    if (isDefault) {
      this.db.run("UPDATE models SET is_default = 0 WHERE provider_id = ? AND is_default = 1", [providerId]);
    }
    this.db.run("INSERT INTO models (provider_id, model_name, is_default, is_multimodal) VALUES (?, ?, ?, ?)", [providerId, modelName, isDefault ? 1 : 0, isMultimodal ? 1 : 0]);
    const r = this.db.exec("SELECT last_insert_rowid()");
    this.save();
    return Number(r[0].values[0][0]);
  }

  deleteModel(modelId: number): boolean {
    this.db.run("DELETE FROM models WHERE id = ?", [modelId]);
    this.save();
    return true;
  }

  setDefaultModel(modelId: number): boolean {
    const model = this.queryOne("SELECT provider_id FROM models WHERE id = ?", [modelId]);
    if (!model) return false;
    this.db.run("UPDATE models SET is_default = 0 WHERE provider_id = ? AND is_default = 1", [model.provider_id]);
    this.db.run("UPDATE models SET is_default = 1 WHERE id = ?", [modelId]);
    this.save();
    return true;
  }

  // --- Projects ---
  getProjects(): Project[] {
    return this.queryAll("SELECT * FROM projects ORDER BY created_at ASC") as unknown as Project[];
  }

  getProject(projectId: string): Project | undefined {
    return this.queryOne("SELECT * FROM projects WHERE project_id = ?", [projectId]) as unknown as Project | undefined;
  }

  getProjectForConversation(conversationId: string): Project | undefined {
    return this.queryOne(
      `SELECT p.* FROM projects p JOIN conversations c ON p.project_id = c.project_id WHERE c.conversation_id = ?`,
      [conversationId]
    ) as unknown as Project | undefined;
  }

  createProject(name: string, description: string = "", systemPrompt: string = ""): string {
    const projectId = uuidv4();
    this.db.run("INSERT INTO projects (project_id, name, description, system_prompt) VALUES (?, ?, ?, ?)", [projectId, name, description, systemPrompt]);
    this.save();
    return projectId;
  }

  updateProject(projectId: string, name: string, description: string, systemPrompt: string): boolean {
    this.db.run("UPDATE projects SET name=?, description=?, system_prompt=?, updated_at=strftime('%s.%f','now') WHERE project_id=?", [name, description, systemPrompt, projectId]);
    this.save();
    return true;
  }

  deleteProject(projectId: string): boolean {
    this.db.run("DELETE FROM messages WHERE conversation_id IN (SELECT conversation_id FROM conversations WHERE project_id = ?)", [projectId]);
    this.db.run("DELETE FROM conversations WHERE project_id = ?", [projectId]);
    this.db.run("DELETE FROM projects WHERE project_id = ?", [projectId]);
    this.save();
    return true;
  }

  // --- System Prompts ---
  getAllPrompts(): SystemPrompt[] {
    return this.queryAll("SELECT * FROM system_prompts") as unknown as SystemPrompt[];
  }

  getPromptById(promptId: number): SystemPrompt | undefined {
    return this.queryOne("SELECT * FROM system_prompts WHERE id = ?", [promptId]) as unknown as SystemPrompt | undefined;
  }

  getPromptByName(promptName: string): SystemPrompt | undefined {
    return this.queryOne("SELECT * FROM system_prompts WHERE prompt_name = ?", [promptName]) as unknown as SystemPrompt | undefined;
  }

  getActivePrompt(): SystemPrompt | undefined {
    return this.queryOne("SELECT * FROM system_prompts WHERE is_active = 1") as unknown as SystemPrompt | undefined;
  }

  addSystemPrompt(name: string, text: string): number {
    this.db.run("INSERT INTO system_prompts (prompt_name, prompt_text) VALUES (?, ?)", [name, text]);
    const r = this.db.exec("SELECT last_insert_rowid()");
    this.save();
    return Number(r[0].values[0][0]);
  }

  editSystemPrompt(promptId: number, name: string, text: string): boolean {
    this.db.run("UPDATE system_prompts SET prompt_name=?, prompt_text=?, updated_at=strftime('%s.%f','now') WHERE id=?", [name, text, promptId]);
    this.save();
    return true;
  }

  setActivePrompt(promptId: number): boolean {
    this.db.run("UPDATE system_prompts SET is_active = 0");
    this.db.run("UPDATE system_prompts SET is_active = 1 WHERE id = ?", [promptId]);
    this.save();
    return true;
  }

  deleteSystemPrompt(promptId: number): boolean {
    this.db.run("DELETE FROM system_prompts WHERE id = ? AND prompt_name != 'default'", [promptId]);
    this.save();
    return true;
  }

  // --- Access Code ---
  getAccessCode(): string | null {
    const row = this.queryOne("SELECT value FROM settings WHERE key = 'access_code'");
    return row ? (row.value as string) : null;
  }

  setAccessCode(code: string): void {
    this.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('access_code', ?)", [code]);
    this.save();
  }

  close(): void {
    if (this.saveInterval) clearInterval(this.saveInterval);
    this.save();
    this.db.close();
  }
}
