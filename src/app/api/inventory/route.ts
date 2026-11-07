import { NextResponse } from "next/server";
import { getEngine } from "@/lib/engine";
import { humanizeError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Read-only: the relayer's inventory for this namespace, cross-checked against the write log. */
export async function GET() {
  try {
    return NextResponse.json({ ok: true, ...(await getEngine().inventory()) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: humanizeError(err) }, { status: 502 });
  }
}
