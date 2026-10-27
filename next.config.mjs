import { withWorkflow } from "workflow/next";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  serverExternalPackages: ["@upstash/redis", "@babel/parser"],
  experimental: {
    serverActions: {
      bodySizeLimit: "512kb",
    },
  },
};

// Enables the "use workflow" / "use step" directives in src/workflows.
export default withWorkflow(nextConfig);
