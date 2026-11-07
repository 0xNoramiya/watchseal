import { ChannelCredentials } from "@grpc/grpc-js";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { env } from "../env";

/**
 * Sui gRPC client pointed at Tatum's Mainnet gateway.
 * Native gRPC (HTTP/2) is the default; TATUM_GRPC_TRANSPORT=grpcweb switches to gRPC-web.
 */
export function createTatumClient(): SuiGrpcClient {
  const key = env.tatumKey;
  if (!key) throw new Error("TATUM_API_KEY is not set");
  const host = env.tatumHost;

  if (env.tatumTransport === "grpcweb") {
    const baseUrl = host.startsWith("http") ? host : `https://${host.replace(/:443$/, "")}`;
    return new SuiGrpcClient({ network: "mainnet", baseUrl, meta: { "x-api-key": key }, timeout: 20_000 });
  }

  const transport = new GrpcTransport({
    host: host.replace(/^https?:\/\//, ""),
    channelCredentials: ChannelCredentials.createSsl(),
    meta: { "x-api-key": key },
    // Every call gets a deadline, so a stalled connection fails fast instead of hanging forever.
    timeout: 20_000,
    // Keepalive pings notice connections dropped while idle (WSL and home NATs do this) and reconnect.
    clientOptions: {
      "grpc.keepalive_time_ms": 30_000,
      "grpc.keepalive_timeout_ms": 10_000,
      "grpc.keepalive_permit_without_calls": 1,
    },
  });
  return new SuiGrpcClient({ network: "mainnet", transport });
}
