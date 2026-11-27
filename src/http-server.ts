import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Repository } from "./repository.js";
import { actionSchema, type Action } from "./actions.js";
import { scanProjectClimbs } from "./repo-ops.js";
import { computeInsights } from "./insights.js";
import { exportShareableReport, generateArtifactFromTemplate, type ArtifactTemplateId } from "./artifacts.js";
import { ingestAlert } from "./hooks.js";

function isHumanDecision(action: Action): boolean {
  return (
    action.op === "approve_change" ||
    action.op === "reject_change" ||
    action.op === "promote_track" ||
    action.op === "accept_flow_change" ||
    action.op === "reject_flow_change"
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error("Request body too large");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface LoopbackServerOptions {
  port?: number;
  token?: string;
}

/**
 * Local loopback-only (`127.0.0.1`) HTTP JSON API over Repository for scripts,
 * CI runners, and local dashboards. Requires Bearer authentication on all `/api/v1/*` routes
 * except `/api/v1/health`.
 */
export function startLoopbackServer(
  repo: Repository,
  opts?: LoopbackServerOptions,
): Promise<{ url: string; port: number; token: string; close: () => Promise<void> }> {
  const port = opts?.port ?? 4318;
  const token = opts?.token?.trim() || randomBytes(24).toString("hex");

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const pathname = url.pathname;
      const method = (req.method ?? "GET").toUpperCase();

      if (method === "GET" && pathname === "/api/v1/health") {
        sendJson(res, 200, { ok: true, service: "hillclimb", bind: "127.0.0.1" });
        return;
      }

      const authHeader = req.headers.authorization ?? "";
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
      if (!bearer || !tokenMatches(bearer, token)) {
        sendJson(res, 401, { error: "Unauthorized: valid Bearer token required" });
        return;
      }

      if (method === "GET" && pathname === "/api/v1/projects") {
        sendJson(res, 200, { projects: repo.listProjects(), inboxCount: repo.inboxCountTotal() });
        return;
      }

      const match = /^\/api\/v1\/projects\/([^/]+)\/([a-z-]+)$/.exec(pathname);
      if (!match) {
        sendJson(res, 404, { error: `Unknown endpoint ${method} ${pathname}` });
        return;
      }
      const projectId = repo.resolveProjectId(decodeURIComponent(match[1]!));
      const resource = match[2]!;

      if (method === "GET" && resource === "tree") {
        const track = url.searchParams.get("track") ?? "main";
        sendJson(res, 200, { projectId, track, snapshot: repo.view(projectId, track) });
        return;
      }

      if (method === "GET" && resource === "next") {
        const track = url.searchParams.get("track") ?? "main";
        const scope = url.searchParams.get("scope");
        const snap = repo.view(projectId, track);
        const allowed = scope ? repo.resolveScopeOutcomeKeys(projectId, scope, snap) : null;
        const nextKeys = allowed ? snap.next.filter((k) => allowed.has(k)) : snap.next;
        sendJson(res, 200, { projectId, track, next: nextKeys, inbox: snap.inbox });
        return;
      }

      if (method === "GET" && resource === "search") {
        const q = url.searchParams.get("q") ?? "";
        const limit = Number(url.searchParams.get("limit") ?? "30");
        sendJson(res, 200, { projectId, query: q, hits: repo.search(projectId, q, { limit }) });
        return;
      }

      if (method === "GET" && resource === "insights") {
        const days = Number(url.searchParams.get("days") ?? "30");
        const track = url.searchParams.get("track") ?? "main";
        const dir = repo.getProject(projectId)?.directory ?? null;
        const scanned = dir ? scanProjectClimbs(dir) : null;
        sendJson(res, 200, computeInsights(repo, projectId, { days, track, scannedClimbs: scanned }));
        return;
      }

      if (method === "GET" && resource === "artifacts") {
        const folder = url.searchParams.get("folder") ?? undefined;
        sendJson(res, 200, { projectId, artifacts: repo.listArtifacts(projectId, folder) });
        return;
      }

      if (method === "POST" && resource === "artifacts") {
        const body = await readJsonBody(req);
        if (typeof body.template === "string") {
          const dir = repo.getProject(projectId)?.directory ?? null;
          const scanned = dir ? scanProjectClimbs(dir) : null;
          const gen = generateArtifactFromTemplate(repo, projectId, {
            template: body.template as ArtifactTemplateId,
            title: typeof body.title === "string" ? body.title : undefined,
            folder: typeof body.folder === "string" ? body.folder : undefined,
            releaseName: typeof body.releaseName === "string" ? body.releaseName : undefined,
            scannedClimbs: scanned,
            actor: "rest-api",
            save: true,
          });
          sendJson(res, 201, { artifact: gen.saved });
          return;
        }
        const saved = repo.saveArtifact(projectId, {
          id: typeof body.id === "string" ? body.id : undefined,
          folder: typeof body.folder === "string" ? body.folder : undefined,
          title: String(body.title ?? ""),
          body: String(body.body ?? ""),
          citations: Array.isArray(body.citations) ? body.citations.map(String) : undefined,
          locked: typeof body.locked === "boolean" ? body.locked : undefined,
          actor: "rest-api",
        });
        sendJson(res, 201, { artifact: saved });
        return;
      }

      if (method === "GET" && resource === "export") {
        const format = url.searchParams.get("format") === "markdown" ? "markdown" : "html";
        const dir = repo.getProject(projectId)?.directory ?? null;
        const scanned = dir ? scanProjectClimbs(dir) : null;
        const out = exportShareableReport(repo, projectId, {
          format,
          track: url.searchParams.get("track") ?? "main",
          scope: url.searchParams.get("scope") ?? undefined,
          releaseName: url.searchParams.get("release") ?? undefined,
          goalKey: url.searchParams.get("goal") ?? undefined,
          scannedClimbs: scanned,
        });
        res.writeHead(200, {
          "Content-Type": format === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8",
          "Content-Disposition": `inline; filename="${out.filename}"`,
          "Cache-Control": "no-store",
        });
        res.end(out.content);
        return;
      }

      if (method === "POST" && resource === "act") {
        const body = await readJsonBody(req);
        const parsed = actionSchema.parse(body.action ?? body);
        const humanConfirmed = req.headers["x-hillclimb-human-confirmed"] === "true";
        if (isHumanDecision(parsed) && !humanConfirmed) {
          sendJson(res, 403, { error: "Human confirmation header required for contract/flow/track approval decisions" });
          return;
        }
        repo.act(projectId, parsed, { actor: String(body.actor ?? "rest-api"), via: "rest" });
        sendJson(res, 200, { ok: true, projectId, inbox: repo.view(projectId).inbox });
        return;
      }

      if (method === "POST" && resource === "alerts") {
        const body = await readJsonBody(req);
        const result = ingestAlert(repo, {
          project: projectId,
          key: String(body.key ?? ""),
          message: String(body.message ?? ""),
          source: String(body.source ?? "webhook"),
          severity:
            body.severity === "critical" || body.severity === "error" || body.severity === "warning" || body.severity === "info"
              ? body.severity
              : "error",
          criterionIds: Array.isArray(body.criterionIds) ? body.criterionIds.map(String) : undefined,
          track: typeof body.track === "string" ? body.track : "main",
          actor: "rest-alert",
        });
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: `Unknown endpoint ${method} ${pathname}` });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        url: `http://127.0.0.1:${boundPort}`,
        port: boundPort,
        token,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}
