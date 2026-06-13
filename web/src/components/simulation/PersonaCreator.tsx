"use client";

import { useState, useEffect } from "react";
import { Sparkles, Loader2, FileText, Puzzle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import type { SimSkillInfo } from "@/hooks/useSimulation";

// ---- Templates ----

const PERSONA_TEMPLATES: Record<string, { label: string; emoji: string; content: string }> = {
  thinker: {
    label: "思想家",
    emoji: "🧠",
    content: `---
name:
role: 哲学家与批判性思考者
emoji: 🧠
tags:
  - 思想家
  - 哲学
---

# 身份
你是一位深度思考者，习惯用第一性原理分析问题。

# 价值观与优先级
- 追求真理和理解
- 保持智识诚实与严谨
- 对新视角保持开放
- 追求思考和表达的清晰

# 知识与专长
- 哲学与逻辑
- 思想史
- 批判性思维与论证
- 跨学科综合

# 行为倾向
- 通过追问揭示隐藏假设
- 逐步搭建论证
- 在形成结论前考虑多个视角
- 以尊重的方式挑战常识

# 沟通风格
- 清晰、结构化、精确
- 使用类比和思想实验
- 在易懂与深度之间保持平衡
- 坦率承认不确定性`,
  },
  leader: {
    label: "企业领袖",
    emoji: "💼",
    content: `---
name:
role: 科技行业CEO与愿景型领导者
emoji: 💼
tags:
  - 商业
  - 领导力
  - 科技
---

# 身份
你是一位经验丰富的科技公司CEO，曾经创建并扩展多家公司。

# 价值观与优先级
- 创新与市场变革
- 股东价值与可持续增长
- 人才发展与公司文化
- 战略定位与竞争优势

# 知识与专长
- 科技行业趋势与竞争动态
- 公司战略与并购
- 产品开发与市场进入
- 财务规划与投资者关系

# 行为倾向
- 从市场机会和竞争壁垒角度思考
- 在短期执行和长期愿景之间取得平衡
- 在不确定中果断决策
- 围绕雄心勃勃的目标凝聚团队

# 沟通风格
- 自信、面向未来
- 使用商业指标和市场数据
- 擅长讲述关于未来的有说服力叙事
- 直接、行动导向`,
  },
  ordinary: {
    label: "普通人",
    emoji: "🙂",
    content: `---
name:
role: 以常识看问题的普通人
emoji: 🙂
tags:
  - 日常
  - 实用
---

# 身份
你是一个普通人，拥有真实生活经验和朴素常识。

# 价值观与优先级
- 家庭、健康和财务安全
- 公平，以及好好对待他人
- 实用性高于理论
- 社区和归属感

# 知识与专长
- 来自日常生活的真实经验
- 理解事情如何影响普通人
- 以消费者视角看产品和服务
- 理解基层社会动态

# 行为倾向
- 穿透术语，追问“这对我意味着什么？”
- 分享个人经历和容易共鸣的例子
- 对过度复杂的方案保持怀疑
- 关注直接、可感知的影响

# 沟通风格
- 随意、像日常聊天
- 使用生活化语言，避免技术术语
- 情绪真实、表达直接
- 问出大家心里都在想的问题`,
  },
  child: {
    label: "儿童",
    emoji: "👶",
    content: `---
name:
role: 用新鲜眼光看世界的好奇儿童
emoji: 👶
tags:
  - 儿童
  - 好奇
---

# 身份
你是一个大约6到8岁的好奇孩子，用惊奇的眼光看世界，对所有事情都爱问“为什么”。

# 价值观与优先级
- 好奇，想理解一切
- 公平，“这不公平！”
- 快乐、玩耍和想象力
- 善待他人和动物

# 知识与专长
- 对生活有简单但深刻的观察
- 理解基本的是非对错
- 熟悉学校、动画片和游戏
- 会通过天真的问题表现出意外智慧

# 行为倾向
- 不断追问“为什么？”直到问到根上
- 指出大人习以为常的事情
- 运用想象力，建立出人意料的联系
- 开放、诚实地表达情绪

# 沟通风格
- 用简单词和短句
- 问很多问题
- 使用来自儿童世界的创造性比喻
- 热情、有活力`,
  },
};

interface PersonaCreatorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, content: string) => void;
  onGenerate: (prompt: string) => void;
  isGenerating: boolean;
  generatedContent: string | null;
  onClearGenerated: () => void;
  /** Pre-fill for editing an existing persona */
  editName?: string;
  editContent?: string;
  /** Available skills for the skill dropdown */
  simulationSkills?: SimSkillInfo[];
}

export function PersonaCreator({
  open,
  onOpenChange,
  onSave,
  onGenerate,
  isGenerating,
  generatedContent,
  onClearGenerated,
  editName,
  editContent,
  simulationSkills,
}: PersonaCreatorProps) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [emoji, setEmoji] = useState("🤖");
  const [skill, setSkill] = useState("");
  const [body, setBody] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      if (editContent) {
        setBody(editContent);
        setName(editName ?? "");
        // Try to parse frontmatter for fields
        const match = editContent.match(/^---\n([\s\S]*?)\n---/);
        if (match) {
          const fm = match[1];
          const nameMatch = fm.match(/^name:\s*(.+)$/m);
          const roleMatch = fm.match(/^role:\s*(.+)$/m);
          const emojiMatch = fm.match(/^emoji:\s*(.+)$/m);
          const skillMatch = fm.match(/^skill:\s*(.+)$/m);
          if (nameMatch) setName(nameMatch[1].trim());
          if (roleMatch) setRole(roleMatch[1].trim());
          if (emojiMatch) setEmoji(emojiMatch[1].trim());
          setSkill(skillMatch ? skillMatch[1].trim() : "");
        }
      } else {
        setName("");
        setRole("");
        setEmoji("🤖");
        setSkill("");
        setBody("");
      }
      setAiPrompt("");
      onClearGenerated();
    }
  }, [open, editContent, editName, onClearGenerated]);

  // Apply generated content
  useEffect(() => {
    if (generatedContent) {
      setBody(generatedContent);
      // Parse frontmatter from generated
      const match = generatedContent.match(/^---\n([\s\S]*?)\n---/);
      if (match) {
        const fm = match[1];
        const nameMatch = fm.match(/^name:\s*(.+)$/m);
        const roleMatch = fm.match(/^role:\s*(.+)$/m);
        const emojiMatch = fm.match(/^emoji:\s*(.+)$/m);
        if (nameMatch) setName(nameMatch[1].trim());
        if (roleMatch) setRole(roleMatch[1].trim());
        if (emojiMatch) setEmoji(emojiMatch[1].trim());
      }
    }
  }, [generatedContent]);

  const applyTemplate = (key: string) => {
    const t = PERSONA_TEMPLATES[key];
    if (!t) return;
    setBody(t.content);
    setEmoji(t.emoji);
    // Clear name/role so user fills them in
    setName("");
    setRole("");
  };

  const buildContent = (): string => {
    // If body already has frontmatter, update the name/role/emoji/skill in it
    if (body.startsWith("---")) {
      let updated = body;
      updated = updated.replace(/^(name:\s*).*$/m, `$1${name}`);
      updated = updated.replace(/^(role:\s*).*$/m, `$1${role}`);
      updated = updated.replace(/^(emoji:\s*).*$/m, `$1${emoji}`);
      // Update or add/remove skill field
      if (updated.match(/^skill:\s*.*$/m)) {
        if (skill) {
          updated = updated.replace(/^(skill:\s*).*$/m, `$1${skill}`);
        } else {
          // Remove the skill line if cleared
          updated = updated.replace(/^skill:\s*.*\n?/m, "");
        }
      } else if (skill) {
        // Insert skill field before the closing --- (second occurrence)
        const closingIdx = updated.indexOf("\n---", 3);
        if (closingIdx !== -1) {
          updated = updated.slice(0, closingIdx) + `\nskill: ${skill}` + updated.slice(closingIdx);
        }
      }
      return updated;
    }
    // Otherwise, prepend frontmatter
    const skillLine = skill ? `\nskill: ${skill}` : "";
    return `---
name: ${name}
role: ${role}
emoji: ${emoji}
tags: []${skillLine}
---

${body}`;
  };

  const handleSave = () => {
    if (!name.trim()) return;
    onSave(name.trim(), buildContent());
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {editName ? `编辑人物：${editName}` : "新建人物"}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-2">
          {/* Basic fields */}
          <div className="grid grid-cols-[1fr_1fr_80px] gap-3">
            <div>
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                名称
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：苏格拉底"
                className="mt-1 h-8 text-xs"
              />
            </div>
            <div>
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                角色 / 职位
              </label>
              <Input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="如：古希腊哲学家"
                className="mt-1 h-8 text-xs"
              />
            </div>
            <div>
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Emoji
              </label>
              <Input
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                placeholder="🤖"
                className="mt-1 h-8 text-xs text-center"
                maxLength={4}
              />
            </div>
          </div>

          {/* Skill selector */}
          {simulationSkills && simulationSkills.length > 0 && (
            <div>
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <Puzzle className="h-3 w-3" />
                关联技能（可选）
              </label>
              <Select value={skill || "__none__"} onValueChange={(v) => setSkill(v === "__none__" ? "" : (v ?? ""))}>
                <SelectTrigger className="mt-1 h-8 text-xs w-full">
                  <SelectValue placeholder="不关联技能" />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectItem value="__none__" className="text-xs">
                    <span className="text-muted-foreground">不关联技能</span>
                  </SelectItem>
                  {simulationSkills.map((s) => (
                    <SelectItem key={s.name} value={s.name} className="text-xs">
                      <div>
                        <div className="font-medium">{s.name}</div>
                        <div className="text-[10px] text-muted-foreground">{s.description}</div>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Templates */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              快速模板
            </label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {Object.entries(PERSONA_TEMPLATES).map(([key, t]) => (
                <Button
                  key={key}
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-[10px] h-7"
                  onClick={() => applyTemplate(key)}
                >
                  <span>{t.emoji}</span>
                  {t.label}
                </Button>
              ))}
            </div>
          </div>

          <Separator className="opacity-50" />

          {/* AI generation */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="h-3 w-3" />
              AI 生成
            </label>
            <div className="mt-1.5 flex gap-2">
              <Input
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                placeholder='如："一个 6 岁的中国小女孩，喜欢画画和恐龙"'
                className="flex-1 h-8 text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && aiPrompt.trim() && !isGenerating) {
                    onGenerate(aiPrompt.trim());
                  }
                }}
              />
              <Button
                size="sm"
                className="gap-1.5 text-xs h-8 shrink-0"
                onClick={() => {
                  if (aiPrompt.trim()) onGenerate(aiPrompt.trim());
                }}
                disabled={!aiPrompt.trim() || isGenerating}
              >
                {isGenerating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {isGenerating ? "生成中…" : "生成"}
              </Button>
            </div>
          </div>

          <Separator className="opacity-50" />

          {/* SOUL.md body editor */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <FileText className="h-3 w-3" />
              人物设定内容（Markdown）
            </label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={`---
name: 我的人物
role: 角色说明
emoji: 🤖
tags:
  - 标签1
---

# 身份
...

# 价值观与优先级
...

# 知识与专长
...

# 行为倾向
...

# 沟通风格
...`}
              className="mt-1.5 min-h-[280px] text-xs font-mono leading-relaxed resize-y"
            />
          </div>
        </div>

        <DialogFooter className="mt-2">
          <DialogClose render={<Button variant="outline" size="sm" />}>
            取消
          </DialogClose>
          <Button size="sm" onClick={handleSave} disabled={!name.trim() || !body.trim()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
