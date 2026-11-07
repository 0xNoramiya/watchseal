import { NextResponse } from "next/server";
import { getEngine } from "@/lib/engine";
import type { TriageLabel } from "@/lib/memory/format";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Body =
  | { op: "add"; originalId: string; name?: string; mode: "replay" | "live"; startVersion?: number | string }
  | { op: "next"; slug: string }
  | { op: "scan" }
  | { op: "triage"; alertId: string; label: TriageLabel; note?: string }
  | { op: "rule"; text: string; slug?: string | null }
  | { op: "compare"; alertId: string }
  | { op: "reset"; slug: string }
  | { op: "remove"; slug: string };

const LABELS: TriageLabel[] = ["expected", "suspicious", "false-positive"];

export async function POST(req: Request) {
  const ws = getEngine();
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Request body must be JSON." }, { status: 400 });
  }
  try {
    let result: unknown;
    switch (body.op) {
      case "add": {
        const start = body.startVersion === undefined || body.startVersion === "" ? undefined : Number(body.startVersion);
        if (start !== undefined && !Number.isInteger(start)) throw new Error("Start version must be a whole number.");
        if (!/^0x[0-9a-fA-F]{1,64}$/.test(body.originalId?.trim() ?? "")) throw new Error("Package ID must be a 0x-prefixed hex address.");
        result = await ws.addProtocol({ originalId: body.originalId.trim(), name: body.name, mode: body.mode, startVersion: start });
        break;
      }
      case "next":
        result = await ws.next(body.slug);
        break;
      case "scan":
        result = await ws.scan();
        break;
      case "triage":
        if (!LABELS.includes(body.label)) throw new Error("Label must be expected, suspicious or false-positive.");
        result = await ws.triage(body.alertId, body.label, body.note);
        break;
      case "rule":
        result = await ws.addRule(body.text, body.slug || null);
        break;
      case "compare":
        result = await ws.compare(body.alertId);
        break;
      case "reset":
        result = await ws.resetProtocol(body.slug);
        break;
      case "remove":
        result = await ws.removeProtocol(body.slug);
        break;
      default:
        throw new Error("Unknown action.");
    }
    return NextResponse.json({ ok: true, result, state: ws.view() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
