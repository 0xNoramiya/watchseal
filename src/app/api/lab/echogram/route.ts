import { writeFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { DEFAULT_CONFIG, type EchogramConfig } from "@/lib/echogram/render";

export const dynamic = "force-dynamic";

const FILE = "src/lib/echogram/config.json";

/** Dev-only: writes the lab's current config to the file the dashboard imports. */
export async function POST(req: Request) {
  if (process.env.NODE_ENV !== "development") return NextResponse.json({ ok: false, error: "Lab saving is dev-only." }, { status: 404 });
  const body = (await req.json()) as Partial<EchogramConfig>;
  const config: EchogramConfig = { ...DEFAULT_CONFIG };
  for (const k of Object.keys(DEFAULT_CONFIG) as (keyof EchogramConfig)[]) {
    const v = body[k];
    if (v !== undefined && typeof v === typeof DEFAULT_CONFIG[k]) Object.assign(config, { [k]: v });
  }
  writeFileSync(path.join(process.cwd(), FILE), JSON.stringify(config, null, 2) + "\n");
  return NextResponse.json({ ok: true, path: FILE, config });
}
