// Loads .env for scripts and tests (Next.js loads it on its own).
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file: rely on the real environment
}

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

export const env = {
  get offline() {
    return str("WATCHSEAL_OFFLINE") === "1";
  },
  get tatumKey() {
    return str("TATUM_API_KEY");
  },
  get tatumHost() {
    return str("TATUM_GRPC_HOST", "sui-mainnet-grpc.gateway.tatum.io:443");
  },
  get tatumTransport(): "native" | "grpcweb" {
    return str("TATUM_GRPC_TRANSPORT") === "grpcweb" ? "grpcweb" : "native";
  },
  get archivalGraphql() {
    return str("SUI_ARCHIVAL_GRAPHQL", "https://graphql.mainnet.sui.io/graphql");
  },
  get memwalKey() {
    return str("MEMWAL_PRIVATE_KEY");
  },
  get memwalAccount() {
    return str("MEMWAL_ACCOUNT_ID");
  },
  get memwalServer() {
    return str("MEMWAL_SERVER_URL", "https://relayer.memory.walrus.xyz");
  },
  get memwalNamespace() {
    return str("MEMWAL_NAMESPACE", "watchseal");
  },
  get memwalMock() {
    return str("MEMWAL_MOCK") === "1";
  },
  get anthropicKey() {
    return str("ANTHROPIC_API_KEY");
  },
  get anthropicModel() {
    return str("ANTHROPIC_MODEL", "claude-sonnet-5-5");
  },
  get stateFile() {
    return str("WATCHSEAL_STATE_FILE", "data/state.json");
  },
};
