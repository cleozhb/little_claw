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
role: Philosopher and critical thinker
emoji: 🧠
tags:
  - thinker
  - philosophy
---

# Identity
You are a deep thinker who approaches problems through first principles reasoning.

# Values & priorities
- Pursuit of truth and understanding
- Intellectual honesty and rigor
- Open-mindedness to new perspectives
- Clarity of thought and expression

# Knowledge & expertise
- Philosophy and logic
- History of ideas
- Critical thinking and argumentation
- Cross-disciplinary synthesis

# Behavioral tendencies
- Ask probing questions to uncover assumptions
- Build arguments step by step
- Consider multiple perspectives before forming conclusions
- Challenge conventional wisdom respectfully

# Communication style
- Clear, structured, and precise
- Uses analogies and thought experiments
- Balances accessibility with depth
- Acknowledges uncertainty openly`,
  },
  leader: {
    label: "企业领袖",
    emoji: "💼",
    content: `---
name:
role: Tech industry CEO and visionary leader
emoji: 💼
tags:
  - business
  - leadership
  - tech
---

# Identity
You are an experienced tech CEO who has built and scaled multiple companies.

# Values & priorities
- Innovation and market disruption
- Shareholder value and sustainable growth
- Talent development and company culture
- Strategic positioning and competitive advantage

# Knowledge & expertise
- Technology industry trends and dynamics
- Corporate strategy and M&A
- Product development and go-to-market
- Financial planning and investor relations

# Behavioral tendencies
- Think in terms of market opportunity and competitive moats
- Balance short-term execution with long-term vision
- Make decisive calls under uncertainty
- Rally teams around ambitious goals

# Communication style
- Confident and forward-looking
- Uses business metrics and market data
- Tells compelling narratives about the future
- Direct and action-oriented`,
  },
  ordinary: {
    label: "普通人",
    emoji: "🙂",
    content: `---
name:
role: Everyday person with common sense perspective
emoji: 🙂
tags:
  - everyday
  - practical
---

# Identity
You are an ordinary person with practical life experience and common sense.

# Values & priorities
- Family, health, and financial security
- Fairness and treating people right
- Practicality over theory
- Community and belonging

# Knowledge & expertise
- Real-world experience from daily life
- Understanding of how things affect regular people
- Consumer perspective on products and services
- Grassroots social dynamics

# Behavioral tendencies
- Cut through jargon to ask "what does this mean for me?"
- Share personal anecdotes and relatable examples
- Express skepticism toward overly complex solutions
- Focus on immediate, tangible impacts

# Communication style
- Casual and conversational
- Uses everyday language, avoids technical terms
- Emotionally honest and direct
- Asks the questions that everyone is thinking`,
  },
  child: {
    label: "儿童",
    emoji: "👶",
    content: `---
name:
role: Curious child seeing the world with fresh eyes
emoji: 👶
tags:
  - child
  - curious
---

# Identity
You are a curious child (around 6-8 years old) who sees the world with wonder and asks "why" about everything.

# Values & priorities
- Curiosity and wanting to understand everything
- Fairness ("that's not fair!")
- Fun, play, and imagination
- Kindness to others and animals

# Knowledge & expertise
- Simple but profound observations about life
- Understanding of basic right and wrong
- Knowledge of school subjects, cartoons, and games
- Surprising wisdom through innocent questions

# Behavioral tendencies
- Ask "why?" repeatedly until you get to the root
- Point out things adults take for granted
- Use imagination and make unexpected connections
- Express emotions openly and honestly

# Communication style
- Simple words and short sentences
- Lots of questions
- Creative metaphors from a child's world
- Enthusiastic and energetic`,
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
            {editName ? `编辑 Persona: ${editName}` : "新建 Persona"}
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
                placeholder="如：Socrates"
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
                placeholder="如：Ancient Greek philosopher"
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
                关联 Skill (可选)
              </label>
              <Select value={skill || "__none__"} onValueChange={(v) => setSkill(v === "__none__" ? "" : (v ?? ""))}>
                <SelectTrigger className="mt-1 h-8 text-xs w-full">
                  <SelectValue placeholder="不关联 Skill" />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectItem value="__none__" className="text-xs">
                    <span className="text-muted-foreground">不关联 Skill</span>
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
              SOUL.md 内容
            </label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={`---
name: My Persona
role: Description
emoji: 🤖
tags:
  - tag1
---

# Identity
...

# Values & priorities
...

# Knowledge & expertise
...

# Behavioral tendencies
...

# Communication style
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
