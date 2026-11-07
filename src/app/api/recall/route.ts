import { NextResponse } from "next/server";
import { getEngine } from "@/lib/engine";
import { humanizeError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Read-only semantic recall for the memory explorer: GET /api/recall?q=...&slug=... */
export async function GET(req: Request) {
  const url = new URL(req.url);
  try {
    const result = await getEngine().explore(url.searchParams.get("q") ?? "", url.searchParams.get("slug"));
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: humanizeError(err) }, { status: 400 });
  }
}
