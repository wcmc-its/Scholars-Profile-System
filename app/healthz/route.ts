import { NextResponse } from "next/server";

// Shallow liveness probe. Returns 200 if the process is up. No DB or external
// service calls — a deep check here would cause a DB blip to cycle every
// Fargate task and amplify the outage. Deep checks live at /readiness.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET() {
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
