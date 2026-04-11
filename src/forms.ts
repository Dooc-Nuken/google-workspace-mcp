import { google, forms_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

function getClient(auth: OAuth2Client): forms_v1.Forms {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // Cast required: googleapis bundles its own google-auth-library version, causing
  // a structural type mismatch with the top-level google-auth-library dependency.
  return google.forms({ version: "v1", auth: auth as any });
}

// ── Public API ──

export interface FormInfo {
  formId: string;
  title: string;
  description: string;
  documentTitle: string;
  responderUri: string;
  linkedSheetId: string | null;
  itemCount: number;
}

export async function getForm(
  auth: OAuth2Client,
  formId: string,
): Promise<FormInfo> {
  const client = getClient(auth);
  const res = await client.forms.get({ formId });
  const form = res.data;
  return {
    formId: form.formId ?? formId,
    title: form.info?.title ?? "",
    description: form.info?.description ?? "",
    documentTitle: form.info?.documentTitle ?? "",
    responderUri: form.responderUri ?? "",
    linkedSheetId: form.linkedSheetId ?? null,
    itemCount: form.items?.length ?? 0,
  };
}

export interface FormResponseSummary {
  responseId: string;
  createTime: string;
  lastSubmittedTime: string;
  respondentEmail: string;
  answerCount: number;
}

export async function listResponses(
  auth: OAuth2Client,
  formId: string,
  limit: number,
): Promise<{ formId: string; count: number; responses: FormResponseSummary[] }> {
  const client = getClient(auth);
  const res = await client.forms.responses.list({
    formId,
    pageSize: limit,
  });
  const responses = (res.data.responses ?? []).map((r) => ({
    responseId: r.responseId ?? "",
    createTime: r.createTime ?? "",
    lastSubmittedTime: r.lastSubmittedTime ?? "",
    respondentEmail: r.respondentEmail ?? "",
    answerCount: Object.keys(r.answers ?? {}).length,
  }));
  return { formId, count: responses.length, responses };
}

export interface FormResponseDetail {
  responseId: string;
  createTime: string;
  lastSubmittedTime: string;
  respondentEmail: string;
  answers: Record<string, unknown>;
}

export async function getResponse(
  auth: OAuth2Client,
  formId: string,
  responseId: string,
): Promise<FormResponseDetail> {
  const client = getClient(auth);
  const res = await client.forms.responses.get({ formId, responseId });
  const r = res.data;
  return {
    responseId: r.responseId ?? responseId,
    createTime: r.createTime ?? "",
    lastSubmittedTime: r.lastSubmittedTime ?? "",
    respondentEmail: r.respondentEmail ?? "",
    answers: r.answers ?? {},
  };
}
