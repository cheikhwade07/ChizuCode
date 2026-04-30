"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { IngestionProgress } from "@/components/GraphViewer/IngestionProgress";
import { ingestRepo, pollRepoStatus, checkRepoReady } from "@/components/GraphViewer/adapter";

const submaps = [
  {
    name: "login",
    files: [
      {
        fileName: "authController.js",
        directory: "/src/controllers/authController.js",
        functionality:
            "Handles user login requests, validates input, and returns authentication responses",
        connection: ["userService.js", "tokenUtil.js"],
      },
      {
        fileName: "userService.js",
        directory: "/src/services/userService.js",
        functionality:
            "Fetches user data from database and verifies credentials",
        connection: ["authController.js", "database.js"],
      },
    ],
  },
  {
    name: "payment",
    files: [
      {
        fileName: "paymentController.js",
        directory: "/src/controllers/paymentController.js",
        functionality:
            "Processes payment requests and handles payment responses",
        connection: ["paymentService.js", "orderService.js"],
      },
      {
        fileName: "paymentService.js",
        directory: "/src/services/paymentService.js",
        functionality:
            "Integrates with external payment gateway and executes transactions",
        connection: ["paymentController.js", "gatewayClient.js"],
      },
    ],
  },
];

const learners = [
  "New developers joining a codebase",
  "Students studying project architecture",
  "Mentors explaining repo structure",
  "Teams documenting domain boundaries",
];

type IngestPhase =
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "polling"; repoId: string; chunkCount: number }
    | { kind: "error"; message: string };

export default function Home() {
  const router = useRouter();
  const [showHeader, setShowHeader] = useState(true);
  const [repoInput, setRepoInput] = useState("");
  const [inputError, setInputError] = useState("");
  const [phase, setPhase] = useState<IngestPhase>({ kind: "idle" });

  const totalFiles = submaps.reduce(
      (count, submap) => count + submap.files.length,
      0
  );

  function validate(value: string): string | null {
    if (!value) return "Enter a GitHub repository link before analyzing.";
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return "Enter a valid GitHub repository link.";
    }
    if (!["github.com", "www.github.com"].includes(url.hostname))
      return "Only GitHub repository links are supported.";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2)
      return "Use a full repository link like github.com/owner/repo.";
    const last = parts[parts.length - 1].toLowerCase();
    const cleanLast = last.endsWith(".git") ? last.slice(0, -4) : last;
    const fileExtensions = [".js", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs", ".java"];
    if (fileExtensions.some((ext) => cleanLast.endsWith(ext)))
      return "Wrong file type. Use a repository link like github.com/owner/repo.";
    return null;
  }

  const handleAnalyze = async () => {
    const value = repoInput.trim();
    const err = validate(value);
    if (err) { setInputError(err); return; }
    setInputError("");
    setPhase({ kind: "submitting" });

    try {
      const { repo_id } = await ingestRepo(value);
      localStorage.setItem("chizu_repo_id", repo_id);

      const alreadyReady = await checkRepoReady(repo_id);
      if (alreadyReady) {
        router.push("/graph");
        return;
      }

      setPhase({ kind: "polling", repoId: repo_id, chunkCount: 0 });
      await pollRepoStatus(repo_id, (status) =>
          setPhase({ kind: "polling", repoId: repo_id, chunkCount: status.chunk_count })
      );
      router.push("/graph");

    } catch (e: any) {
      setPhase({ kind: "error", message: e.message ?? "Something went wrong." });
    }
  };

  const handleScroll = useEffectEvent(() => {
    const currentY = window.scrollY;
    setShowHeader((prev) => {
      const lastY =
          Number(document.documentElement.dataset.lastScrollY ?? "0") || 0;
      const next = currentY < 24 || currentY < lastY;
      document.documentElement.dataset.lastScrollY = String(currentY);
      return prev === next ? prev : next;
    });
  });

  useEffect(() => {
    document.documentElement.dataset.lastScrollY = "0";
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      delete document.documentElement.dataset.lastScrollY;
    };
  }, []);

  const isLoading = phase.kind === "submitting" || phase.kind === "polling";

  return (
      <main className="min-h-screen bg-[#F3EEEA] text-[#433b33]">

        {/* Full-screen ingestion overlay */}
        {(phase.kind === "polling" || phase.kind === "submitting") && (
            <IngestionProgress
                chunkCount={phase.kind === "polling" ? phase.chunkCount : 0}
                repoName={repoInput.trim().replace("https://github.com/", "")}
            />
        )}

        {/* Header */}
        <header
            className={`fixed inset-x-0 top-0 z-50 bg-[#F3EEEA]/92 backdrop-blur transition-transform duration-300 ${
                showHeader ? "translate-y-0" : "-translate-y-full"
            }`}
        >
          <div className="mx-auto flex h-24 w-full max-w-[1600px] items-center justify-between px-6 sm:px-10 lg:px-14">
            <div className="flex flex-col">
            <span className="text-[2.4rem] font-semibold tracking-[-0.07em] sm:text-[2.7rem]">
              ChizuCode
            </span>
              <span className="text-sm uppercase tracking-[0.22em] text-[#776B5D]">
              Codebase Teaching Assistant
            </span>
            </div>
            <span className="rounded-full border border-[#B0A695] bg-[#DDD4C7] px-4 py-2 text-sm font-medium text-[#221d18] shadow-[6px_6px_0_#000]">
            Teaching Assistant for Repos
          </span>
          </div>
        </header>

        <div className="mx-auto flex w-full max-w-[1600px] flex-col px-6 pb-10 pt-28 sm:px-10 sm:pb-14 sm:pt-30 lg:px-14 lg:pb-14 lg:pt-32">
          {/* Hero */}
          <section className="flex min-h-[calc(100vh-8rem)] items-center border-b border-[#B0A695] pb-12">
            <div className="mx-auto flex max-w-5xl flex-col items-center text-center">
              <div className="inline-flex rounded-full border border-[#B0A695] bg-[#EBE3D5] px-4 py-2 text-sm font-medium text-[#5e554c]">
                Learn a codebase before reading every file
              </div>
              <h1 className="mt-5 max-w-4xl text-5xl font-semibold leading-[0.95] tracking-[-0.07em] text-[#433b33] sm:text-6xl lg:text-[5.4rem]">
                ChizuCode teaches your codebase back to you.
              </h1>
              <p className="mt-6 max-w-4xl text-xl leading-9 text-[#776B5D] sm:text-2xl">
                Explore repositories through guided submaps, file roles, and
                connection hints. ChizuCode acts like a teaching assistant that
                explains how a module works before you dive into the
                implementation.
              </p>
              <p className="mt-8 text-lg text-[#776B5D] sm:text-xl">
                Supports any language.
              </p>

              {/* Input row */}
              <div className="mt-5 w-full max-w-4xl">
                <div className="flex flex-col gap-4 sm:flex-row">
                  <label className="flex min-h-16 flex-1 items-center gap-4 rounded-2xl border-[2px] border-[#B0A695] bg-white px-5 shadow-[6px_6px_0_#000]">
                    <span className="text-2xl text-[#776B5D]">○</span>
                    <input
                        type="text"
                        value={repoInput}
                        disabled={isLoading}
                        onChange={(e) => {
                          setRepoInput(e.target.value);
                          if (inputError) setInputError("");
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !isLoading) handleAnalyze();
                        }}
                        placeholder="https://github.com/owner/repo"
                        className="w-full bg-transparent text-xl text-[#433b33] outline-none placeholder:text-[#776B5D]/70 disabled:opacity-50"
                    />
                  </label>
                  <button
                      type="button"
                      onClick={handleAnalyze}
                      disabled={isLoading}
                      className="min-h-16 rounded-2xl border-[2px] border-[#B0A695] bg-[#DDD4C7] px-8 text-xl font-semibold text-[#221d18] shadow-[6px_6px_0_#000] sm:min-w-52 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {isLoading ? "Working…" : "Analyze"}
                  </button>
                </div>

                {/* Error / validation line */}
                <p
                    className={`mt-3 text-left text-sm ${
                        phase.kind === "error" || inputError
                            ? "text-[#b42318]"
                            : "text-transparent"
                    }`}
                >
                  {phase.kind === "error"
                      ? phase.message
                      : inputError || "Validation message placeholder"}
                </p>
              </div>

              <a
                  href="#submaps"
                  className="mt-6 inline-flex items-center justify-center rounded-2xl border-[2px] border-[#B0A695] bg-[#DDD4C7] px-8 py-4 text-lg font-semibold text-[#221d18] shadow-[6px_6px_0_#000] sm:text-xl"
              >
                Explore more
              </a>
            </div>
          </section>

          {/* Overview cards */}
          <section
              id="overview-cards"
              className="scroll-mt-52 grid gap-8 pt-28 pb-20 lg:grid-cols-3"
          >
            <div className="overflow-hidden rounded-[1.8rem] border-[2px] border-[#B0A695] bg-[#F3EEEA] shadow-[8px_8px_0_#000]">
              <div className="bg-[#EBE3D5] px-5 py-4 font-mono text-[1.75rem] text-[#433b33]">
                Who it helps
              </div>
              <div className="p-6 pt-5 space-y-3 text-lg text-[#776B5D]">
                {learners.map((item) => (
                    <p key={item}>{item}</p>
                ))}
              </div>
            </div>

            <div
                id="how-it-works"
                className="overflow-hidden rounded-[1.8rem] border-[2px] border-[#B0A695] bg-[#F3EEEA] shadow-[8px_8px_0_#000]"
            >
              <div className="bg-[#EBE3D5] px-5 py-4 font-mono text-[1.75rem] text-[#433b33]">
                How it works
              </div>
              <ol className="p-6 pt-5 space-y-4 text-lg text-[#776B5D]">
                <li>1. Break the repo into submaps like login or payment.</li>
                <li>2. Explain each file&apos;s purpose in plain English.</li>
                <li>3. Show connections so learners know what to read next.</li>
              </ol>
            </div>

            <div className="overflow-hidden rounded-[1.8rem] border-[2px] border-[#B0A695] bg-[#F3EEEA] shadow-[8px_8px_0_#000]">
              <div className="bg-[#EBE3D5] px-5 py-4 font-mono text-[1.75rem] text-[#433b33]">
                Current sample
              </div>
              <div className="p-6 pt-5 space-y-3 text-lg text-[#776B5D]">
                <p>{submaps.length} submaps loaded</p>
                <p>{totalFiles} files explained</p>
                <p>Connections surfaced for every file</p>
              </div>
            </div>
          </section>

          {/* Submaps */}
          <section
              id="submaps"
              className="scroll-mt-[42vh] border-t border-[#B0A695] pt-12"
          >
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 className="text-4xl font-semibold tracking-[-0.05em] text-[#433b33]">
                  Guided submaps
                </h2>
                <p className="mt-3 text-xl text-[#776B5D]">
                  Each submap is presented like a lesson: what it is, which files
                  matter, and how they connect.
                </p>
              </div>
              <div className="flex gap-4">
                <div className="rounded-2xl border-[2px] border-[#B0A695] bg-[#DDD4C7] px-5 py-3 text-[#221d18] shadow-[6px_6px_0_#000]">
                  {submaps.length} maps
                </div>
                <div className="rounded-2xl border-[2px] border-[#B0A695] bg-[#DDD4C7] px-5 py-3 text-[#221d18] shadow-[6px_6px_0_#000]">
                  {totalFiles} files
                </div>
              </div>
            </div>

            <div className="mt-8 grid gap-6 xl:grid-cols-2">
              {submaps.map((submap) => (
                  <article
                      key={submap.name}
                      className="overflow-hidden rounded-[1.8rem] border-[2px] border-[#B0A695] bg-[#F3EEEA] shadow-[8px_8px_0_#000]"
                  >
                    <div className="bg-[#EBE3D5] px-5 py-4 font-mono text-[1.75rem] capitalize text-[#433b33]">
                      {submap.name}
                    </div>
                    <div className="space-y-5 p-6">
                      {submap.files.map((file) => (
                          <div
                              key={file.directory}
                              className="rounded-2xl border border-[#B0A695] bg-[#EBE3D5] p-5"
                          >
                            <h3 className="text-[1.65rem] font-semibold leading-tight text-[#433b33]">
                              {file.fileName}
                            </h3>
                            <p className="mt-2 font-mono text-sm text-[#776B5D]">
                              {file.directory}
                            </p>
                            <p className="mt-4 text-lg leading-8 text-[#776B5D]">
                              {file.functionality}
                            </p>
                            <div className="mt-4">
                              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#776B5D]">
                                Connected to
                              </p>
                              <div className="mt-3 flex flex-wrap gap-2">
                                {file.connection.map((item) => (
                                    <span
                                        key={item}
                                        className="rounded-full border border-[#B0A695] bg-[#F3EEEA] px-3 py-1.5 text-sm text-[#433b33]"
                                    >
                              {item}
                            </span>
                                ))}
                              </div>
                            </div>
                          </div>
                      ))}
                    </div>
                  </article>
              ))}
            </div>
          </section>
        </div>
      </main>
  );
}