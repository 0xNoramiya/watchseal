import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ["@mysten-incubation/memwal", "@mysten/seal", "@grpc/grpc-js", "@protobuf-ts/grpc-transport"],
  // Recorded history is read with fs at runtime (offline mode, or no Tatum key), so tracing cannot see it.
  outputFileTracingIncludes: { "/*": ["./fixtures/*.json"] },
};

export default nextConfig;
