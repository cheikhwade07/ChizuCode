import { GraphViewer } from "@/components/GraphViewer";

export const metadata = {
  title: "Codebase Map — Graph Explorer",
  description: "Interactive graph view of your repository structure.",
};

export default function GraphPage() {
  return (
    <main className="w-full h-screen bg-slate-950 overflow-hidden">
      <GraphViewer />
    </main>
  );
}
