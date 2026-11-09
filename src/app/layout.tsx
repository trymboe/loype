import type { Metadata, Viewport } from "next";
import { Instrument_Sans } from "next/font/google";
import { NavProgress } from "@/components/feedback/nav-progress";
import "./globals.css";

// Instrument Sans: compact, crisp figures that stay tight with tabular-nums, and a warm text face.
const sans = Instrument_Sans({ variable: "--font-sans", subsets: ["latin", "latin-ext"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "Løype", template: "%s · Løype" },
  description: "Your adaptive running coach",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Løype", statusBarStyle: "black-translucent" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0b0d" },
    { media: "(prefers-color-scheme: light)", color: "#f4f3ef" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${sans.variable} antialiased`}>
        <NavProgress />
        {children}
      </body>
    </html>
  );
}
