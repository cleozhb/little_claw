import type { FeishuChannelConfig } from "../../config/index.ts";
import type { WebhookMessage } from "./types.ts";
import { createLogger } from "../../utils/logger.ts";
import { createHash, createDecipheriv } from "node:crypto";

const log = createLogger("FeishuAdapter");

/** 飞书单条消息最大字符数（保守值，实际约 4096） */
const MAX_MESSAGE_LENGTH = 4000;

// ============================================================
// Types — 飞书事件回调结构
// ============================================================

/** 飞书 URL 验证请求 */
interface FeishuChallengeBody {
  challenge: string;
  token: string;
  type: "url_verification";
}

/** 飞书事件回调 v2 */
interface FeishuEventBody {
  schema: string;
  header: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
  };
  event: {
    sender: {
      sender_id: {
        open_id: string;
        user_id?: string;
        union_id?: string;
      };
      sender_type: string;
    };
    message: {
      message_id: string;
      chat_id: string;
      chat_type: string;
      content: string; // JSON string, e.g. '{"text":"hello"}'
      message_type: string;
      /** @mention 列表 */
      mentions?: Array<{ key: string; id: { open_id: string }; name: string }>;
    };
  };
}

// ============================================================
// FeishuAdapter
// ============================================================

export class FeishuAdapter {
  private config: FeishuChannelConfig;

  // tenant_access_token 缓存
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  // 消息去重：缓存最近处理过的 event_id（飞书可能重试推送）
  private processedEvents = new Set<string>();
  private processedEventsCleanupTimer: ReturnType<typeof setInterval>;

  constructor(config: FeishuChannelConfig) {
    this.config = config;

    // 每 10 分钟清理过期的 event_id 缓存
    this.processedEventsCleanupTimer = setInterval(() => {
      this.processedEvents.clear();
    }, 10 * 60 * 1000);
  }

  dispose(): void {
    clearInterval(this.processedEventsCleanupTimer);
  }

  // ----------------------------------------------------------
  // 解密（飞书 Encrypt Key）
  // ----------------------------------------------------------

  /**
   * 如果配置了 encryptKey 且 body 包含 encrypt 字段，解密后返回明文 JSON 对象。
   * 否则直接返回原始 body。
   */
  decryptBody(body: Record<string, unknown>): Record<string, unknown> {
    if (typeof body.encrypt !== "string") {
      return body;
    }

    if (!this.config.encryptKey) {
      log.error("Received encrypted body but no encryptKey configured");
      throw new Error("Encrypt key not configured");
    }

    try {
      const key = createHash("sha256").update(this.config.encryptKey).digest();
      const encryptedBuf = Buffer.from(body.encrypt as string, "base64");
      // 前 16 字节是 IV
      const iv = encryptedBuf.subarray(0, 16);
      const ciphertext = encryptedBuf.subarray(16);
      const decipher = createDecipheriv("aes-256-cbc", key, iv);
      let decrypted = decipher.update(ciphertext, undefined, "utf8");
      decrypted += decipher.final("utf8");
      const parsed = JSON.parse(decrypted);
      log.info("Decrypted feishu event body successfully");
      return parsed as Record<string, unknown>;
    } catch (err) {
      log.error("Failed to decrypt feishu body", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // ----------------------------------------------------------
  // 签名验证
  // ----------------------------------------------------------

  /**
   * 验证飞书事件回调的签名。
   * 飞书 v2 事件使用 header.token 与 verification_token 比对。
   */
  verifyToken(body: Record<string, unknown>): boolean {
    // v2 事件回调：header.token
    const header = body.header as Record<string, unknown> | undefined;
    if (header && typeof header.token === "string") {
      return header.token === this.config.verificationToken;
    }

    // URL 验证请求：token 在顶层
    if (typeof body.token === "string") {
      return body.token === this.config.verificationToken;
    }

    return false;
  }

  // ----------------------------------------------------------
  // Challenge 处理
  // ----------------------------------------------------------

  /**
   * 检查是否为飞书 URL 验证请求。
   * 若是，返回 { challenge } 响应 body；否则返回 null。
   */
  handleChallenge(body: Record<string, unknown>): { challenge: string } | null {
    if (body.type === "url_verification" && typeof body.challenge === "string") {
      return { challenge: body.challenge };
    }
    return null;
  }

  // ----------------------------------------------------------
  // 消息解析
  // ----------------------------------------------------------

  /**
   * 将飞书事件回调解析为通用 WebhookMessage。
   * 仅处理 im.message.receive_v1 文本消息，其他类型返回 null。
   */
  parseToInternal(body: Record<string, unknown>): WebhookMessage | null {
    const header = body.header as FeishuEventBody["header"] | undefined;
    if (!header || header.event_type !== "im.message.receive_v1") {
      return null;
    }

    // 消息去重
    if (this.processedEvents.has(header.event_id)) {
      log.debug(`Duplicate event ignored: ${header.event_id}`);
      return null;
    }
    this.processedEvents.add(header.event_id);

    const event = body.event as FeishuEventBody["event"] | undefined;
    if (!event?.message) {
      return null;
    }

    const { message, sender } = event;

    // 目前只处理文本消息
    if (message.message_type !== "text") {
      log.debug(`Ignoring non-text message type: ${message.message_type}`);
      return null;
    }

    let text = "";
    try {
      const content = JSON.parse(message.content);
      text = content.text ?? "";
    } catch {
      log.warn(`Failed to parse message content: ${message.content}`);
      return null;
    }

    // 去除 @机器人 的 mention 标记
    if (message.mentions) {
      for (const mention of message.mentions) {
        text = text.replace(mention.key, "").trim();
      }
    }

    if (!text) {
      return null;
    }

    return {
      channelType: "feishu",
      chatId: message.chat_id,
      userId: sender.sender_id.open_id,
      text,
    };
  }

  // ----------------------------------------------------------
  // 发送消息
  // ----------------------------------------------------------

  /**
   * 向指定飞书会话发送消息。
   * 支持 Markdown（通过 interactive 卡片），超长内容自动分段发送。
   */
  async sendToChannel(chatId: string, content: string): Promise<void> {
    if (!content.trim()) return;

    const segments = this.splitMessage(content);
    for (const segment of segments) {
      await this.sendSingleMessage(chatId, segment);
    }
  }

  private async sendSingleMessage(chatId: string, content: string): Promise<void> {
    const token = await this.getAccessToken();

    // 使用纯文本消息发送（兼容性最好）
    const body = {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text: content }),
    };

    try {
      const resp = await fetch(
        "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        },
      );

      if (!resp.ok) {
        const text = await resp.text();
        log.error(`Feishu send message failed: ${resp.status}`, text);
      } else {
        const result = await resp.json() as { code: number; msg: string };
        if (result.code !== 0) {
          log.error(`Feishu API error: code=${result.code}, msg=${result.msg}`);
        }
      }
    } catch (err) {
      log.error(`Feishu send message exception`, err instanceof Error ? err.message : String(err));
    }
  }

  // ----------------------------------------------------------
  // Access Token 管理
  // ----------------------------------------------------------

  private async getAccessToken(): Promise<string> {
    // 缓存未过期则直接返回（提前 60s 刷新）
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    try {
      const resp = await fetch(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            app_id: this.config.appId,
            app_secret: this.config.appSecret,
          }),
        },
      );

      const data = await resp.json() as {
        code: number;
        msg: string;
        tenant_access_token: string;
        expire: number;
      };

      if (data.code !== 0) {
        throw new Error(`Feishu token error: code=${data.code}, msg=${data.msg}`);
      }

      this.accessToken = data.tenant_access_token;
      this.tokenExpiresAt = Date.now() + data.expire * 1000;
      log.info(`Feishu access token refreshed, expires in ${data.expire}s`);

      return this.accessToken;
    } catch (err) {
      log.error(`Failed to get Feishu access token`, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // ----------------------------------------------------------
  // 消息分段
  // ----------------------------------------------------------

  /**
   * 将长文本按 MAX_MESSAGE_LENGTH 拆分，尽量在换行处切分。
   */
  private splitMessage(content: string): string[] {
    if (content.length <= MAX_MESSAGE_LENGTH) {
      return [content];
    }

    const segments: string[] = [];
    let remaining = content;

    while (remaining.length > MAX_MESSAGE_LENGTH) {
      // 尝试在最大长度内找最后一个换行符切分
      let splitIndex = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
      if (splitIndex <= 0) {
        // 没有换行，硬切
        splitIndex = MAX_MESSAGE_LENGTH;
      }
      segments.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).replace(/^\n/, "");
    }

    if (remaining) {
      segments.push(remaining);
    }

    return segments;
  }
}
