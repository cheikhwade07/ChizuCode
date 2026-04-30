/**
 * adapter.ts
 *
 * Converts the backend cluster tree (recursive Quanta structure)
 * into the flat submap schema the GraphViewer frontend expects.
 *
 * Backend schema (recursive):
 * {
 *   type: "cluster" | "leaf",
 *   label: string,
 *   summary: string,
 *   children: [...],
 *   edges: [{ from, to, label }],
 *   // leaf only:
 *   file_path: string,
 *   nodes: [{ id, label, responsibility }],
 * }
 *
 * Frontend schema (flat):
 * {
 *   submaps: [
 *     {
 *       name: string,
 *       files: [
 *         {
 *           fileName: string,
 *           directory: string,
 *           functionality: string,
 *           connection: string[],
 *         }
 *       ]
 *     }
 *   ]
 * }
 */

// ── Backend types ────────────────────────────────────────────────────────────

export interface BackendEdge {
    from: string;
    to: string;
    label: string;
}

export interface BackendNode {
    id: string;
    label: string;
    responsibility: string;
}

export interface BackendLeaf {
    id?: string;
    type: "leaf";
    label: string;
    summary: string;
    file_path: string;
    language: string | null;
    file_type: string | null;
    nodes: BackendNode[];
    edges: BackendEdge[];
    children: [];
}

export interface BackendCluster {
    id?: string;
    type: "cluster";
    label: string;
    summary: string;
    edges: BackendEdge[];
    children: (BackendCluster | BackendLeaf)[];
}

export type BackendTree = BackendCluster | BackendLeaf;

// ── Frontend types ───────────────────────────────────────────────────────────

export interface FileEntry {
    fileName: string;
    directory: string;
    functionality: string;
    connection: string[];
}

export interface Submap {
    id?: string;
    name: string;
    files: FileEntry[];
    dependsOn: string[];
}

export interface GraphData {
    rootId?: string;
    rootLabel: string;
    submaps: Submap[];
}

export interface QuerySource {
    chunk_id: string;
    file_path: string;
    domain_id: string | null;
    score: number;
    summary: string;
}

export interface QueryResult {
    answer: string;
    confidence: string;
    sources: QuerySource[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Collect all leaf nodes from a subtree.
 */
function collectLeaves(node: BackendTree): BackendLeaf[] {
    if (node.type === "leaf") return [node];
    return node.children.flatMap(collectLeaves);
}

function collectClusterEdges(node: BackendTree): BackendEdge[] {
    if (node.type === "leaf") {
        return [];
    }

    return [
        ...node.edges,
        ...node.children.flatMap(collectClusterEdges),
    ];
}

/**
 * Convert a cluster node into a Submap.
 * Uses the cluster's direct leaf children as files.
 * If cluster has sub-clusters, recursively flattens them.
 */
function clusterToSubmap(cluster: BackendCluster): Submap {
    const leaves = collectLeaves(cluster);
    const leafLabelSet = new Set(leaves.map((leaf) => leaf.label));
    const connectionMap = new Map<string, Set<string>>();

    for (const leaf of leaves) {
        connectionMap.set(leaf.label, new Set());
    }

    for (const edge of collectClusterEdges(cluster)) {
        if (leafLabelSet.has(edge.from) && leafLabelSet.has(edge.to) && edge.from !== edge.to) {
            connectionMap.get(edge.from)?.add(edge.to);
        }
    }

    const files: FileEntry[] = leaves.map((leaf) => ({
        fileName: leaf.label,
        directory: leaf.file_path,
        functionality: leaf.summary,
        connection: [...(connectionMap.get(leaf.label) ?? [])],
    }));

    return {
        id: cluster.id,
        name: cluster.label,
        files,
        dependsOn: [],
    };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert the full backend cluster tree to the frontend GraphData schema.
 *
 * Strategy:
 * - If root is a cluster with cluster children → each child cluster = one submap
 * - If root is a cluster with only leaf children → root itself = one submap
 * - If root is a leaf → wrap in a single submap
 */
export function adaptBackendTree(tree: BackendTree): GraphData {
    if (tree.type === "leaf") {
        // Edge case: entire repo is one file
        return {
            rootId: tree.id,
            rootLabel: tree.label,
            submaps: [
                {
                    id: tree.id,
                    name: tree.label,
                    files: [
                        {
                            fileName: tree.label,
                            directory: tree.file_path,
                            functionality: tree.summary,
                            connection: [],
                        },
                    ],
                    dependsOn: [],
                },
            ],
        };
    }

    const clusterChildren = tree.children.filter((child): child is BackendCluster => child.type === "cluster");
    const leafChildren = tree.children.filter((child): child is BackendLeaf => child.type === "leaf");

    if (clusterChildren.length === 0) {
        return {
            rootId: tree.id,
            rootLabel: tree.label,
            submaps: [clusterToSubmap(tree)],
        };
    }

    const submaps: Submap[] = clusterChildren.map(clusterToSubmap);

    if (leafChildren.length > 0) {
        submaps.push({
            name: "Project Root",
            files: leafChildren.map((leaf) => ({
                fileName: leaf.label,
                directory: leaf.file_path,
                functionality: leaf.summary,
                connection: [],
            })),
            dependsOn: [],
        });
    }

    // submapIndex: submap name → submap object (direct cluster children)
    // leafToSubmap: leaf label → containing submap name
    //
    // Root-level edges use individual leaf labels as endpoints. When orphan
    // leaves are collapsed into "Project Root", those labels no longer match
    // any submap name, so we resolve them via leafToSubmap.
    const submapIndex = new Map(submaps.map((submap) => [submap.name, submap]));

    const leafToSubmap = new Map<string, string>();
    for (const submap of submaps) {
        for (const file of submap.files) {
            leafToSubmap.set(file.fileName, submap.name);
        }
    }

    function resolveSubmapName(label: string): string | undefined {
        if (submapIndex.has(label)) return label;          // cluster submap
        return leafToSubmap.get(label);                    // orphan leaf → its container
    }

    for (const edge of tree.edges) {
        const srcName = resolveSubmapName(edge.from);
        const tgtName = resolveSubmapName(edge.to);
        if (!srcName || !tgtName || srcName === tgtName) continue;
        const source = submapIndex.get(srcName)!;
        if (!source.dependsOn.includes(tgtName)) {
            source.dependsOn.push(tgtName);
        }
    }

    // Populate internal connections within "Project Root" using root-level
    // edges whose both endpoints are orphan leaves.
    if (leafChildren.length > 0) {
        const rootLeafLabels = new Set(leafChildren.map((l) => l.label));
        const rootConnectionMap = new Map<string, Set<string>>();
        for (const leaf of leafChildren) rootConnectionMap.set(leaf.label, new Set());

        for (const edge of tree.edges) {
            if (rootLeafLabels.has(edge.from) && rootLeafLabels.has(edge.to) && edge.from !== edge.to) {
                rootConnectionMap.get(edge.from)?.add(edge.to);
            }
        }

        const projectRootSubmap = submapIndex.get("Project Root")!;
        projectRootSubmap.files = leafChildren.map((leaf) => ({
            fileName: leaf.label,
            directory: leaf.file_path,
            functionality: leaf.summary,
            connection: [...(rootConnectionMap.get(leaf.label) ?? [])],
        }));
    }

    return {
        rootId: tree.id,
        rootLabel: tree.label,
        submaps,
    };
}


// ── API helpers ──────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

export interface IngestResponse {
    repo_id: string;
    status: string;
}

export interface RepoStatus {
    id: string;
    status: "pending" | "ingesting" | "ready" | "failed";
    chunk_count: number;
    error: string | null;
}
export async function getLatestRepoId(): Promise<string> {
    const res = await fetch(`${API_BASE}/repo/latest`);
    if (!res.ok) throw new Error(`Could not fetch latest repo: ${res.statusText}`);
    const data = await res.json();
    return data.repo_id;
}

/**
 * Submit a GitHub repo for ingestion.
 */
export async function ingestRepo(githubUrl: string): Promise<IngestResponse> {
    const res = await fetch(`${API_BASE}/repo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ github_url: githubUrl }),
    });
    if (!res.ok) throw new Error(`Ingest failed: ${res.statusText}`);
    return res.json();
}

/**
 * Poll repo status until ready or failed.
 */
export async function pollRepoStatus(
    repoId: string,
    onStatus?: (status: RepoStatus) => void,
    intervalMs = 3000,
    timeoutMs = 600_000
): Promise<RepoStatus> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        const res = await fetch(`${API_BASE}/repo/${repoId}`);
        if (!res.ok) throw new Error(`Status check failed: ${res.statusText}`);
        const status: RepoStatus = await res.json();

        onStatus?.(status);

        if (status.status === "ready") return status;
        if (status.status === "failed") throw new Error(`Ingestion failed: ${status.error}`);

        await new Promise((r) => setTimeout(r, intervalMs));
    }

    throw new Error("Ingestion timed out after 10 minutes");
}

/**
 * Fetch the cluster tree and adapt it to the frontend schema.
 */
export async function fetchGraphData(repoId: string): Promise<GraphData> {
    const res = await fetch(`${API_BASE}/repo/${repoId}/graph`);
    if (!res.ok) throw new Error(`Graph fetch failed: ${res.statusText}`);
    const tree: BackendTree = await res.json();
    return adaptBackendTree(tree);
}
export async function fetchLatestGraphData(): Promise<{ repoId: string; graphData: GraphData }> {
    const res = await fetch(`${API_BASE}/repo/latest`);
    if (!res.ok) throw new Error("No ready repo found");
    const { repo_id } = await res.json();
    const graphData = await fetchGraphData(repo_id);
    return { repoId: repo_id, graphData };
}
/**
 * Full flow: ingest → poll → fetch graph.
 * Returns GraphData ready for the GraphViewer.
 */
export async function ingestAndFetch(
    githubUrl: string,
    onStatus?: (status: RepoStatus) => void
): Promise<{ repoId: string; graphData: GraphData }> {
    const { repo_id } = await ingestRepo(githubUrl);
    await pollRepoStatus(repo_id, onStatus, 5000, 1_200_000); // 20 min
    const graphData = await fetchGraphData(repo_id);
    return { repoId: repo_id, graphData };
}

/**
 * Query the RAG system about the repo.
 */
export async function queryRepo(
    repoId: string,
    question: string,
    domainId?: string,
    options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<QueryResult> {
    const controller = new AbortController();
    const timeoutMs = options?.timeoutMs ?? 30000;
    const timeoutId = setTimeout(() => controller.abort(new DOMException("Query timed out", "AbortError")), timeoutMs);

    const abortFromCaller = () => controller.abort(new DOMException("Query aborted", "AbortError"));
    options?.signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
        const body: { question: string; domain_id?: string } = { question };
        if (domainId) {
            body.domain_id = domainId;
        }

        const res = await fetch(`${API_BASE}/repo/${repoId}/query`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        const payload = await res.json().catch(() => null);
        if (!res.ok) {
            const detail = typeof payload?.detail === "string" ? payload.detail : res.statusText;
            throw new Error(detail || "Query failed");
        }

        return {
            answer: typeof payload?.answer === "string" && payload.answer.trim()
                ? payload.answer
                : "No answer returned.",
            confidence: typeof payload?.confidence === "string" ? payload.confidence : "low",
            sources: Array.isArray(payload?.sources) ? payload.sources : [],
        };
    } finally {
        clearTimeout(timeoutId);
        options?.signal?.removeEventListener("abort", abortFromCaller);
    }
}
export async function checkRepoReady(repoId: string): Promise<boolean> {
    const res = await fetch(`${API_BASE}/repo/${repoId}`);
    if (!res.ok) return false;
    const data = await res.json();
    return data.status === "ready";
}
