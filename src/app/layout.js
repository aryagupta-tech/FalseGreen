import "./globals.css";

export const metadata = {
  title: "FalseGreen — Find the mistakes your passing tests would let through.",
  description:
    "Find gaps in your passing Vitest tests in the browser or with the local FalseGreen CLI. Mutate an ES module and verify requirement-derived regression tests through four executions.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f4f0e5",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
