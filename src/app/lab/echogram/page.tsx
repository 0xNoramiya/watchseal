import { notFound } from "next/navigation";
import EchogramLab from "./lab";

export const metadata = { title: "Echogram lab" };

/** Scaffolding only: nothing in production imports this route. */
export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <EchogramLab />;
}
