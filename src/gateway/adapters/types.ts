/**
 * 通用 Webhook 消息结构，所有 IM 渠道适配器解析后统一输出此格式。
 */
export interface WebhookMessage {
  /** 渠道类型：feishu / dingtalk / wechat ... */
  channelType: string;
  /** 会话 ID（群聊 ID 或私聊 ID） */
  chatId: string;
  /** 发送者 ID */
  userId: string;
  /** 消息文本内容 */
  text: string;
}
