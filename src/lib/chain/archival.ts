/**
 * Archival fallback. Full nodes (including Tatum's) prune old transactions, so
 * upgrades older than the retention window come back NOT_FOUND over gRPC.
 * Public Sui GraphQL is archival-backed and still serves them.
 */
import { env } from "../env";
import { bump } from "../metrics";
import { schemeFromCode, type UpgradeTx } from "./types";

const QUERY = `query Tx($digest: String!) {
  transaction(digest: $digest) {
    digest
    sender { address }
    signatures { signatureBytes }
    effects {
      timestamp
      objectChanges(first: 50) {
        nodes {
          address
          outputState {
            owner { __typename ... on AddressOwner { address { address } } }
            asMoveObject { contents { type { repr } } }
          }
        }
      }
    }
  }
}`;

interface GqlNode {
  address: string;
  outputState: {
    owner: { __typename: string; address?: { address: string } } | null;
    asMoveObject: { contents: { type: { repr: string } } } | null;
  } | null;
}

export async function fetchArchivalTx(digest: string): Promise<UpgradeTx | null> {
  bump("archivalCalls");
  const res = await fetch(env.archivalGraphql, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { digest } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`archival GraphQL HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: { transaction: null | {
      digest: string;
      sender: { address: string } | null;
      signatures: { signatureBytes: string }[];
      effects: { timestamp: string | null; objectChanges: { nodes: GqlNode[] } } | null;
    } };
    errors?: { message: string }[];
  };
  if (body.errors?.length) throw new Error(`archival GraphQL: ${body.errors[0].message}`);
  const tx = body.data?.transaction;
  if (!tx) return null;

  const schemes = tx.signatures.map((s) => schemeFromCode(Buffer.from(s.signatureBytes, "base64")[0]));
  const cap = tx.effects?.objectChanges.nodes.find((n) =>
    n.outputState?.asMoveObject?.contents.type.repr.endsWith("::package::UpgradeCap"),
  );
  const owner = cap?.outputState?.owner;
  return {
    digest: tx.digest,
    timestampMs: tx.effects?.timestamp ? Date.parse(tx.effects.timestamp) : null,
    sender: tx.sender?.address ?? "?",
    schemes,
    capId: cap?.address ?? null,
    capOwner: owner?.address?.address ?? null,
    capOwnerKind: owner ? (owner.__typename === "AddressOwner" ? "address" : owner.__typename) : null,
    source: "archival",
  };
}
