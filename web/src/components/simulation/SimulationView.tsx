"use client";

import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConnectionStatus } from "@/lib/websocket";
import { useSimulation } from "@/hooks/useSimulation";
import { ArgumentMap } from "./ArgumentMap";
import { DiscussionPanel } from "./DiscussionPanel";
import { ControlPanel } from "./ControlPanel";

interface SimulationViewProps {
  onBackToChat?: () => void;
}

export function SimulationView({ onBackToChat }: SimulationViewProps) {
  const connectionStatus = useConnectionStatus();
  const sim = useSimulation();

  // Ref map for scroll-to-argument linking
  const entryRefMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const [highlightEntryId, setHighlightEntryId] = useState<string | null>(null);

  // Fetch personas, scenarios, and skills when connected
  useEffect(() => {
    if (connectionStatus === "connected") {
      sim.listPersonas();
      sim.listScenarios();
      sim.listSimulationSkills();
    }
  }, [connectionStatus, sim.listPersonas, sim.listScenarios, sim.listSimulationSkills]);

  // Handle argument card click -> scroll to first mention in transcript
  const handleArgumentClick = useCallback(
    (topic: string) => {
      // Find the first transcript entry that mentions this topic
      const entry = sim.transcript.find(
        (e) => e.persona !== "__round__" && e.text.includes(topic),
      );
      if (entry) {
        setHighlightEntryId(entry.id);
        // Clear highlight after 2 seconds
        setTimeout(() => setHighlightEntryId(null), 2000);
      }
    },
    [sim.transcript],
  );

  // Build persona name -> emoji map from personaStates
  const personaEmojis = useMemo(() => {
    const map = new Map<string, string>();
    for (const [name, state] of sim.personaStates) {
      map.set(name, state.emoji);
    }
    return map;
  }, [sim.personaStates]);

  return (
    <div className="flex h-full flex-col">
      {/* Top bar with back-to-chat button */}
      <div className="shrink-0 flex items-center gap-2 border-b border-border/50 px-3 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-xs h-7 text-muted-foreground hover:text-foreground"
          onClick={onBackToChat}
        >
          <MessageCircle className="h-3.5 w-3.5" />
          Chat
        </Button>
      </div>

      {/* Three-column layout */}
      <div className="flex flex-1 min-h-0">
      {/* Left column — Argument Map */}
      <aside className="w-[280px] shrink-0 border-r border-border/50 bg-card/50">
        <ArgumentMap
          arguments={sim.argumentNodes}
          newTopics={sim.newArgumentTopics}
          onArgumentClick={handleArgumentClick}
          personaEmojis={personaEmojis}
        />
      </aside>

      {/* Center column — Discussion Transcript */}
      <main className="flex-1 min-w-0 bg-background">
        <DiscussionPanel
          transcript={sim.transcript}
          entryRefMap={entryRefMap}
          highlightEntryId={highlightEntryId}
          scenarioName={sim.scenarioName}
        />
      </main>

      {/* Right column — Control Panel */}
      <aside className="w-[280px] shrink-0 border-l border-border/50 bg-card/50">
        <ControlPanel
          personas={sim.personas}
          scenarios={sim.scenarios}
          simulationSkills={sim.simulationSkills}
          simStatus={sim.simStatus}
          scenarioName={sim.scenarioName}
          scenarioMode={sim.scenarioMode}
          currentRound={sim.currentRound}
          totalRounds={sim.totalRounds}
          personaStates={sim.personaStates}
          summary={sim.summary}
          isGenerating={sim.isGenerating}
          generatedContent={sim.generatedContent}
          onStart={sim.startSimulation}
          onInject={sim.inject}
          onPause={sim.pause}
          onResume={sim.resume}
          onStop={sim.stop}
          onNextRound={sim.nextRound}
          onSpeakThenNextRound={sim.speakThenNextRound}
          onEndDiscussion={sim.endDiscussion}
          onUpdatePersona={sim.updatePersona}
          onUpdateScenario={sim.updateScenario}
          onGenerateContent={sim.generateContent}
          onClearGenerated={sim.clearGeneratedContent}
          onReset={sim.reset}
        />
      </aside>
      </div>
    </div>
  );
}
