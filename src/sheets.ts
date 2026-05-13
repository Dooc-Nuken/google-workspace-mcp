import { sheets_v4, sheets } from "@googleapis/sheets";
import type { OAuth2Client } from "google-auth-library";

function getClient(auth: OAuth2Client): sheets_v4.Sheets {
  return sheets({ version: "v4", auth });
}

export interface SheetTabInfo {
  sheetId: number;
  title: string;
  index: number;
  hidden: boolean;
  rowCount: number;
  columnCount: number;
}

export async function listTabs(
  auth: OAuth2Client,
  spreadsheetId: string,
): Promise<{ spreadsheetId: string; title: string; tabs: SheetTabInfo[] }> {
  const client = getClient(auth);
  const res = await client.spreadsheets.get({
    spreadsheetId,
    fields:
      "spreadsheetId,properties(title),sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount)))",
  });
  const tabs: SheetTabInfo[] = (res.data.sheets ?? []).map((s) => {
    const p = s.properties ?? {};
    const grid = p.gridProperties ?? {};
    return {
      sheetId: p.sheetId ?? 0,
      title: p.title ?? "",
      index: p.index ?? 0,
      hidden: Boolean(p.hidden),
      rowCount: grid.rowCount ?? 0,
      columnCount: grid.columnCount ?? 0,
    };
  });
  return {
    spreadsheetId: res.data.spreadsheetId ?? spreadsheetId,
    title: res.data.properties?.title ?? "",
    tabs,
  };
}

export interface GetRangeResult {
  spreadsheetId: string;
  range: string;
  majorDimension: string;
  values: (string | number | boolean | null)[][];
}

export async function getRange(
  auth: OAuth2Client,
  spreadsheetId: string,
  range: string,
  valueRenderOption: "FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA" = "FORMATTED_VALUE",
): Promise<GetRangeResult> {
  const client = getClient(auth);
  const res = await client.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption,
  });
  return {
    spreadsheetId,
    range: res.data.range ?? range,
    majorDimension: res.data.majorDimension ?? "ROWS",
    values: (res.data.values as (string | number | boolean | null)[][]) ?? [],
  };
}

export interface UpdateRangeResult {
  spreadsheetId: string;
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
}

export async function updateRange(
  auth: OAuth2Client,
  spreadsheetId: string,
  range: string,
  values: (string | number | boolean | null)[][],
  valueInputOption: "RAW" | "USER_ENTERED" = "USER_ENTERED",
): Promise<UpdateRangeResult> {
  const client = getClient(auth);
  const res = await client.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption,
    requestBody: { values },
  });
  return {
    spreadsheetId,
    updatedRange: res.data.updatedRange ?? range,
    updatedRows: res.data.updatedRows ?? 0,
    updatedColumns: res.data.updatedColumns ?? 0,
    updatedCells: res.data.updatedCells ?? 0,
  };
}

export interface BatchUpdateRangeEntry {
  range: string;
  values: (string | number | boolean | null)[][];
}

export async function batchUpdateRanges(
  auth: OAuth2Client,
  spreadsheetId: string,
  data: BatchUpdateRangeEntry[],
  valueInputOption: "RAW" | "USER_ENTERED" = "USER_ENTERED",
): Promise<{ spreadsheetId: string; totalUpdatedCells: number; totalUpdatedRanges: number }> {
  const client = getClient(auth);
  const res = await client.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption,
      data: data.map((d) => ({ range: d.range, values: d.values })),
    },
  });
  return {
    spreadsheetId,
    totalUpdatedCells: res.data.totalUpdatedCells ?? 0,
    totalUpdatedRanges: res.data.totalUpdatedSheets ?? data.length,
  };
}
