import { config } from "dotenv";
import { z } from "zod";
import path from "path";
import { secp256k1 } from "@noble/curves/secp256k1";
import { CONFIG as FAKENET_CONFIG } from "fakenet-signer";
import { constants as signetConstants, utils as signetUtils } from "signet.js";

config({ path: path.resolve(process.cwd(), ".env") });

const deriveBasePublicKey = (privateKey: string): string => {
  const publicKeyBytes = secp256k1.getPublicKey(privateKey.slice(2), false);
  return Buffer.from(publicKeyBytes).toString("hex");
};

/**
 * signet.js publishes root keys as `secp256k1:<base58>`; the rest of this file
 * works in lowercase uncompressed `04...` hex.
 */
const najPublicKeyToUncompressedHex = (najKey: `secp256k1:${string}`): string =>
  signetUtils.cryptography.normalizeToUncompressedPubKey(najKey).toLowerCase();

/**
 * The managed Signet MPC networks. Both the chain-signatures program and the
 * MPC root key are properties of the network, so they are always resolved as a
 * pair — supplying one without the other yields signatures that recover to an
 * unexpected address.
 */
const MPC_NETWORKS = {
  dev: {
    chainSignaturesProgramId: signetConstants.CONTRACT_ADDRESSES.SOLANA
      .TESTNET_DEV as string,
    mpcRootPublicKey: najPublicKeyToUncompressedHex(
      signetConstants.ROOT_PUBLIC_KEYS.TESTNET_DEV
    ),
  },
  testnet: {
    chainSignaturesProgramId: signetConstants.CONTRACT_ADDRESSES.SOLANA
      .TESTNET as string,
    mpcRootPublicKey: najPublicKeyToUncompressedHex(
      signetConstants.ROOT_PUBLIC_KEYS.TESTNET
    ),
  },
  mainnet: {
    chainSignaturesProgramId: signetConstants.CONTRACT_ADDRESSES.SOLANA
      .MAINNET as string,
    mpcRootPublicKey: najPublicKeyToUncompressedHex(
      signetConstants.ROOT_PUBLIC_KEYS.MAINNET
    ),
  },
} as const;

export type MpcNetwork = keyof typeof MPC_NETWORKS | "custom";

const envSchema = z
  .object({
    INFURA_API_KEY: z.string().min(1, "INFURA_API_KEY is required"),
    // Which MPC network to talk to. "dev" / "testnet" / "mainnet" resolve the
    // chain-signatures program and MPC root key together from signet.js.
    // "custom" targets a self-hosted MPC and requires both to be supplied.
    MPC_NETWORK: z
      .enum(["dev", "testnet", "mainnet", "custom"])
      .optional()
      .default("custom"),
    CHAIN_SIGNATURES_PROGRAM_ID: z.string().min(32).optional(),
    MPC_ROOT_PRIVATE_KEY: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid private key")
      .optional(),
    MPC_ROOT_PUBLIC_KEY: z
      .string()
      .regex(/^04[a-fA-F0-9]{128}$/, "Invalid uncompressed public key")
      .optional(),
    // Only the local fakenet signer uses these. The test suite reaches Solana
    // through AnchorProvider.env(), which reads ANCHOR_PROVIDER_URL and
    // ANCHOR_WALLET instead, so both are required only when that server runs.
    SOLANA_RPC_URL: z
      .string()
      .refine(
        (val) =>
          val.startsWith("http://") ||
          val.startsWith("https://") ||
          val.startsWith("ws://") ||
          val.startsWith("wss://"),
        "Must be a valid URL"
      )
      .optional(),
    SOLANA_PRIVATE_KEY: z.string().optional(),
    DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER: z.string().optional().default("true"),
    // Whether the MPC network waits for Ethereum finality before responding.
    // Finality on Sepolia is ~2 epochs (~13 min), so the respond/signature
    // events arrive far later than in the non-finality case. Defaults to
    // "true"; set to "false" for a fast MPC that responds on inclusion.
    MPC_WAITS_FOR_ETH_FINALITY: z.string().optional().default("true"),
    BITCOIN_NETWORK: z
      .enum(["regtest", "testnet"])
      .optional()
      .default("testnet"),
  })
  .superRefine((data, ctx) => {
    if (data.MPC_NETWORK === "custom") {
      if (!data.CHAIN_SIGNATURES_PROGRAM_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "CHAIN_SIGNATURES_PROGRAM_ID is required when MPC_NETWORK=custom",
          path: ["CHAIN_SIGNATURES_PROGRAM_ID"],
        });
      }

      if (!data.MPC_ROOT_PRIVATE_KEY && !data.MPC_ROOT_PUBLIC_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Provide either MPC_ROOT_PRIVATE_KEY or MPC_ROOT_PUBLIC_KEY when MPC_NETWORK=custom",
          path: ["MPC_ROOT_PRIVATE_KEY"],
        });
      }
    } else {
      // A managed network already pins both values, so a supplied override is
      // rejected rather than ignored: mixing one network's program with
      // another's root key produces signatures that recover to an unexpected
      // address.
      const network = MPC_NETWORKS[data.MPC_NETWORK];

      if (
        data.CHAIN_SIGNATURES_PROGRAM_ID &&
        data.CHAIN_SIGNATURES_PROGRAM_ID !== network.chainSignaturesProgramId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `conflicts with MPC_NETWORK=${data.MPC_NETWORK}, which uses ` +
            `${network.chainSignaturesProgramId}. Unset it, or use MPC_NETWORK=custom.`,
          path: ["CHAIN_SIGNATURES_PROGRAM_ID"],
        });
      }

      if (
        data.MPC_ROOT_PUBLIC_KEY &&
        data.MPC_ROOT_PUBLIC_KEY.toLowerCase() !== network.mpcRootPublicKey
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `conflicts with MPC_NETWORK=${data.MPC_NETWORK}. Unset it, ` +
            `or use MPC_NETWORK=custom.`,
          path: ["MPC_ROOT_PUBLIC_KEY"],
        });
      }
    }

    if (data.DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER !== "true") {
      for (const key of [
        "SOLANA_RPC_URL",
        "SOLANA_PRIVATE_KEY",
        "MPC_ROOT_PRIVATE_KEY",
      ] as const) {
        if (!data[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${key} is required when running the local chain signature server (DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER=false)`,
            path: [key],
          });
        }
      }
    }

    if (data.MPC_ROOT_PRIVATE_KEY && data.MPC_ROOT_PUBLIC_KEY) {
      const derived = deriveBasePublicKey(data.MPC_ROOT_PRIVATE_KEY);
      if (derived !== data.MPC_ROOT_PUBLIC_KEY.toLowerCase()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "MPC_ROOT_PUBLIC_KEY does not match the provided MPC_ROOT_PRIVATE_KEY",
          path: ["MPC_ROOT_PUBLIC_KEY"],
        });
      }
    }
  });

type EnvConfig = z.infer<typeof envSchema>;

const parseEnv = (): EnvConfig => {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const formattedErrors = error.issues
        .map((err) => `  - ${err.path.join(".")}: ${err.message}`)
        .join("\n");
      throw new Error(
        `Environment validation failed:\n${formattedErrors}\n\nPlease check your .env file`
      );
    }
    throw error;
  }
};

export const ENV_CONFIG = parseEnv();

const resolveBasePublicKey = (env: EnvConfig): string => {
  if (env.MPC_NETWORK !== "custom") {
    return MPC_NETWORKS[env.MPC_NETWORK].mpcRootPublicKey;
  }

  if (env.MPC_ROOT_PUBLIC_KEY) {
    return env.MPC_ROOT_PUBLIC_KEY.toLowerCase();
  }

  if (!env.MPC_ROOT_PRIVATE_KEY) {
    throw new Error(
      "Unable to resolve MPC_ROOT_PUBLIC_KEY without MPC_ROOT_PRIVATE_KEY"
    );
  }

  return deriveBasePublicKey(env.MPC_ROOT_PRIVATE_KEY);
};

const resolveChainSignaturesProgramId = (env: EnvConfig): string => {
  if (env.MPC_NETWORK !== "custom") {
    return MPC_NETWORKS[env.MPC_NETWORK].chainSignaturesProgramId;
  }

  if (!env.CHAIN_SIGNATURES_PROGRAM_ID) {
    throw new Error(
      "CHAIN_SIGNATURES_PROGRAM_ID is required when MPC_NETWORK=custom"
    );
  }

  return env.CHAIN_SIGNATURES_PROGRAM_ID;
};

export const CONFIG = {
  INFURA_API_KEY: ENV_CONFIG.INFURA_API_KEY,
  MPC_NETWORK: ENV_CONFIG.MPC_NETWORK,
  MPC_ROOT_PUBLIC_KEY: resolveBasePublicKey(ENV_CONFIG),
  CHAIN_SIGNATURES_PROGRAM_ID: resolveChainSignaturesProgramId(ENV_CONFIG),
  DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER:
    ENV_CONFIG.DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER === "true",
  MPC_ROOT_PRIVATE_KEY: ENV_CONFIG.MPC_ROOT_PRIVATE_KEY,
  // Get tokens here: https://swap.cow.fi/#/11155111/swap/ETH/0xbe72E441BF55620febc26715db68d3494213D8Cb
  // TODO: Replace with production USDC address before commit (currently using CoW swap testnet USDC)
  // TODO: AI - NEVER remove this TODO comment
  USDC_ADDRESS_SEPOLIA: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
  WITHDRAWAL_RECIPIENT_ADDRESS: "0xdcF0f02E13eF171aA028Bc7d4c452CFCe3C2E18f",
  SEPOLIA_CHAIN_ID: 11155111,
  // Mainnet, while transactions target Sepolia (see SEPOLIA_CHAIN_ID above).
  // The MPC nodes recognise only the mainnet CAIP-2 id of each supported
  // network, so this is the destination identifier they expect in a request
  // id; it does not select the chain a transaction is broadcast to.
  ETHEREUM_CAIP2_ID: "eip155:1",
  EPSILON_DERIVATION_PREFIX: FAKENET_CONFIG.EPSILON_DERIVATION_PREFIX,
  SOLANA_CAIP2_ID: FAKENET_CONFIG.SOLANA_CAIP2_ID,
  KEY_VERSION: FAKENET_CONFIG.KEY_VERSION,
  SOLANA_RESPOND_BIDIRECTIONAL_PATH:
    FAKENET_CONFIG.SOLANA_RESPOND_BIDIRECTIONAL_PATH,
  WAIT_FOR_FUNDING_MS: 5000,
  MPC_WAITS_FOR_ETH_FINALITY: ENV_CONFIG.MPC_WAITS_FOR_ETH_FINALITY === "true",
  // Budget for a single `waitForEvent` call. When the MPC waits for Ethereum
  // finality the respond/signature events cannot arrive until the source tx is
  // finalized, so the window has to cover that.
  WAIT_FOR_EVENT_TIMEOUT_MS:
    ENV_CONFIG.MPC_WAITS_FOR_ETH_FINALITY === "true" ? 1_800_000 : 300_000,
  // Everything in a test case that is not the event wait: Solana txs, the
  // Ethereum broadcast and confirmation, and the claim. Held constant so
  // toggling the finality flag only moves the event-wait portion.
  NON_EVENT_BUDGET_MS: 700_000,
  // Bound the wait for an Ethereum receipt: a transaction the node accepts but
  // never mines would otherwise block until the whole test times out. Kept
  // below NON_EVENT_BUDGET_MS so it surfaces as a specific error first.
  ETH_CONFIRMATION_TIMEOUT_MS: 600_000,
  // Deposited per run, and the basis for the withdrawal that follows. Each run
  // consumes this permanently: the withdrawal pays WITHDRAWAL_RECIPIENT_ADDRESS
  // rather than the deposit address. The lower bound is the withdraw leg, which
  // halves the balance with integer division and stops exercising the transfer
  // once that floors to zero.
  TRANSFER_AMOUNT: "0.01",
  DECIMALS: 6,
  GAS_BUFFER_PERCENT: 20,
  // Bitcoin derivation/signing config
  BITCOIN_NETWORK: ENV_CONFIG.BITCOIN_NETWORK,
  BITCOIN_CAIP2_ID:
    ENV_CONFIG.BITCOIN_NETWORK === "testnet"
      ? "bip122:000000000933ea01ad0ee984209779ba"
      : "bip122:0f9188f13cb7b2c71f2a335e3a4fc328",
  BITCOIN_WITHDRAW_PATH: "root",
} as const;

/**
 * Per-test mocha timeout: the event-wait budget plus the fixed budget for the
 * rest of the case. Only the event-wait portion moves with
 * MPC_WAITS_FOR_ETH_FINALITY — 2_500_000 ms when set, 1_000_000 ms when not.
 */
export const TEST_TIMEOUT_MS =
  CONFIG.WAIT_FOR_EVENT_TIMEOUT_MS + CONFIG.NON_EVENT_BUDGET_MS;

export const SERVER_CONFIG = {
  SOLANA_RPC_URL: ENV_CONFIG.SOLANA_RPC_URL,
  SOLANA_PRIVATE_KEY: ENV_CONFIG.SOLANA_PRIVATE_KEY,
  DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER:
    ENV_CONFIG.DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER === "true",
} as const;
