// Spec: knowledge/components/spec-studio.md

import type { Metadata, Viewport } from "next";
import "../styles/tokens.css";
import "../styles/globals.css";

export const metadata: Metadata = {
  title: "Æion Spec",
  description: "Zero-trust specification studio: Goldfish interview, AxiomSpec gates, sealed releases.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef3fb" },
    { media: "(prefers-color-scheme: dark)", color: "#070b16" },
  ],
};

// Runs before first paint so a stored theme never flashes the other one.
const THEME_BOOT = `(function(){try{var m=localStorage.getItem("aeion-theme")||"auto";var d=m==="night"||(m==="auto"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=d?"dark":"light";}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
