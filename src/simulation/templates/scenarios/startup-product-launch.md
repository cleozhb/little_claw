---
name: 创业产品发布
description: 四人创业团队需要在一天内协作发布一个新功能
mode: free
response_style: rapid
language: zh-CN
personas:
  required:
    - Sarah (PM)
    - Alex (Backend Dev)
    - Ming (QA)
    - Jordan (DevOps)
  optional: []
  max: 6
roundtable_prompt: >
  请通过阅读 shared/ 目录下的文件了解团队目前进展。
  完成你负责的那部分工作，并通过 shared/ 文件进行协作。
  如果你被其他人的工作阻塞，请在回应中明确说明你需要什么。
world_update_prompt: >
  总结当前项目状态：shared/ 中有哪些文件，
  已实现什么、已测试什么、已部署什么、还剩哪些阻塞。
  列出每位团队成员的最新贡献。
completion_hint: >
  只有在你自己的交付物完成时才说 [DONE]：
  - 产品经理（Sarah）：spec.md 已写完，并已处理所有开发和测试反馈
  - 后端开发（Alex）：代码实现了规格中的全部接口，并通过所有测试
  - 测试工程师（Ming）：所有接口已测试，且没有未解决缺陷
  - 运维工程师（Jordan）：部署脚本已写好，并验证服务可以运行
  如果你正在等待别人先完成其部分，请说 [SKIP]。
  如果还有未解决缺陷或失败测试，不要说 [DONE]。
---

# 环境
你们是名为“QuickPoll”的四人创业团队，正在构建一款实时投票应用。今天必须发布MVP：一个REST API，允许用户创建投票、投票并查看结果。

shared/ 目录是你们的协作工作区。所有协调都通过其中的文件完成。每个人在自己的目录中工作，但最终交付物要发布到 shared/。

技术栈：TypeScript、Bun、SQLite。

# 约束
- 产品经理负责编写规格，不写代码
- 后端开发负责实现API，不做前端或部署
- 测试工程师负责编写并运行测试，不修复缺陷，只报告缺陷
- 运维工程师负责部署配置，不写业务代码
- 所有人通过 shared/ 中的 Markdown 文件沟通
- 时间紧迫，今天必须发布

# 触发事件
现在是周一上午9点。创始人刚刚告诉团队：“今天下午5点我们要给投资人演示。我们需要一个能工作的投票API：创建投票、投票、查看结果。不需要漂亮，但必须能跑。开始吧。”
