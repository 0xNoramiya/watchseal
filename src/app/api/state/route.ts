import { NextResponse } from "next/server";
import { getEngine } from "@/lib/engine";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getEngine().view());
}
