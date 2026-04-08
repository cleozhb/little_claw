"use client";

import { useState, useEffect } from "react";
import { Sparkles, Loader2, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const SIMULATION_MODES = [
  { value: "roundtable", label: "圆桌讨论 (轮流发言)" },
  { value: "parallel", label: "并行响应 (同时发言)" },
  { value: "parallel_then_roundtable", label: "先并行后圆桌" },
  { value: "free", label: "自由模式 (世界状态驱动)" },
];

interface ScenarioCreatorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, content: string) => void;
  onGenerate: (prompt: string) => void;
  isGenerating: boolean;
  generatedContent: string | null;
  onClearGenerated: () => void;
  /** Pre-fill for editing */
  editName?: string;
  editContent?: string;
}

export function ScenarioCreator({
  open,
  onOpenChange,
  onSave,
  onGenerate,
  isGenerating,
  generatedContent,
  onClearGenerated,
  editName,
  editContent,
}: ScenarioCreatorProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState("roundtable");
  const [rounds, setRounds] = useState("3");
  const [body, setBody] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");

  // Reset on open
  useEffect(() => {
    if (open) {
      if (editContent) {
        setBody(editContent);
        setName(editName ?? "");
        const match = editContent.match(/^---\n([\s\S]*?)\n---/);
        if (match) {
          const fm = match[1];
          const nameMatch = fm.match(/^name:\s*(.+)$/m);
          const descMatch = fm.match(/^description:\s*(.+)$/m);
          const modeMatch = fm.match(/^mode:\s*(.+)$/m);
          const roundsMatch = fm.match(/^rounds:\s*(.+)$/m);
          if (nameMatch) setName(nameMatch[1].trim());
          if (descMatch) setDescription(descMatch[1].trim());
          if (modeMatch) setMode(modeMatch[1].trim());
          if (roundsMatch) setRounds(roundsMatch[1].trim());
        }
      } else {
        setName("");
        setDescription("");
        setMode("roundtable");
        setRounds("3");
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
      const match = generatedContent.match(/^---\n([\s\S]*?)\n---/);
      if (match) {
        const fm = match[1];
        const nameMatch = fm.match(/^name:\s*(.+)$/m);
        const descMatch = fm.match(/^description:\s*(.+)$/m);
        const modeMatch = fm.match(/^mode:\s*(.+)$/m);
        const roundsMatch = fm.match(/^rounds:\s*(.+)$/m);
        if (nameMatch) setName(nameMatch[1].trim());
        if (descMatch) setDescription(descMatch[1].trim());
        if (modeMatch) setMode(modeMatch[1].trim());
        if (roundsMatch) setRounds(roundsMatch[1].trim());
      }
    }
  }, [generatedContent]);

  const buildContent = (): string => {
    if (body.startsWith("---")) {
      let updated = body;
      updated = updated.replace(/^(name:\s*).*$/m, `$1${name}`);
      updated = updated.replace(/^(description:\s*).*$/m, `$1${description}`);
      updated = updated.replace(/^(mode:\s*).*$/m, `$1${mode}`);
      updated = updated.replace(/^(rounds:\s*).*$/m, `$1${rounds}`);
      return updated;
    }
    return `---
name: ${name}
description: ${description}
mode: ${mode}
rounds: ${rounds}
parallel_prompt: >
  请从你的角度回应这个场景。
roundtable_prompt: >
  你已经看到了其他参与者的回应。请直接回应他们的观点。
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
            {editName ? `编辑 Scenario: ${editName}` : "新建 Scenario"}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-2">
          {/* Basic fields */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                名称
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：AI Regulation Response"
                className="mt-1 h-8 text-xs"
              />
            </div>
            <div>
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                简述
              </label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="一句话描述场景"
                className="mt-1 h-8 text-xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                模式
              </label>
              <Select value={mode} onValueChange={(v) => { if (v) setMode(v); }}>
                <SelectTrigger className="mt-1 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SIMULATION_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value} className="text-xs">
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                轮次
              </label>
              <Input
                type="number"
                min={1}
                max={20}
                value={rounds}
                onChange={(e) => setRounds(e.target.value)}
                className="mt-1 h-8 text-xs"
              />
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
                placeholder='如："模拟美联储加息后各科技公司的反应"'
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

          {/* Scenario body editor */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <FileText className="h-3 w-3" />
              Scenario 内容 (Markdown)
            </label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={`---
name: My Scenario
description: A short description
mode: roundtable
rounds: 3
parallel_prompt: >
  Your parallel round prompt here.
roundtable_prompt: >
  Your roundtable prompt here.
---

# Environment
Describe the setting...

# Constraints
- Constraint 1
- Constraint 2

# Trigger event
What kicks off the simulation...`}
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
