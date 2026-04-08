"use client";

import { useState } from "react";
import {
  Play, Pause, Square, Send, MessageCircle,
  ArrowRight, ChevronDown, ChevronRight, Settings,
  Users, Target, Handshake, FileText, Plus, Pencil, Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { PersonaCreator } from "./PersonaCreator";
import { ScenarioCreator } from "./ScenarioCreator";
import type { PersonaInfo, PersonaState, ScenarioInfo, SimStatus } from "@/hooks/useSimulation";

interface ControlPanelProps {
  // Lists
  personas: PersonaInfo[];
  scenarios: ScenarioInfo[];
  // Simulation state
  simStatus: SimStatus;
  scenarioName: string;
  scenarioMode: string;
  currentRound: number;
  totalRounds: number;
  personaStates: Map<string, PersonaState>;
  summary: string;
  // AI generation
  isGenerating: boolean;
  generatedContent: { target: "persona" | "scenario"; content: string } | null;
  // Actions
  onStart: (scenarioName: string, personaNames: string[], rounds?: number, mode?: string) => void;
  onInject: (content: string) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onNextRound: () => void;
  onSpeakThenNextRound: (content: string) => void;
  onEndDiscussion: () => void;
  onUpdatePersona: (name: string, content: string) => void;
  onUpdateScenario: (name: string, content: string) => void;
  onGenerateContent: (target: "persona" | "scenario", prompt: string) => void;
  onClearGenerated: () => void;
  onReset: () => void;
}

const statusIndicators: Record<PersonaState["status"], { color: string; label: string }> = {
  waiting: { color: "bg-muted-foreground/40", label: "等待" },
  speaking: { color: "bg-green-500 animate-pulse", label: "发言中" },
  done: { color: "bg-blue-500", label: "完成" },
};

function PersonaItem({
  persona,
  selected,
  disabled,
  badge,
  onToggle,
  onEdit,
}: {
  persona: PersonaInfo;
  selected: boolean;
  disabled: boolean;
  badge?: string;
  onToggle: () => void;
  onEdit: () => void;
}) {
  return (
    <button
      onClick={disabled ? undefined : onToggle}
      className={`
        group/persona relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-all
        ${disabled ? "cursor-default opacity-70" : ""}
        ${selected
          ? "bg-primary/10 text-foreground"
          : "hover:bg-accent/50 text-muted-foreground"
        }
      `}
    >
      {selected && (
        <span className="absolute left-0 top-1 bottom-1 w-[3px] rounded-full bg-blue-500" />
      )}
      <span className="text-sm">{persona.emoji}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium truncate">{persona.name}</span>
          {badge && (
            <span className={`text-[8px] px-1 py-0 rounded ${
              disabled ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400" : "bg-muted text-muted-foreground"
            }`}>
              {badge}
            </span>
          )}
          {disabled && <Lock className="h-2.5 w-2.5 text-muted-foreground" />}
        </div>
        <div className="text-[9px] text-muted-foreground truncate">{persona.role}</div>
      </div>
      <span
        role="button"
        tabIndex={0}
        className="shrink-0 text-muted-foreground hover:text-foreground opacity-0 group-hover/persona:opacity-60 hover:!opacity-100 transition-opacity"
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.stopPropagation();
            onEdit();
          }
        }}
      >
        <Settings className="h-3 w-3" />
      </span>
    </button>
  );
}

export function ControlPanel({
  personas,
  scenarios,
  simStatus,
  scenarioName,
  scenarioMode,
  currentRound,
  totalRounds,
  personaStates,
  summary,
  isGenerating,
  generatedContent,
  onStart,
  onInject,
  onPause,
  onResume,
  onStop,
  onNextRound,
  onSpeakThenNextRound,
  onEndDiscussion,
  onUpdatePersona,
  onUpdateScenario,
  onGenerateContent,
  onClearGenerated,
  onReset,
}: ControlPanelProps) {
  // Setup form state
  const [selectedScenario, setSelectedScenario] = useState<string>("");
  const [selectedPersonas, setSelectedPersonas] = useState<Set<string>>(new Set());
  const [roundsOverride, setRoundsOverride] = useState<string>("");
  const [showAllPersonas, setShowAllPersonas] = useState(false);

  // Moderator input
  const [injectText, setInjectText] = useState("");
  // Speak input (for round-end waiting)
  const [speakText, setSpeakText] = useState("");

  // Expanded thinking panels
  const [expandedPersonas, setExpandedPersonas] = useState<Set<string>>(new Set());

  // Creator dialogs
  const [personaCreatorOpen, setPersonaCreatorOpen] = useState(false);
  const [scenarioCreatorOpen, setScenarioCreatorOpen] = useState(false);
  const [editPersonaName, setEditPersonaName] = useState<string | undefined>(undefined);
  const [editPersonaContent, setEditPersonaContent] = useState<string | undefined>(undefined);
  const [editScenarioName, setEditScenarioName] = useState<string | undefined>(undefined);
  const [editScenarioContent, setEditScenarioContent] = useState<string | undefined>(undefined);

  const isIdle = simStatus === "idle" || simStatus === "ended";
  const isRunning = simStatus === "running";
  const isPaused = simStatus === "paused";
  const isWaiting = simStatus === "waiting";

  // Derive persona config from currently selected scenario
  const currentScenario = scenarios.find((s) => s.name === selectedScenario);
  const requiredSet = new Set(currentScenario?.personas?.required ?? []);
  const optionalSet = new Set(currentScenario?.personas?.optional ?? []);
  const hasPersonaConfig = requiredSet.size > 0 || optionalSet.size > 0;

  const handleSelectScenario = (name: string) => {
    setSelectedScenario(name);
    setShowAllPersonas(false);
    // Auto-select required + optional personas
    const sc = scenarios.find((s) => s.name === name);
    if (sc?.personas) {
      const autoSelected = new Set<string>([
        ...(sc.personas.required ?? []),
        ...(sc.personas.optional ?? []),
      ]);
      setSelectedPersonas(autoSelected);
    } else {
      setSelectedPersonas(new Set());
    }
  };

  const togglePersonaSelection = (name: string) => {
    // Cannot deselect required personas
    if (requiredSet.has(name)) return;
    setSelectedPersonas((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleThinking = (name: string) => {
    setExpandedPersonas((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleStart = () => {
    if (!selectedScenario || selectedPersonas.size === 0) return;
    const rounds = roundsOverride ? parseInt(roundsOverride) : undefined;
    const scenario = scenarios.find((s) => s.name === selectedScenario);
    onStart(selectedScenario, Array.from(selectedPersonas), rounds, scenario?.mode);
  };

  const handleInject = () => {
    if (!injectText.trim()) return;
    onInject(injectText.trim());
    setInjectText("");
  };

  const handleSpeak = () => {
    if (!speakText.trim()) return;
    onSpeakThenNextRound(speakText.trim());
    setSpeakText("");
  };

  const openNewPersona = () => {
    setEditPersonaName(undefined);
    setEditPersonaContent(undefined);
    setPersonaCreatorOpen(true);
  };

  const openNewScenario = () => {
    setEditScenarioName(undefined);
    setEditScenarioContent(undefined);
    setScenarioCreatorOpen(true);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border/50 px-3 py-2.5">
        <h2 className="text-xs font-semibold tracking-tight">Control Panel</h2>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {/* ====== SETUP (when idle) ====== */}
        {isIdle && (
          <>
            {/* Scenario selector */}
            <div>
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  Scenario
                </label>
              <div className="flex items-center gap-0.5">
                {selectedScenario && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[9px] text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      const s = scenarios.find((sc) => sc.name === selectedScenario);
                      if (s) {
                        setEditScenarioName(s.name);
                        setEditScenarioContent(s.content);
                        setScenarioCreatorOpen(true);
                      }
                    }}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[9px] text-muted-foreground hover:text-foreground"
                  onClick={openNewScenario}
                >
                  <Plus className="h-3 w-3 mr-0.5" />
                  New
                </Button>
              </div>
              </div>
              <Select value={selectedScenario} onValueChange={(v) => { if (v) handleSelectScenario(v); }}>
                <SelectTrigger className="mt-1 h-8 text-xs w-full">
                  <SelectValue placeholder="选择场景…" />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  {scenarios.map((s) => (
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

            {/* Persona selector */}
            <div>
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  Personas ({selectedPersonas.size} 已选)
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[9px] text-muted-foreground hover:text-foreground"
                  onClick={openNewPersona}
                >
                  <Plus className="h-3 w-3 mr-0.5" />
                  New
                </Button>
              </div>
              <div className="mt-1.5 space-y-1">
                {/* Required personas: checked & disabled */}
                {hasPersonaConfig && personas
                  .filter((p) => requiredSet.has(p.name))
                  .map((p) => (
                    <PersonaItem
                      key={p.name}
                      persona={p}
                      selected={true}
                      disabled={true}
                      badge="必选"
                      onToggle={() => {}}
                      onEdit={() => {
                        setEditPersonaName(p.name);
                        setEditPersonaContent(p.content);
                        setPersonaCreatorOpen(true);
                      }}
                    />
                  ))}
                {/* Optional personas: checked by default, can uncheck */}
                {hasPersonaConfig && personas
                  .filter((p) => optionalSet.has(p.name))
                  .map((p) => (
                    <PersonaItem
                      key={p.name}
                      persona={p}
                      selected={selectedPersonas.has(p.name)}
                      disabled={false}
                      badge="推荐"
                      onToggle={() => togglePersonaSelection(p.name)}
                      onEdit={() => {
                        setEditPersonaName(p.name);
                        setEditPersonaContent(p.content);
                        setPersonaCreatorOpen(true);
                      }}
                    />
                  ))}
                {/* No persona config: show all personas normally */}
                {!hasPersonaConfig && personas.map((p) => (
                  <PersonaItem
                    key={p.name}
                    persona={p}
                    selected={selectedPersonas.has(p.name)}
                    disabled={false}
                    onToggle={() => togglePersonaSelection(p.name)}
                    onEdit={() => {
                      setEditPersonaName(p.name);
                      setEditPersonaContent(p.content);
                      setPersonaCreatorOpen(true);
                    }}
                  />
                ))}
                {/* "+ Add more" for scenarios with persona config */}
                {hasPersonaConfig && (() => {
                  const extraPersonas = personas.filter(
                    (p) => !requiredSet.has(p.name) && !optionalSet.has(p.name),
                  );
                  if (extraPersonas.length === 0) return null;
                  return (
                    <>
                      <button
                        onClick={() => setShowAllPersonas((v) => !v)}
                        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-all"
                      >
                        {showAllPersonas ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                        <Plus className="h-3 w-3" />
                        Add more ({extraPersonas.length})
                      </button>
                      {showAllPersonas && extraPersonas.map((p) => (
                        <PersonaItem
                          key={p.name}
                          persona={p}
                          selected={selectedPersonas.has(p.name)}
                          disabled={false}
                          onToggle={() => togglePersonaSelection(p.name)}
                          onEdit={() => {
                            setEditPersonaName(p.name);
                            setEditPersonaContent(p.content);
                            setPersonaCreatorOpen(true);
                          }}
                        />
                      ))}
                    </>
                  );
                })()}
              </div>
            </div>

            {/* Rounds override */}
            <div>
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                轮次 (可选)
              </label>
              <input
                type="number"
                min={1}
                max={20}
                placeholder="使用场景默认值"
                value={roundsOverride}
                onChange={(e) => setRoundsOverride(e.target.value)}
                className="mt-1 w-full h-8 rounded-md border border-border/50 bg-muted/30 px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            {/* Start button */}
            <Button
              className="w-full gap-2"
              size="sm"
              onClick={handleStart}
              disabled={!selectedScenario || selectedPersonas.size === 0}
            >
              <Play className="h-3.5 w-3.5" />
              开始模拟
            </Button>

            {simStatus === "ended" && (
              <Button variant="outline" className="w-full gap-2" size="sm" onClick={onReset}>
                重新开始
              </Button>
            )}
          </>
        )}

        {/* ====== ACTIVE SIMULATION ====== */}
        {!isIdle && (
          <>
            {/* Scenario info card */}
            <div className="rounded-lg border border-border/50 bg-card p-2.5">
              <div className="flex items-center gap-2">
                <Target className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[11px] font-semibold flex-1">{scenarioName}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                  onClick={openNewScenario}
                  title="新建 Scenario"
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
              <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4">
                  {scenarioMode || "roundtable"}
                </Badge>
                <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4">
                  第 {currentRound}{totalRounds ? ` / ${totalRounds}` : ""} 轮
                </Badge>
                <Badge
                  variant="secondary"
                  className={`text-[9px] px-1.5 py-0 h-4 ${
                    isRunning
                      ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
                      : isPaused
                        ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400"
                        : isWaiting
                          ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400"
                          : ""
                  }`}
                >
                  {isRunning ? "运行中" : isPaused ? "已暂停" : isWaiting ? "等待指令" : simStatus}
                </Badge>
              </div>
            </div>

            <Separator className="opacity-50" />

            {/* Agent list */}
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Users className="h-3 w-3 text-muted-foreground" />
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex-1">
                  Agents
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[9px] text-muted-foreground hover:text-foreground"
                  onClick={openNewPersona}
                >
                  <Plus className="h-3 w-3 mr-0.5" />
                  Add
                </Button>
              </div>
              <div className="space-y-1">
                {Array.from(personaStates.values()).map((ps) => {
                  const statusCfg = statusIndicators[ps.status];
                  const isExpanded = expandedPersonas.has(ps.name);

                  return (
                    <div key={ps.name}>
                      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50">
                        {/* Expand toggle */}
                        <button
                          onClick={() => toggleThinking(ps.name)}
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                        >
                          {isExpanded
                            ? <ChevronDown className="h-3 w-3" />
                            : <ChevronRight className="h-3 w-3" />
                          }
                        </button>
                        {/* Status dot */}
                        <span className={`h-2 w-2 rounded-full shrink-0 ${statusCfg.color}`} />
                        {/* Emoji + Name */}
                        <span className="text-sm shrink-0">{ps.emoji}</span>
                        <button
                          onClick={() => toggleThinking(ps.name)}
                          className="flex-1 min-w-0 text-left"
                        >
                          <span className="text-[11px] font-medium truncate block">{ps.name}</span>
                        </button>
                        {/* Status label */}
                        <span className="text-[9px] text-muted-foreground shrink-0">
                          {statusCfg.label}
                        </span>
                      </div>

                      {/* Expanded thinking content */}
                      {isExpanded && ps.thinking && (
                        <div className="ml-7 mt-1 mb-1 rounded-md bg-muted/50 p-2 text-[10px] text-muted-foreground italic leading-relaxed">
                          💭 {ps.thinking}
                        </div>
                      )}
                      {isExpanded && !ps.thinking && (
                        <div className="ml-7 mt-1 mb-1 text-[10px] text-muted-foreground/50 italic">
                          暂无内心独白
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <Separator className="opacity-50" />

            {/* === Round control: waiting state === */}
            {isWaiting && (
              <div>
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  Your Turn
                </label>
                <div className="mt-1.5 space-y-2">
                  <Textarea
                    placeholder="输入你的发言…"
                    value={speakText}
                    onChange={(e) => setSpeakText(e.target.value)}
                    className="min-h-[60px] text-xs resize-none"
                  />
                  <Button
                    size="sm"
                    className="w-full gap-1.5 text-xs h-7 bg-blue-600 hover:bg-blue-700 text-white"
                    onClick={handleSpeak}
                    disabled={!speakText.trim()}
                  >
                    <Send className="h-3 w-3" />
                    Speak & continue
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full gap-1.5 text-xs h-7"
                    onClick={onNextRound}
                  >
                    <ArrowRight className="h-3 w-3" />
                    Next round (silent)
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="w-full gap-1.5 text-xs h-7"
                    onClick={onEndDiscussion}
                  >
                    <Square className="h-3 w-3" />
                    End discussion
                  </Button>
                </div>
              </div>
            )}

            {/* === Running/Paused controls === */}
            {(isRunning || isPaused) && (
              <>
                {/* Moderator inject */}
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Moderator 注入
                  </label>
                  <div className="mt-1.5 space-y-2">
                    <Textarea
                      placeholder="输入要注入的指令…"
                      value={injectText}
                      onChange={(e) => setInjectText(e.target.value)}
                      className="min-h-[60px] text-xs resize-none"
                      disabled={!isRunning && !isPaused}
                    />
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        className="flex-1 gap-1.5 text-xs h-7"
                        onClick={handleInject}
                        disabled={!injectText.trim() || (!isRunning && !isPaused)}
                      >
                        <Send className="h-3 w-3" />
                        Inject
                      </Button>
                      {isRunning ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 text-xs h-7"
                          onClick={onPause}
                        >
                          <Pause className="h-3 w-3" />
                          Pause
                        </Button>
                      ) : isPaused ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 text-xs h-7"
                          onClick={onResume}
                        >
                          <Play className="h-3 w-3" />
                          Resume
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>

                <Separator className="opacity-50" />

                {/* Quick actions */}
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Quick Actions
                  </label>
                  <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-[10px] h-7"
                      onClick={() => onInject("[MODERATOR] 请各位就对方的核心论点进行反驳或交叉辩论。")}
                      disabled={!isRunning && !isPaused}
                    >
                      <MessageCircle className="h-3 w-3" />
                      Cross-debate
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-[10px] h-7"
                      onClick={() => onInject("[MODERATOR] 请找出你们之间的共同点和共识区域。")}
                      disabled={!isRunning && !isPaused}
                    >
                      <Handshake className="h-3 w-3" />
                      Consensus
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-[10px] h-7"
                      onClick={() => onInject("[MODERATOR] 请总结到目前为止的讨论要点。")}
                      disabled={!isRunning && !isPaused}
                    >
                      <FileText className="h-3 w-3" />
                      Summarize
                    </Button>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="w-full mt-2 gap-1.5 text-xs h-7"
                    onClick={onStop}
                    disabled={!isRunning && !isPaused}
                  >
                    <Square className="h-3 w-3" />
                    Stop (force)
                  </Button>
                </div>
              </>
            )}

            {/* Summary (when ended) */}
            {summary && (
              <>
                <Separator className="opacity-50" />
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    总结
                  </label>
                  <div className="mt-1.5 rounded-lg bg-muted/50 p-2.5 text-[11px] leading-relaxed">
                    {summary}
                  </div>
                  <Button
                    variant="outline"
                    className="w-full mt-2 gap-2"
                    size="sm"
                    onClick={onReset}
                  >
                    重新开始
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* Creator dialogs */}
      <PersonaCreator
        open={personaCreatorOpen}
        onOpenChange={setPersonaCreatorOpen}
        onSave={onUpdatePersona}
        onGenerate={(prompt) => onGenerateContent("persona", prompt)}
        isGenerating={isGenerating}
        generatedContent={generatedContent?.target === "persona" ? generatedContent.content : null}
        onClearGenerated={onClearGenerated}
        editName={editPersonaName}
        editContent={editPersonaContent}
      />
      <ScenarioCreator
        open={scenarioCreatorOpen}
        onOpenChange={setScenarioCreatorOpen}
        onSave={onUpdateScenario}
        onGenerate={(prompt) => onGenerateContent("scenario", prompt)}
        isGenerating={isGenerating}
        generatedContent={generatedContent?.target === "scenario" ? generatedContent.content : null}
        onClearGenerated={onClearGenerated}
        editName={editScenarioName}
        editContent={editScenarioContent}
      />
    </div>
  );
}
