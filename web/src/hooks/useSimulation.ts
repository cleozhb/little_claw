"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { wsClient } from "@/lib/websocket";
import type { ServerMessage, ArgumentNode } from "@/types/protocol";

// ---- Domain types ----

export interface PersonaInfo {
  name: string;
  role: string;
  emoji: string;
  content: string;
}

export interface ScenarioInfo {
  name: string;
  description: string;
  mode: string;
  personas?: {
    required: string[];
    optional: string[];
    max?: number;
  };
  content: string;
}

export type PersonaStatus = "waiting" | "speaking" | "done";

export interface PersonaState {
  name: string;
  emoji: string;
  role: string;
  status: PersonaStatus;
  thinking: string;
}

export interface TranscriptEntry {
  id: string;
  persona: string;
  emoji: string;
  text: string;
  isStreaming: boolean;
  round: number;
  /** For moderator inject messages */
  isModerator?: boolean;
  /** For user (You) messages */
  isUser?: boolean;
  /** First argument topic introduced in this entry (for scroll-to linking) */
  argumentTopic?: string;
  /** Waiting divider between rounds */
  isWaiting?: boolean;
}

export type SimStatus = "idle" | "running" | "paused" | "waiting" | "ended";

let entryCounter = 0;
function nextEntryId(): string {
  return `sim_${Date.now()}_${++entryCounter}`;
}

export function useSimulation() {
  // ---- Lists ----
  const [personas, setPersonas] = useState<PersonaInfo[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);

  // ---- Active simulation state ----
  const [simId, setSimId] = useState<string | null>(null);
  const [simStatus, setSimStatus] = useState<SimStatus>("idle");
  const [currentRound, setCurrentRound] = useState(0);
  const [totalRounds, setTotalRounds] = useState(0);
  const [scenarioName, setScenarioName] = useState("");
  const [scenarioMode, setScenarioMode] = useState("");

  // ---- Persona states ----
  const [personaStates, setPersonaStates] = useState<Map<string, PersonaState>>(new Map());

  // ---- Transcript & arguments ----
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [argumentNodes, setArgumentNodes] = useState<ArgumentNode[]>([]);
  const [newArgumentTopics, setNewArgumentTopics] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<string>("");

  // ---- AI generation ----
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedContent, setGeneratedContent] = useState<{ target: "persona" | "scenario"; content: string } | null>(null);

  const simIdRef = useRef(simId);
  simIdRef.current = simId;

  // ---- Handle incoming server messages ----
  useEffect(() => {
    const unsub = wsClient.onMessage((msg: ServerMessage) => {
      switch (msg.type) {
        case "personas_list":
          setPersonas(msg.personas);
          break;

        case "scenarios_list":
          setScenarios(msg.scenarios);
          break;

        case "simulation_event": {
          if (simIdRef.current && msg.simId !== simIdRef.current) return;
          const evt = msg.event;

          switch (evt.type) {
            case "sim_start": {
              const names = evt.personas as string[];
              setSimId(msg.simId);
              setSimStatus("running");
              setScenarioName(evt.scenario as string);
              setCurrentRound(0);
              setSummary("");
              setTranscript([]);
              setArgumentNodes([]);
              // Initialize persona states
              const states = new Map<string, PersonaState>();
              for (const name of names) {
                const info = personas.find((p) => p.name === name);
                states.set(name, {
                  name,
                  emoji: info?.emoji ?? "🤖",
                  role: info?.role ?? "",
                  status: "waiting",
                  thinking: "",
                });
              }
              setPersonaStates(states);
              break;
            }

            case "round_start": {
              const round = evt.round as number;
              setCurrentRound(round);
              setSimStatus("running");
              // Reset all persona states to waiting
              setPersonaStates((prev) => {
                const next = new Map(prev);
                for (const [k, v] of next) {
                  next.set(k, { ...v, status: "waiting", thinking: "" });
                }
                return next;
              });
              // Add round banner to transcript
              setTranscript((prev) => [
                ...prev,
                {
                  id: nextEntryId(),
                  persona: "__round__",
                  emoji: "",
                  text: `第 ${round} 轮`,
                  isStreaming: false,
                  round,
                },
              ]);
              break;
            }

            case "persona_start": {
              const persona = evt.persona as string;
              const emoji = evt.emoji as string;
              setPersonaStates((prev) => {
                const next = new Map(prev);
                const existing = next.get(persona);
                if (existing) {
                  next.set(persona, { ...existing, status: "speaking", emoji });
                }
                return next;
              });
              // Create a new transcript entry for streaming
              setTranscript((prev) => [
                ...prev,
                {
                  id: nextEntryId(),
                  persona,
                  emoji,
                  text: "",
                  isStreaming: true,
                  round: currentRound,
                },
              ]);
              break;
            }

            case "persona_text_delta": {
              const persona = evt.persona as string;
              const text = evt.text as string;
              setTranscript((prev) => {
                // Find last entry for this persona that's streaming
                for (let i = prev.length - 1; i >= 0; i--) {
                  if (prev[i].persona === persona && prev[i].isStreaming) {
                    const updated = { ...prev[i], text: prev[i].text + text };
                    return [...prev.slice(0, i), updated, ...prev.slice(i + 1)];
                  }
                }
                return prev;
              });
              break;
            }

            case "persona_thinking": {
              const persona = evt.persona as string;
              const thinking = evt.thinking as string;
              setPersonaStates((prev) => {
                const next = new Map(prev);
                const existing = next.get(persona);
                if (existing) {
                  next.set(persona, { ...existing, thinking });
                }
                return next;
              });
              break;
            }

            case "persona_done": {
              const persona = evt.persona as string;
              setPersonaStates((prev) => {
                const next = new Map(prev);
                const existing = next.get(persona);
                if (existing) {
                  next.set(persona, { ...existing, status: "done" });
                }
                return next;
              });
              // Mark streaming as done
              setTranscript((prev) => {
                for (let i = prev.length - 1; i >= 0; i--) {
                  if (prev[i].persona === persona && prev[i].isStreaming) {
                    const updated = { ...prev[i], isStreaming: false };
                    return [...prev.slice(0, i), updated, ...prev.slice(i + 1)];
                  }
                }
                return prev;
              });
              break;
            }

            case "round_end":
              break;

            case "round_end_waiting": {
              const waitRound = evt.round as number;
              setSimStatus("waiting");
              // Add waiting divider to transcript
              setTranscript((prev) => [
                ...prev,
                {
                  id: nextEntryId(),
                  persona: "__waiting__",
                  emoji: "",
                  text: `Round ${waitRound} complete — waiting for your decision...`,
                  isStreaming: false,
                  round: waitRound,
                  isWaiting: true,
                },
              ]);
              break;
            }

            case "user_spoke": {
              const content = evt.content as string;
              // Add user message to transcript
              setTranscript((prev) => [
                ...prev,
                {
                  id: nextEntryId(),
                  persona: "You",
                  emoji: "🧑",
                  text: content,
                  isStreaming: false,
                  round: currentRound,
                  isUser: true,
                },
              ]);
              setSimStatus("running");
              break;
            }

            case "argument_update": {
              const args = evt.arguments as ArgumentNode[];
              // Determine newly appeared topics
              setArgumentNodes((prev) => {
                const oldTopics = new Set(prev.map((a) => a.topic));
                const newTopics = new Set<string>();
                for (const arg of args) {
                  if (!oldTopics.has(arg.topic)) {
                    newTopics.add(arg.topic);
                  }
                }
                if (newTopics.size > 0) {
                  setNewArgumentTopics(newTopics);
                  // Clear highlight after 2 seconds
                  setTimeout(() => setNewArgumentTopics(new Set()), 2000);
                }
                return args;
              });
              break;
            }

            case "world_state_update":
              // Could be displayed in control panel
              break;

            case "sim_end": {
              setSimStatus("ended");
              setSummary(evt.summary as string);
              break;
            }
          }
          break;
        }

        case "persona_updated":
          // Refresh persona list
          wsClient.send({ type: "list_personas" });
          break;

        case "scenario_updated":
          // Refresh scenario list
          wsClient.send({ type: "list_scenarios" });
          break;

        case "generated_content":
          setIsGenerating(false);
          setGeneratedContent({ target: msg.target, content: msg.content });
          break;
      }
    });

    return unsub;
  }, [personas, currentRound]);

  // ---- Actions ----

  const listPersonas = useCallback(() => {
    wsClient.send({ type: "list_personas" });
  }, []);

  const listScenarios = useCallback(() => {
    wsClient.send({ type: "list_scenarios" });
  }, []);

  const startSimulation = useCallback(
    (scenarioName: string, personaNames: string[], rounds?: number, mode?: string) => {
      setSimStatus("running");
      setTranscript([]);
      setArgumentNodes([]);
      setSummary("");
      setScenarioName(scenarioName);
      if (mode) setScenarioMode(mode);
      if (rounds) setTotalRounds(rounds);
      wsClient.send({
        type: "start_simulation",
        scenarioName,
        personaNames,
        rounds,
        mode,
      });
    },
    [],
  );

  const inject = useCallback(
    (content: string) => {
      if (!simId) return;
      // Add moderator message to transcript
      setTranscript((prev) => [
        ...prev,
        {
          id: nextEntryId(),
          persona: "Moderator",
          emoji: "🎙️",
          text: content,
          isStreaming: false,
          round: currentRound,
          isModerator: true,
        },
      ]);
      wsClient.send({ type: "sim_inject", simId, content });
    },
    [simId, currentRound],
  );

  const pause = useCallback(() => {
    if (!simId) return;
    setSimStatus("paused");
    wsClient.send({ type: "sim_pause", simId });
  }, [simId]);

  const resume = useCallback(() => {
    if (!simId) return;
    setSimStatus("running");
    wsClient.send({ type: "sim_resume", simId });
  }, [simId]);

  const stop = useCallback(() => {
    if (!simId) return;
    wsClient.send({ type: "sim_stop", simId });
  }, [simId]);

  const nextRound = useCallback(() => {
    if (!simId) return;
    setSimStatus("running");
    // Remove the waiting divider
    setTranscript((prev) => prev.filter((e) => !e.isWaiting));
    wsClient.send({ type: "sim_next_round", simId });
  }, [simId]);

  const speakThenNextRound = useCallback(
    (content: string) => {
      if (!simId) return;
      // Remove the waiting divider
      setTranscript((prev) => prev.filter((e) => !e.isWaiting));
      wsClient.send({ type: "sim_speak", simId, content });
    },
    [simId],
  );

  const endDiscussion = useCallback(() => {
    if (!simId) return;
    setSimStatus("running");
    // Remove the waiting divider
    setTranscript((prev) => prev.filter((e) => !e.isWaiting));
    wsClient.send({ type: "sim_end", simId });
  }, [simId]);

  const updatePersona = useCallback((name: string, content: string) => {
    wsClient.send({ type: "update_persona", name, content });
  }, []);

  const updateScenario = useCallback((name: string, content: string) => {
    wsClient.send({ type: "update_scenario", name, content });
  }, []);

  const generateContent = useCallback((target: "persona" | "scenario", prompt: string) => {
    setIsGenerating(true);
    setGeneratedContent(null);
    wsClient.send({ type: "generate_content", target, prompt });
  }, []);

  const clearGeneratedContent = useCallback(() => {
    setGeneratedContent(null);
  }, []);

  const reset = useCallback(() => {
    setSimId(null);
    setSimStatus("idle");
    setCurrentRound(0);
    setTotalRounds(0);
    setScenarioName("");
    setScenarioMode("");
    setPersonaStates(new Map());
    setTranscript([]);
    setArgumentNodes([]);
    setNewArgumentTopics(new Set());
    setSummary("");
  }, []);

  return {
    // Lists
    personas,
    scenarios,
    listPersonas,
    listScenarios,

    // Simulation state
    simId,
    simStatus,
    currentRound,
    totalRounds,
    scenarioName,
    scenarioMode,

    // Persona states
    personaStates,

    // Transcript & arguments
    transcript,
    argumentNodes,
    newArgumentTopics,
    summary,

    // Actions
    startSimulation,
    inject,
    pause,
    resume,
    stop,
    nextRound,
    speakThenNextRound,
    endDiscussion,
    updatePersona,
    updateScenario,
    generateContent,
    clearGeneratedContent,
    isGenerating,
    generatedContent,
    reset,
  };
}
