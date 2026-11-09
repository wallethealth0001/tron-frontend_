import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TRON Wallet AML & Flag Checker",
  description:
    "TRON wallet AML and flag checker.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
