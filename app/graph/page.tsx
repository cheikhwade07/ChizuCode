"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { GraphViewer } from "@/components/GraphViewer";

export default function GraphPage() {
  const router = useRouter();
  const [repoId, setRepoId] = useState<string | null>(null);

  useEffect(() => {
    const id = localStorage.getItem("chizu_repo_id");
    if (!id) {
      router.replace("/");
      return;
    }
    setRepoId(id);
  }, [router]);

  if (!repoId) {
    return (
        <main className="w-full h-screen bg-[#F3EEEA] flex items-center justify-center">
          <p className="text-[#776B5D] text-lg animate-pulse">Loading…</p>
        </main>
    );
  }

  return (
      <main className="w-full h-screen overflow-hidden">
        <GraphViewer repoId={repoId} />
      </main>
  );
}