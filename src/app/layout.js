import "./globals.css";

export const metadata = {
  title: "FalseGreen — Find the mistakes your passing tests would let through.",
  description:
    "FalseGreen mutates a submitted ES module, runs the submitted Vitest suite against each mutant, and only offers a repair after the proposed regression test passes a four-step verification matrix.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0d0c",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
