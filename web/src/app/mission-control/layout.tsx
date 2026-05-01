import {
  MissionControlFrame,
  MissionControlProvider,
} from "@/components/mission-control/MissionControl";

export default function MissionControlLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <MissionControlProvider>
      <MissionControlFrame>{children}</MissionControlFrame>
    </MissionControlProvider>
  );
}
