"use client";

import { useEffect, useEffectEvent, useState, type SVGProps } from "react";
import { useRouter } from "next/navigation";
import { IngestionProgress } from "@/components/GraphViewer/IngestionProgress";
import { ApiError, getRepoQuota, ingestRepo, pollRepoStatus, type RepoQuota } from "@/components/GraphViewer/adapter";

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

const projectLinks = [
  {
    name: "GitHub",
    href: "https://github.com/cheikhwade07/ChizuCode",
    Icon: GithubLogo,
  },
  {
    name: "Devpost",
    href: "https://devpost.com/software/chizucode",
    Icon: DevpostLogo,
  },
];

type IngestPhase =
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "polling"; repoId: string; chunkCount: number }
    | { kind: "error"; message: string; status?: number };

function GithubLogo(props: SVGProps<SVGSVGElement>) {
  return (
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" {...props}>
        <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M12 0.75C5.79 0.75 0.75 5.79 0.75 12c0 4.97 3.22 9.18 7.69 10.67 0.56 0.1 0.77-0.24 0.77-0.54 0-0.27-0.01-1.15-0.02-2.09-3.13 0.68-3.79-1.33-3.79-1.33-0.51-1.3-1.25-1.65-1.25-1.65-1.02-0.7 0.08-0.69 0.08-0.69 1.13 0.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27 0.94 0.1-0.73 0.39-1.22 0.71-1.5-2.5-0.28-5.13-1.25-5.13-5.56 0-1.23 0.44-2.23 1.16-3.02-0.12-0.28-0.5-1.43 0.11-2.98 0 0 0.94-0.3 3.09 1.15A10.74 10.74 0 0 1 12 6.18c0.95 0 1.91 0.13 2.81 0.38 2.14-1.45 3.08-1.15 3.08-1.15 0.61 1.55 0.23 2.7 0.11 2.98 0.72 0.79 1.16 1.79 1.16 3.02 0 4.32-2.64 5.27-5.15 5.55 0.4 0.35 0.76 1.03 0.76 2.08 0 1.5-0.01 2.71-0.01 3.08 0 0.3 0.2 0.65 0.78 0.54A11.26 11.26 0 0 0 23.25 12C23.25 5.79 18.21 0.75 12 0.75Z"
        />
      </svg>
  );
}

function DevpostLogo(props: SVGProps<SVGSVGElement>) {
  return (
      <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
        <rect x="3" y="3" width="18" height="18" rx="3.5" fill="currentColor" />
        <path
            d="M8 7h4.25C15.12 7 17 9.02 17 12s-1.88 5-4.75 5H8V7Zm2.55 2.35v5.3h1.54c1.43 0 2.35-1.04 2.35-2.65s-0.92-2.65-2.35-2.65H10.55Z"
            fill="#F3EEEA"
        />
      </svg>
  );
}

export default function Home() {
  const router = useRouter();
  const [showHeader, setShowHeader] = useState(true);
  const [repoInput, setRepoInput] = useState("");
  const [inputError, setInputError] = useState("");
  const [phase, setPhase] = useState<IngestPhase>({ kind: "idle" });
  const [quota, setQuota] = useState<RepoQuota | null>(null);

  const totalFiles = submaps.reduce(
      (count, submap) => count + submap.files.length,
      0
  );

  function validate(value: string): string | null {
    if (!value) return "Enter a GitHub repository link before analyzing.";
    let url: URL;
    try {
      url = new URL(value.includes("://") ? value : `https://${value}`);
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
      void getRepoQuota().then(setQuota).catch(() => {});

      setPhase({ kind: "polling", repoId: repo_id, chunkCount: 0 });
      await pollRepoStatus(repo_id, (status) =>
          setPhase({ kind: "polling", repoId: repo_id, chunkCount: status.chunk_count })
      );
      router.push("/graph");

    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 429) {
        setPhase({
          kind: "error",
          status: 429,
          message: e.message || "Daily limit reached. Try again tomorrow.",
        });
        void getRepoQuota().then(setQuota).catch(() => {});
        return;
      }
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : "Something went wrong.",
      });
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

  useEffect(() => {
    let cancelled = false;
    getRepoQuota()
        .then((nextQuota) => {
          if (!cancelled) setQuota(nextQuota);
        })
        .catch(() => {
          if (!cancelled) setQuota(null);
        });
    return () => {
      cancelled = true;
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
            <nav className="flex items-center gap-3" aria-label="Project links">
              {projectLinks.map(({ name, href, Icon }) => (
                  <a
                      key={name}
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`${name} project page`}
                      title={name}
                      className="inline-flex h-12 items-center gap-2 rounded-full border border-[#B0A695] bg-[#DDD4C7] px-4 text-sm font-semibold text-[#221d18] shadow-[6px_6px_0_#000] transition-transform hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#433b33]"
                  >
                    <Icon className="h-5 w-5 shrink-0" />
                    <span className="hidden sm:inline">{name}</span>
                  </a>
              ))}
            </nav>
          </div>
        </header>

        <div className="mx-auto flex w-full max-w-[1600px] flex-col px-6 pb-10 pt-28 sm:px-10 sm:pb-14 sm:pt-30 lg:px-14 lg:pb-14 lg:pt-32">
          {/* Hero */}
          <section className="flex min-h-[calc(100vh-8rem)] items-center border-b border-[#B0A695] pb-12">
            <div className="mx-auto flex max-w-5xl flex-col items-center text-center">
              <h1 className="max-w-4xl text-5xl font-semibold leading-[0.95] tracking-[-0.07em] text-[#433b33] sm:text-6xl lg:text-[5.4rem]">
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
                {phase.kind === "error" && phase.status === 429 && (
                    <div className="mb-4 rounded-2xl border-[2px] border-[#9F5B4B] bg-[#F0D8CF] px-5 py-4 text-left text-[#6E2F24] shadow-[6px_6px_0_#000]">
                      <p className="text-base font-semibold">Daily ingestion limit reached</p>
                      <p className="mt-1 text-sm leading-6">{phase.message}</p>
                    </div>
                )}
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

                {quota && (
                    <p className="mt-3 text-left text-sm text-[#776B5D]">
                      {quota.used} of {quota.limit} repository ingestions used in the last 24 hours.
                    </p>
                )}

                {/* Error / validation line */}
                <p
                    className={`mt-3 text-left text-sm ${
                        (phase.kind === "error" && phase.status !== 429) || inputError
                            ? "text-[#b42318]"
                            : "text-transparent"
                    }`}
                >
                  {phase.kind === "error" && phase.status !== 429
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
              className="scroll-mt-52 grid gap-8 pt-28 pb-20 lg:grid-cols-2 xl:grid-cols-4"
          >
            <div className="overflow-hidden rounded-[1.8rem] border-[2px] border-[#B0A695] bg-[#F3EEEA] shadow-[8px_8px_0_#000]">
              <div className="bg-[#EBE3D5] px-5 py-4 font-mono text-[1.75rem] text-[#433b33]">
                About
              </div>
              <div className="p-6 pt-5 space-y-3 text-lg text-[#776B5D]">
                <p>ChizuCode turns repositories into guided maps for learning unfamiliar codebases.</p>
                <p>Winner of Best Use of Gemini API at ConHack 2026.</p>
              </div>
            </div>

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

          <footer className="mt-16 border-t border-[#B0A695] pt-8 text-sm leading-6 text-[#776B5D]">
            <p>Copyright (c) 2026 ChizuCode contributors.</p>
            <p className="mt-1">
              Team: Naseer Rehman, Seydi Cheikh Wade, Tri An, Tin Mainiawklang.
            </p>
            <p className="mt-1">
              Licensed under the{" "}
              <a
                  href="https://github.com/cheikhwade07/ChizuCode/blob/main/LICENSE"
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-[#433b33] underline underline-offset-4"
              >
                MIT License
              </a>
              .
            </p>
          </footer>
        </div>
      </main>
  );
}
