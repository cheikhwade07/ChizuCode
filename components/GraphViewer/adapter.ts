/**
 * API helpers and shared graph types.
 *
 * The backend graph endpoint returns a recursive composite tree. The frontend
 * preserves that tree and renders one cluster layer at a time.
 */

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
    children: BackendTree[];
}

export type BackendTree = BackendCluster | BackendLeaf;
export type GraphData = BackendTree;

export interface QuerySource {
    chunk_id: string;
    file_path: string;
    domain_id: string | null;
    score: number;
    summary: string;
}

export interface WorkflowSegment {
    navigate_to_submap?: string | null;
    navigate_to_submap_id?: string | null;
    zoom_to_node?: string;
    paths: string[][];
    internal_flow?: {
        node_label: string;
        steps: string[];
    };
    loop: boolean;
    step_duration_ms: number;
}

export interface WorkflowFlow {
    // Multi-segment field — present when backend returns multiple animation targets.
    segments?: WorkflowSegment[];
    // Legacy single-segment fields — still populated for backward compatibility.
    navigate_to_submap?: string | null;
    navigate_to_submap_id?: string | null;
    zoom_to_node?: string;
    paths: string[][];
    internal_flow?: {
        node_label: string;
        steps: string[];
    };
    loop: boolean;
    step_duration_ms: number;
}

export interface WorkflowAnimation {
    answer: string;
    confidence: string;
    sources: QuerySource[];
    type: "workflow_animation";
    flow: WorkflowFlow;
}

export interface QueryResult {
    answer: string;
    confidence: string;
    sources: QuerySource[];
    type?: string;
    flow?: WorkflowFlow;
}

export interface IngestResponse {
    repo_id: string;
    status: string;
}

export interface RepoStatus {
    id: string;
    name?: string;
    github_url?: string;
    status: "pending" | "ingesting" | "ready" | "failed";
    phase?: string;
    chunk_count: number;
    error: string | null;
}

export interface RepoQuota {
    limit: number;
    used: number;
    remaining: number;
    resets_in_hours: number;
}

export class ApiError extends Error {
    status: number;
    detail: unknown;

    constructor(message: string, status: number, detail?: unknown) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.detail = detail;
    }
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";
const START_REQUEST_TIMEOUT_MS = 45_000;
const STATUS_REQUEST_TIMEOUT_MS = 8_000;

function isBackendTree(value: unknown): value is BackendTree {
    if (!value || typeof value !== "object") return false;
    const node = value as Partial<BackendTree>;
    if (node.type === "leaf") {
        return (
            typeof node.label === "string" &&
            typeof node.summary === "string" &&
            typeof node.file_path === "string" &&
            Array.isArray(node.nodes) &&
            Array.isArray(node.edges)
        );
    }
    if (node.type === "cluster") {
        return (
            typeof node.label === "string" &&
            typeof node.summary === "string" &&
            Array.isArray(node.edges) &&
            Array.isArray(node.children) &&
            node.children.every(isBackendTree)
        );
    }
    return false;
}

async function fetchWithTimeout(
    url: string,
    init: RequestInit = {},
    timeoutMs: number,
    label: string
): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
            throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds. Check that the backend is awake and reachable.`);
        }
        throw new Error(`${label} could not reach the backend at ${API_BASE}. Check NEXT_PUBLIC_API_URL, backend deployment, and CORS.`);
    } finally {
        window.clearTimeout(timeoutId);
    }
}

async function readErrorPayload(res: Response): Promise<unknown> {
    return res.json().catch(() => null);
}

function getErrorMessage(payload: unknown, fallback: string): string {
    if (!payload || typeof payload !== "object") return fallback;
    const data = payload as { detail?: unknown; error?: unknown; message?: unknown };
    if (typeof data.detail === "string") return data.detail;
    if (data.detail && typeof data.detail === "object") {
        const detail = data.detail as { message?: unknown; error?: unknown };
        if (typeof detail.message === "string") return detail.message;
        if (typeof detail.error === "string") return detail.error;
    }
    if (typeof data.message === "string") return data.message;
    if (typeof data.error === "string") return data.error;
    return fallback;
}

async function readErrorDetail(res: Response, fallback: string): Promise<string> {
    return getErrorMessage(await readErrorPayload(res), fallback);
}

export async function getLatestRepoId(): Promise<string> {
    const res = await fetchWithTimeout(`${API_BASE}/repo/latest`, {}, STATUS_REQUEST_TIMEOUT_MS, "Latest repo check");
    if (!res.ok) throw new Error(await readErrorDetail(res, `Could not fetch latest repo: ${res.statusText}`));
    const data = await res.json();
    return data.repo_id;
}

export async function getRepoStatus(repoId: string): Promise<RepoStatus> {
    const res = await fetchWithTimeout(`${API_BASE}/repo/${repoId}`, {}, STATUS_REQUEST_TIMEOUT_MS, "Repo status check");
    if (!res.ok) throw new Error(await readErrorDetail(res, `Repo status check failed: ${res.statusText}`));
    const payload = await res.json();
    return {
        ...payload,
        chunk_count: Number(payload?.chunk_count ?? 0),
    };
}

export async function getRepoQuota(): Promise<RepoQuota> {
    const res = await fetchWithTimeout(`${API_BASE}/repo/quota`, {}, STATUS_REQUEST_TIMEOUT_MS, "Repo quota check");
    if (!res.ok) throw new Error(await readErrorDetail(res, `Repo quota check failed: ${res.statusText}`));
    const payload = await res.json();
    return {
        limit: Number(payload?.limit ?? 3),
        used: Number(payload?.used ?? 0),
        remaining: Number(payload?.remaining ?? 0),
        resets_in_hours: Number(payload?.resets_in_hours ?? 24),
    };
}

export async function ingestRepo(githubUrl: string): Promise<IngestResponse> {
    const res = await fetchWithTimeout(`${API_BASE}/repo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ github_url: githubUrl }),
    }, START_REQUEST_TIMEOUT_MS, "Ingest request");
    if (!res.ok) {
        const payload = await readErrorPayload(res);
        throw new ApiError(getErrorMessage(payload, `Ingest failed: ${res.statusText}`), res.status, payload);
    }
    return res.json();
}

export async function pollRepoStatus(
    repoId: string,
    onStatus?: (status: RepoStatus) => void,
    intervalMs = 3000,
    timeoutMs = 1_800_000
): Promise<RepoStatus> {
    const start = Date.now();
    let consecutiveFailures = 0;
    let lastFailure: Error | null = null;

    while (Date.now() - start < timeoutMs) {
        let status: RepoStatus;
        try {
            const res = await fetchWithTimeout(`${API_BASE}/repo/${repoId}`, {}, STATUS_REQUEST_TIMEOUT_MS, "Status check");
            if (!res.ok) throw new Error(await readErrorDetail(res, `Status check failed: ${res.statusText}`));
            const payload = await res.json();
            status = {
                ...payload,
                chunk_count: Number(payload?.chunk_count ?? 0),
            };
            consecutiveFailures = 0;
            lastFailure = null;
        } catch (error) {
            consecutiveFailures += 1;
            lastFailure = error instanceof Error ? error : new Error("Status check failed");
            if (consecutiveFailures >= 5) {
                throw lastFailure;
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
            continue;
        }

        onStatus?.(status);

        if (status.status === "ready") return status;
        if (status.status === "failed") throw new Error(`Ingestion failed: ${status.error}`);

        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(lastFailure?.message ?? `Ingestion timed out after ${Math.round(timeoutMs / 60_000)} minutes`);
}

export async function fetchGraphData(repoId: string): Promise<GraphData> {
    const res = await fetchWithTimeout(`${API_BASE}/repo/${repoId}/graph`, {}, STATUS_REQUEST_TIMEOUT_MS, "Graph fetch");
    if (!res.ok) throw new Error(await readErrorDetail(res, `Graph fetch failed: ${res.statusText}`));
    const tree: unknown = await res.json();
    if (!isBackendTree(tree)) {
        throw new Error("Graph response was not a valid backend tree.");
    }
    return tree;
}

export async function fetchLatestGraphData(): Promise<{ repoId: string; graphData: GraphData }> {
    const repoId = await getLatestRepoId();
    const graphData = await fetchGraphData(repoId);
    return { repoId, graphData };
}

export async function ingestAndFetch(
    githubUrl: string,
    onStatus?: (status: RepoStatus) => void
): Promise<{ repoId: string; graphData: GraphData }> {
    const { repo_id } = await ingestRepo(githubUrl);
    await pollRepoStatus(repo_id, onStatus, 5000, 1_200_000);
    const graphData = await fetchGraphData(repo_id);
    return { repoId: repo_id, graphData };
}

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
        if (domainId) body.domain_id = domainId;

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
            type: typeof payload?.type === "string" ? payload.type : undefined,
            flow: payload?.flow,
        };
    } finally {
        clearTimeout(timeoutId);
        options?.signal?.removeEventListener("abort", abortFromCaller);
    }
}

export async function queryWorkflow(
    repoId: string,
    question: string,
    domainId?: string,
    options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<QueryResult> {
    const controller = new AbortController();
    const timeoutMs = options?.timeoutMs ?? 30000;
    const timeoutId = setTimeout(() => controller.abort(new DOMException("Workflow request timed out", "AbortError")), timeoutMs);

    const abortFromCaller = () => controller.abort(new DOMException("Workflow request aborted", "AbortError"));
    options?.signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
        const body: { question: string; domain_id?: string } = { question };
        if (domainId) body.domain_id = domainId;

        const res = await fetch(`${API_BASE}/repo/${repoId}/workflow`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        const payload = await res.json().catch(() => null);
        if (!res.ok) {
            const detail = typeof payload?.detail === "string" ? payload.detail : res.statusText;
            throw new Error(detail || "Workflow request failed");
        }

        return {
            answer: typeof payload?.answer === "string" && payload.answer.trim()
                ? payload.answer
                : "No workflow returned.",
            confidence: typeof payload?.confidence === "string" ? payload.confidence : "low",
            sources: Array.isArray(payload?.sources) ? payload.sources : [],
            type: typeof payload?.type === "string" ? payload.type : undefined,
            flow: payload?.flow,
        };
    } finally {
        clearTimeout(timeoutId);
        options?.signal?.removeEventListener("abort", abortFromCaller);
    }
}

export async function checkRepoReady(repoId: string): Promise<boolean> {
    const res = await fetchWithTimeout(`${API_BASE}/repo/${repoId}`, {}, STATUS_REQUEST_TIMEOUT_MS, "Repo readiness check");
    if (!res.ok) throw new Error(await readErrorDetail(res, `Repo readiness check failed: ${res.statusText}`));
    const data = await res.json();
    return data.status === "ready";
}
