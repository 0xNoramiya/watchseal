import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ["@mysten-incubation/memwal", "@mysten/seal", "@grpc/grpc-js", "@protobuf-ts/grpc-transport"],
};

export default nextConfig;
