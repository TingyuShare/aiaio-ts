import OpenAI from "openai";
import { ConnectionManager } from "./websocket";
import { ChatDatabase } from "./db";

export interface HistoryMessage {
  message_id: string;
  conversation_id: string;
  role: string;
  content_type: string;
  content: string;
  created_at: number;
  attachments?: HistoryAttachment[];
}

export interface HistoryAttachment {
  attachment_id: string;
  file_name: string;
  file_path: string;
  file_type: string;
  file_size: number;
}

export async function* textStreamer(
  messages: HistoryMessage[],
  clientId: string,
  db: ChatDatabase,
  connManager: ConnectionManager
): AsyncGenerator<string> {
  const provider = db.getDefaultProvider();
  if (!provider) {
    throw new Error("No default provider found");
  }

  const defaultModel = db.getDefaultModel(provider.id);
  if (!defaultModel) {
    throw new Error("No default model found for provider");
  }

  // Support custom API key headers (e.g. 'api-key' for MiMo, 'Authorization' for OpenAI-compatible)
  const headerName = provider.api_key_header || "Authorization";
  const useCustomHeader = headerName !== "Authorization";

  const client = new OpenAI({
    apiKey: useCustomHeader ? "placeholder" : (provider.api_key || "empty"),
    baseURL: provider.host,
    ...(useCustomHeader && provider.api_key
      ? { defaultHeaders: { [headerName]: provider.api_key } }
      : {}),
  });

  const formattedMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
    [];

  for (const msg of messages) {
    const attachments = msg.attachments || [];

    if (attachments.length > 0) {
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }

      const fs = require("fs") as typeof import("fs");

      for (const att of attachments) {
        const fileType = (att.file_type || "").split("/")[0];
        const mimeType = att.file_type || "application/octet-stream";

        const fileData = fs.readFileSync(att.file_path);
        const base64Data = fileData.toString("base64");

        if (fileType === "image") {
          content.push({
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${base64Data}` },
          });
        } else if (fileType === "video") {
          content.push({
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${base64Data}` },
          });
        } else if (fileType === "audio") {
          content.push({
            type: "text",
            text: `[Audio file: ${att.file_name}]`,
          });
        } else {
          content.push({
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${base64Data}` },
          });
        }
      }

      formattedMessages.push({
        role: msg.role === "system" ? "system" : msg.role === "assistant" ? "assistant" : "user",
        content: content,
      } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
    } else {
      formattedMessages.push({
        role: msg.role as "user" | "assistant" | "system",
        content: msg.content,
      });
    }
  }

  let stream: Awaited<ReturnType<typeof client.chat.completions.create>> | null = null;

  try {
    connManager.setGenerating(clientId, true);

    const apiParams: Record<string, unknown> = {
      messages: formattedMessages,
      model: defaultModel.model_name,
      temperature: provider.temperature,
      top_p: provider.top_p,
      stream: true,
    };

    if (provider.reasoning_effort && provider.reasoning_effort !== "none") {
      apiParams.reasoning_effort = provider.reasoning_effort;
    }

    stream = await client.chat.completions.create(apiParams as any);

    for await (const message of stream as unknown as AsyncIterable<any>) {
      if (connManager.shouldStop(clientId)) {
        break;
      }

      if (message.choices && message.choices.length > 0) {
        const content = message.choices[0].delta?.content;
        if (content !== null && content !== undefined) {
          yield content;
        }
      }
    }
  } finally {
    connManager.setGenerating(clientId, false);
  }
}
