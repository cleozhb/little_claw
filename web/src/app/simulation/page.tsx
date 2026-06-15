"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { SimulationView } from "@/components/simulation/SimulationView";
import { wsClient } from "@/lib/websocket";

const WS_URL = process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://localhost:4000/ws";

export default function SimulationPage() {
  const router = useRouter();

  useEffect(() => {
    wsClient.connect(WS_URL);
    return () => wsClient.disconnect();
  }, []);

  return (
    <div className="h-screen overflow-hidden bg-background">
      <SimulationView onBackToChat={() => router.push("/chat")} />
    </div>
  );
}
