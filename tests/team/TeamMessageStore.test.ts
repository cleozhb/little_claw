import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { Database } from "../../src/db/Database.ts";
import { ProjectChannelStore } from "../../src/team/ProjectChannelStore.ts";
import { TeamMessageStore } from "../../src/team/TeamMessageStore.ts";

const TEST_DB = "/tmp/little_claw_team_messages_test.db";

let db: Database;
let messages: TeamMessageStore;
let channels: ProjectChannelStore;

beforeEach(() => {
  db = new Database(TEST_DB);
  messages = new TeamMessageStore(db);
  channels = new ProjectChannelStore(db, messages);
});

afterEach(() => {
  db.close();
  try {
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {}
});

describe("TeamMessageStore and ProjectChannelStore", () => {
  test("creates a project channel and writes project messages", () => {
    const channel = channels.createChannel({
      slug: "lovely-octopus",
      title: "Lovely Octopus",
      description: "Team orchestration project.",
      contextPath: "context-hub/3-projects/lovely-octopus",
    });

    const message = channels.postMessage(channel.slug, {
      senderType: "human",
      senderId: "ceo",
      content: "Add a project channel store.",
      priority: "high",
    });

    expect(channel.id).toBeTruthy();
    expect(channel.slug).toBe("lovely-octopus");
    expect(message.channelType).toBe("project");
    expect(message.channelId).toBe(channel.id);
    expect(message.project).toBe("lovely-octopus");
    expect(message.status).toBe("new");

    expect(channels.listMessages(channel.id).map((item) => item.content)).toEqual([
      "Add a project channel store.",
    ]);
  });

  test("creates agent DM messages and returns pending messages for the target agent", () => {
    const coderDm = messages.createMessage({
      channelType: "agent_dm",
      channelId: "coder",
      senderType: "human",
      senderId: "ceo",
      content: "Please review this bug.",
    });
    messages.createMessage({
      channelType: "agent_dm",
      channelId: "researcher",
      senderType: "human",
      senderId: "ceo",
      content: "Find references.",
    });

    expect(messages.getPendingForAgent("coder").map((message) => message.id)).toEqual([
      coderDm.id,
    ]);

    messages.markInjected(coderDm.id, "coder");
    expect(messages.getPendingForAgent("coder")).toEqual([]);
  });

  test("binds and resolves an external chat to a project channel", () => {
    const channel = channels.createChannel({
      slug: "little-claw",
      title: "Little Claw",
    });

    const binding = channels.bindExternalChat({
      externalChannel: "feishu",
      externalChatId: "chat-1",
      channelType: "project",
      channelId: "little-claw",
      createdBy: "ceo",
    });

    expect(binding.externalChannel).toBe("feishu");
    expect(binding.externalChatId).toBe("chat-1");
    expect(binding.channelType).toBe("project");
    expect(binding.channelId).toBe(channel.id);

    expect(channels.resolveExternalChat("feishu", "chat-1")?.channelId).toBe(channel.id);

    channels.unbindExternalChat("feishu", "chat-1");
    expect(channels.resolveExternalChat("feishu", "chat-1")).toBeNull();
  });

  test("rebinding an external chat updates the target instead of creating duplicates", () => {
    const first = channels.createChannel({ slug: "first-project", title: "First" });
    const second = channels.createChannel({ slug: "second-project", title: "Second" });

    channels.bindExternalChat({
      externalChannel: "feishu",
      externalChatId: "chat-1",
      channelType: "project",
      channelId: first.id,
      createdBy: "ceo",
    });
    channels.bindExternalChat({
      externalChannel: "feishu",
      externalChatId: "chat-1",
      channelType: "project",
      channelId: second.id,
      createdBy: "ceo",
    });

    expect(channels.resolveExternalChat("feishu", "chat-1")?.channelId).toBe(second.id);
  });

  test("deduplicates external messages from retrying channels", () => {
    const first = messages.createMessage({
      channelType: "coordinator",
      channelId: "default",
      senderType: "human",
      senderId: "ceo",
      content: "Please triage this.",
      externalChannel: "feishu",
      externalChatId: "chat-1",
      externalMessageId: "message-1",
    });
    const retry = messages.createMessage({
      channelType: "coordinator",
      channelId: "default",
      senderType: "human",
      senderId: "ceo",
      content: "Please triage this duplicate.",
      externalChannel: "feishu",
      externalChatId: "chat-1",
      externalMessageId: "message-1",
    });

    expect(retry.id).toBe(first.id);
    expect(messages.listMessages()).toHaveLength(1);
    expect(messages.getMessage(first.id)?.content).toBe("Please triage this.");
  });

  test("pending project and task queries ignore injected and resolved messages", () => {
    const channel = channels.createChannel({
      slug: "ops-project",
      title: "Ops",
    });
    const first = channels.postMessage(channel.slug, {
      senderType: "human",
      senderId: "ceo",
      content: "Investigate deployment.",
      taskId: "task-1",
    });
    const second = channels.postMessage(channel.slug, {
      senderType: "agent",
      senderId: "coder",
      content: "I need logs.",
      taskId: "task-1",
    });
    const third = channels.postMessage(channel.slug, {
      senderType: "human",
      senderId: "ceo",
      content: "Resolved in another thread.",
      taskId: "task-1",
    });

    messages.markRouted(first.id, "router");
    messages.markAcked(second.id, "gateway");
    messages.markResolved(third.id, "coordinator");

    expect(messages.getPendingForProject("ops-project").map((message) => message.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(messages.getPendingForTask("task-1").map((message) => message.id)).toEqual([
      first.id,
      second.id,
    ]);

    messages.markInjected(first.id, "coder");
    messages.markInjected(second.id, "coder");
    expect(messages.getPendingForProject("ops-project")).toEqual([]);
  });

  test("validates project channel slugs", () => {
    expect(() =>
      channels.createChannel({
        slug: "../bad",
        title: "Bad",
      }),
    ).toThrow("Invalid project channel slug");

    expect(() =>
      channels.createChannel({
        slug: "BadSlug",
        title: "Bad",
      }),
    ).toThrow("Invalid project channel slug");
  });
});
