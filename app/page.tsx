"use client";

import { useEffect, useEffectEvent, useState } from "react";

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

const teachingPoints = [
  "Plain-English walkthroughs for each submap",
  "Connections between files shown as learning steps",
  "Fast onboarding for unfamiliar modules",
  "Clear file roles before you open the code",
];

const learners = [
  "New developers joining a codebase",
  "Students studying project architecture",
  "Mentors explaining repo structure",
  "Teams documenting domain boundaries",
];

export default function Home() {
  const [showHeader, setShowHeader] = useState(true);
  const totalFiles = submaps.reduce(
    (count, submap) => count + submap.files.length,
    0
  );

  const handleScroll = useEffectEvent(() => {
    const currentY = window.scrollY;

    setShowHeader((previousVisible) => {
      const lastY =
        Number(document.documentElement.dataset.lastScrollY ?? "0") || 0;
      const nextVisible = currentY < 24 || currentY < lastY;
      document.documentElement.dataset.lastScrollY = String(currentY);
      return previousVisible === nextVisible
        ? previousVisible
        : nextVisible;
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

  return (
    <main className="min-h-screen bg-[#F5EFE6] text-black">
      <header
        className={`fixed inset-x-0 top-0 z-50 bg-[#F5EFE6]/88 backdrop-blur transition-transform duration-300 ${
          showHeader ? "translate-y-0" : "-translate-y-full"
        }`}
      >
        <div className="mx-auto flex h-28 w-full max-w-[1600px] items-center justify-between px-6 sm:px-10 lg:px-14">
          <div className="flex flex-col">
            <span className="text-[2.4rem] font-semibold tracking-[-0.07em] sm:text-[2.7rem]">
              ChizuCode
            </span>
            <span className="text-sm uppercase tracking-[0.22em] text-black/65">
              Codebase Teaching Assistant
            </span>
          </div>
          <span className="rounded-full border border-black bg-[#F5EFE6] px-4 py-2 text-sm font-medium">
            Teaching Assistant for Repos
          </span>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1600px] flex-col px-6 pb-10 pt-36 sm:px-10 sm:pb-14 sm:pt-40 lg:px-14 lg:pb-14 lg:pt-44">
        <section className="grid gap-10 border-b border-black pb-12 lg:grid-cols-[1.3fr_0.9fr]">
          <div className="max-w-5xl">
            <div className="inline-flex rounded-full border border-black bg-[#CBDCEB] px-4 py-2 text-sm font-medium">
              Learn a codebase before reading every file
            </div>
            <h1 className="mt-6 text-6xl font-semibold tracking-[-0.07em] sm:text-7xl lg:text-[6.3rem]">
              ChizuCode
              <br />
              teaches your
              <br />
              codebase back to you.
            </h1>
            <p className="mt-8 max-w-4xl text-2xl leading-10 text-black/75">
              Explore repositories through guided submaps, file roles, and
              connection hints. ChizuCode acts like a teaching assistant that
              explains how a module works before you dive into the implementation.
            </p>
            <div className="mt-10 flex flex-col gap-4 sm:flex-row">
              <a
                href="#submaps"
                className="rounded-2xl border-[2px] border-black bg-[#CBDCEB] px-8 py-4 text-xl font-semibold shadow-[6px_6px_0_#000]"
              >
                Explore Sample Submaps
              </a>
              <a
                href="#how-it-works"
                className="rounded-2xl border-[2px] border-black bg-[#E8DFCA] px-8 py-4 text-xl font-semibold shadow-[6px_6px_0_#000]"
              >
                How It Teaches
              </a>
            </div>
          </div>

          <div className="rounded-[2rem] border-[2px] border-black bg-[#E8DFCA] p-7 shadow-[10px_10px_0_#000]">
            <h2 className="text-3xl font-semibold tracking-[-0.04em]">
              What ChizuCode does
            </h2>
            <div className="mt-6 space-y-4">
              {teachingPoints.map((point) => (
                <div
                  key={point}
                  className="rounded-2xl border border-black bg-[#F5EFE6] px-4 py-4 text-lg"
                >
                  {point}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="grid gap-8 py-12 lg:grid-cols-3">
          <div className="rounded-[1.8rem] border-[2px] border-black bg-[#F5EFE6] p-6 shadow-[8px_8px_0_#000]">
            <div className="bg-[#CBDCEB] px-4 py-3 font-mono text-[1.35rem]">
              Who it helps
            </div>
            <div className="mt-5 space-y-3 text-lg text-black/75">
              {learners.map((item) => (
                <p key={item}>{item}</p>
              ))}
            </div>
          </div>

          <div
            id="how-it-works"
            className="rounded-[1.8rem] border-[2px] border-black bg-[#F5EFE6] p-6 shadow-[8px_8px_0_#000]"
          >
            <div className="bg-[#E8DFCA] px-4 py-3 font-mono text-[1.35rem]">
              How it works
            </div>
            <ol className="mt-5 space-y-4 text-lg text-black/75">
              <li>1. Break the repo into submaps like login or payment.</li>
              <li>2. Explain each file’s purpose in plain English.</li>
              <li>3. Show connections so learners know what to read next.</li>
            </ol>
          </div>

          <div className="rounded-[1.8rem] border-[2px] border-black bg-[#F5EFE6] p-6 shadow-[8px_8px_0_#000]">
            <div className="bg-[#CBDCEB] px-4 py-3 font-mono text-[1.35rem]">
              Current sample
            </div>
            <div className="mt-5 space-y-3 text-lg text-black/75">
              <p>{submaps.length} submaps loaded</p>
              <p>{totalFiles} files explained</p>
              <p>Connections surfaced for every file</p>
            </div>
          </div>
        </section>

        <section id="submaps" className="border-t border-black pt-12">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-4xl font-semibold tracking-[-0.05em]">
                Guided submaps
              </h2>
              <p className="mt-3 text-xl text-black/75">
                Each submap is presented like a lesson: what it is, which files
                matter, and how they connect.
              </p>
            </div>
            <div className="flex gap-4">
              <div className="rounded-2xl border-[2px] border-black bg-[#CBDCEB] px-5 py-3 shadow-[6px_6px_0_#000]">
                {submaps.length} maps
              </div>
              <div className="rounded-2xl border-[2px] border-black bg-[#E8DFCA] px-5 py-3 shadow-[6px_6px_0_#000]">
                {totalFiles} files
              </div>
            </div>
          </div>

          <div className="mt-8 grid gap-6 xl:grid-cols-2">
            {submaps.map((submap, index) => (
              <article
                key={submap.name}
                className="overflow-hidden rounded-[1.8rem] border-[2px] border-black bg-[#F5EFE6] shadow-[8px_8px_0_#000]"
              >
                <div
                  className={`px-5 py-4 font-mono text-[1.75rem] capitalize ${
                    index % 2 === 0 ? "bg-[#CBDCEB]" : "bg-[#E8DFCA]"
                  }`}
                >
                  {submap.name}
                </div>
                <div className="space-y-5 p-6">
                  {submap.files.map((file) => (
                    <div
                      key={file.directory}
                      className="rounded-2xl border border-black bg-[#E8DFCA] p-5"
                    >
                      <h3 className="text-[1.65rem] font-semibold leading-tight">
                        {file.fileName}
                      </h3>
                      <p className="mt-2 font-mono text-sm text-black/70">
                        {file.directory}
                      </p>
                      <p className="mt-4 text-lg leading-8 text-black/75">
                        {file.functionality}
                      </p>

                      <div className="mt-4">
                        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-black/65">
                          Connected to
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {file.connection.map((item) => (
                            <span
                              key={item}
                              className="rounded-full border border-black bg-[#CBDCEB] px-3 py-1.5 text-sm"
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
