import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/.well-known/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_URL}/.well-known/:path*`,
      },
    ];
  },
};

export default nextConfig;
