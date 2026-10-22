import type { Request, Response } from "express";
import {
  compileStudioDraft,
  getStudioCase,
  getStudioDraft,
  getStudioRun,
  getStudioSafety,
  listStudioCases,
  listStudioDrafts,
  listStudioRuns,
  listStudioTracks,
  promoteStudioDraft,
  saveStudioDraft,
  startStudioRun,
  validateStudioDraftScenario,
} from "../services/studio.service.js";
import { UnauthorizedError } from "../utils/errors.js";
import {
  parseStudioDraftId,
  parseStudioPromoteBody,
  parseStudioStartRunBody,
  parseStudioTrackQuery,
} from "../validation/studio.validation.js";

function requireUser(req: Request): void {
  if (!req.user) {
    throw new UnauthorizedError();
  }
}

export async function getTracks(req: Request, res: Response): Promise<void> {
  requireUser(req);
  res.status(200).json({ tracks: listStudioTracks() });
}

export async function getSafety(req: Request, res: Response): Promise<void> {
  requireUser(req);
  res.status(200).json(getStudioSafety());
}

export async function getCases(req: Request, res: Response): Promise<void> {
  requireUser(req);
  const track = parseStudioTrackQuery(req.query.track);
  const cases = listStudioCases(track);
  res.status(200).json({ track, cases, count: cases.length });
}

export async function getCase(req: Request, res: Response): Promise<void> {
  requireUser(req);
  const track = parseStudioTrackQuery(req.query.track);
  const id = parseStudioDraftId(req.params.id);
  const row = getStudioCase(track, id);
  res.status(200).json({ track, case: row });
}

export async function getRuns(req: Request, res: Response): Promise<void> {
  requireUser(req);
  const runs = listStudioRuns();
  res.status(200).json({
    runs: runs.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      status: r.status,
      track: r.track,
      summary: r.summary,
      blockers: r.blockers,
      productionApply: r.provenance?.productionApply ?? false,
      promptSource: r.provenance?.promptSource,
      promptHash: r.provenance?.promptHash,
    })),
    count: runs.length,
  });
}

export async function getRun(req: Request, res: Response): Promise<void> {
  requireUser(req);
  const id = parseStudioDraftId(req.params.id);
  const run = getStudioRun(id);
  res.status(200).json({ run });
}

export async function postRun(req: Request, res: Response): Promise<void> {
  requireUser(req);
  const body = parseStudioStartRunBody(req.body);
  // Server-side track gates live in startStudioRun / assertStudioTrackRunnable.
  const run = await startStudioRun(body);
  const status =
    run.status === "blocked" ? 403 : run.status === "error" ? 500 : 201;
  res.status(status).json({ run });
}

export async function getDrafts(req: Request, res: Response): Promise<void> {
  requireUser(req);
  res.status(200).json({ drafts: listStudioDrafts() });
}

export async function getDraft(req: Request, res: Response): Promise<void> {
  requireUser(req);
  const id = parseStudioDraftId(req.params.id);
  res.status(200).json({ id, draft: getStudioDraft(id) });
}

export async function putDraft(req: Request, res: Response): Promise<void> {
  requireUser(req);
  const id = parseStudioDraftId(req.params.id);
  const saved = saveStudioDraft(id, req.body);
  res.status(200).json(saved);
}

export async function postCompileDraft(
  req: Request,
  res: Response,
): Promise<void> {
  requireUser(req);
  const compiled = compileStudioDraft(req.body);
  res.status(200).json({ compiled });
}

export async function postValidateDraft(
  req: Request,
  res: Response,
): Promise<void> {
  requireUser(req);
  res.status(200).json(validateStudioDraftScenario(req.body));
}

export async function postPromoteDraft(
  req: Request,
  res: Response,
): Promise<void> {
  requireUser(req);
  const body = parseStudioPromoteBody(req.body);
  const result = promoteStudioDraft(body);
  res.status(200).json(result);
}
