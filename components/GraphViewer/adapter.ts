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
    name: string;
    files: FileEntry[];
}

export interface GraphData {
    submaps: Submap[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Collect all leaf nodes from a subtree.
 */
function collectLeaves(node: BackendTree): BackendLeaf[] {
    if (node.type === "leaf") return [node];
    return node.children.flatMap(collectLeaves);
}

/**
 * Convert a single leaf node to a FileEntry.
 * Connections are derived from the leaf's internal edges (to fields).
 */
function leafToFileEntry(leaf: BackendLeaf, allLeaves: BackendLeaf[]): FileEntry {
    // Build a set of all sibling file labels for connection filtering
    const siblingLabels = new Set(allLeaves.map((l) => l.label));

    // Use internal edge "to" fields as connections, filtered to siblings only
    const connection = leaf.edges
        .map((e) => e.to)
        .filter((to) => siblingLabels.has(to) && to !== leaf.label);

    return {
        fileName: leaf.label,
        directory: leaf.file_path,
        functionality: leaf.summary,
        connection: [...new Set(connection)], // deduplicate
    };
}

/**
 * Convert a cluster node into a Submap.
 * Uses the cluster's direct leaf children as files.
 * If cluster has sub-clusters, recursively flattens them.
 */
function clusterToSubmap(cluster: BackendCluster): Submap {
    const leaves = collectLeaves(cluster);

    const files = leaves.map((leaf) => leafToFileEntry(leaf, leaves));

    return {
        name: cluster.label,
        files,
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
            submaps: [
                {
                    name: tree.label,
                    files: [leafToFileEntry(tree, [tree])],
                },
            ],
        };
    }

    const hasClusterChildren = tree.children.some((c) => c.type === "cluster");

    if (hasClusterChildren) {
        // Normal case: top-level clusters become submaps
        const submaps = tree.children.map((child) => {
            if (child.type === "cluster") return clusterToSubmap(child);
            // Leaf directly under root — wrap as single-file submap
            return {
                name: child.label,
                files: [leafToFileEntry(child, [child])],
            };
        });
        return { submaps };
    }

    // Root cluster has only leaves — treat root as single submap
    return { submaps: [clusterToSubmap(tree)] };
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

/**
 * Full flow: ingest → poll → fetch graph.
 * Returns GraphData ready for the GraphViewer.
 */
export async function ingestAndFetch(
    githubUrl: string,
    onStatus?: (status: RepoStatus) => void
): Promise<{ repoId: string; graphData: GraphData }> {
    const { repo_id } = await ingestRepo(githubUrl);
    await pollRepoStatus(repo_id, onStatus);
    const graphData = await fetchGraphData(repo_id);
    return { repoId: repo_id, graphData };
}

/**
 * Query the RAG system about the repo.
 */
export async function queryRepo(
    repoId: string,
    question: string,
    domainId?: string
): Promise<{ answer: string; confidence: string; sources: any[] }> {
    const res = await fetch(`${API_BASE}/repo/${repoId}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, domain_id: domainId }),
    });
    if (!res.ok) throw new Error(`Query failed: ${res.statusText}`);
    return res.json();
}