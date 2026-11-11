import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true, // ข้ามการเช็ค TypeScript ตอน Build บน Vercel
  },
};

export default nextConfig;