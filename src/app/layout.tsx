import type { Metadata } from "next";
import { Caveat, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const sans = Instrument_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
// Narrow and built for code, so hex blob ids and Move identifiers sit quietly next to Instrument Sans.
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap", weight: ["400", "500"] });
// Hand-written fix-mark labels on the echogram, like an operator writing on the recorder paper.
const hand = Caveat({ subsets: ["latin"], variable: "--font-hand", display: "swap", weight: ["500"] });

export const metadata: Metadata = {
  title: "WatchSeal",
  description: "Sui package-upgrade watchdog that learns your triage. Tatum gRPC for chain reads, Walrus Memory for what it learned.",
  icons: { icon: "/seal.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${hand.variable}`}>
      <body>{children}</body>
    </html>
  );
}
