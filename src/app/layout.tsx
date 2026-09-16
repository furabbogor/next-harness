import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Next Harness — An agent workspace",
  description: "A considered workspace for agentic work. Durable sessions, inspectable tools, and approval-first file changes.",
  applicationName: "Next Harness",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#252c27" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><a href="#main-content" className="skip-link">Skip to workspace</a>{children}</body></html>;
}
