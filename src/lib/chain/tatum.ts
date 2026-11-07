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
    return new SuiGrpcClient({ network: "mainnet", baseUrl, meta: { "x-api-key": key } });
  }

  const transport = new GrpcTransport({
    host: host.replace(/^https?:\/\//, ""),
    channelCredentials: ChannelCredentials.createSsl(),
    meta: { "x-api-key": key },
  });
  return new SuiGrpcClient({ network: "mainnet", transport });
}
