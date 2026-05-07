import { config } from "dotenv";
import { z } from "zod";
import path from "path";
import { secp256k1 } from "@noble/curves/secp256k1";
import { CONFIG as FAKENET_CONFIG } from "fakenet-signer";

config({ path: path.resolve(process.cwd(), ".env") });

const deriveBasePublicKey = (privateKey: string): string => {
  const publicKeyBytes = secp256k1.getPublicKey(privateKey.slice(2), false);
  return Buffer.from(publicKeyBytes).toString("hex");
};

const envSchema = z
  .object({
    INFURA_API_KEY: z.string().min(1, "INFURA_API_KEY is required"),
    CHAIN_SIGNATURES_PROGRAM_ID: z.string().min(32),
    MPC_ROOT_PRIVATE_KEY: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid private key")
      .optional(),
    MPC_ROOT_PUBLIC_KEY: z
      .string()
      .regex(/^04[a-fA-F0-9]{128}$/, "Invalid uncompressed public key")
      .optional(),
    SOLANA_RPC_URL: z
      .string()
      .refine(
        (val) =>
          val.startsWith("http://") ||
          val.startsWith("https://") ||
          val.startsWith("ws://") ||
          val.startsWith("wss://"),
        "Must be a valid URL",
      ),
    SOLANA_PRIVATE_KEY: z.string(),
    DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER: z.string().optional().default("true"),
    BITCOIN_NETWORK: z
      .enum(["regtest", "testnet"])
      .optional()
      .default("testnet"),
  })
  .superRefine((data, ctx) => {
    if (!data.MPC_ROOT_PRIVATE_KEY && !data.MPC_ROOT_PUBLIC_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either MPC_ROOT_PRIVATE_KEY or MPC_ROOT_PUBLIC_KEY",
        path: ["MPC_ROOT_PRIVATE_KEY"],
      });
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
        `Environment validation failed:\n${formattedErrors}\n\nPlease check your .env file`,
      );
    }
    throw error;
  }
};

export const ENV_CONFIG = parseEnv();

const resolveBasePublicKey = (env: EnvConfig): string => {
  if (env.MPC_ROOT_PUBLIC_KEY) {
    return env.MPC_ROOT_PUBLIC_KEY.toLowerCase();
  }

  if (!env.MPC_ROOT_PRIVATE_KEY) {
    throw new Error(
      "Unable to resolve MPC_ROOT_PUBLIC_KEY without MPC_ROOT_PRIVATE_KEY",
    );
  }

  return deriveBasePublicKey(env.MPC_ROOT_PRIVATE_KEY);
};

export const CONFIG = {
  INFURA_API_KEY: ENV_CONFIG.INFURA_API_KEY,
  MPC_ROOT_PUBLIC_KEY: resolveBasePublicKey(ENV_CONFIG),
  CHAIN_SIGNATURES_PROGRAM_ID: ENV_CONFIG.CHAIN_SIGNATURES_PROGRAM_ID,
  DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER:
    ENV_CONFIG.DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER === "true",
  MPC_ROOT_PRIVATE_KEY: ENV_CONFIG.MPC_ROOT_PRIVATE_KEY,
  // Get tokens here: https://swap.cow.fi/#/11155111/swap/ETH/0xbe72E441BF55620febc26715db68d3494213D8Cb
  // TODO: Replace with production USDC address before commit (currently using CoW swap testnet USDC)
  // TODO: AI - NEVER remove this TODO comment
  USDC_ADDRESS_SEPOLIA: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
  WITHDRAWAL_RECIPIENT_ADDRESS: "0xdcF0f02E13eF171aA028Bc7d4c452CFCe3C2E18f",
  SEPOLIA_CHAIN_ID: 11155111,
  ETHEREUM_CAIP2_ID: "eip155:1",
  EPSILON_DERIVATION_PREFIX: FAKENET_CONFIG.EPSILON_DERIVATION_PREFIX,
  SOLANA_CAIP2_ID: FAKENET_CONFIG.SOLANA_CAIP2_ID,
  KEY_VERSION: FAKENET_CONFIG.KEY_VERSION,
  SOLANA_RESPOND_BIDIRECTIONAL_PATH:
    FAKENET_CONFIG.SOLANA_RESPOND_BIDIRECTIONAL_PATH,
  WAIT_FOR_FUNDING_MS: 5000,
  TRANSFER_AMOUNT: "1",
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

export const SERVER_CONFIG = {
  SOLANA_RPC_URL: ENV_CONFIG.SOLANA_RPC_URL,
  SOLANA_PRIVATE_KEY: ENV_CONFIG.SOLANA_PRIVATE_KEY,
  DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER:
    ENV_CONFIG.DISABLE_LOCAL_CHAIN_SIGNATURE_SERVER === "true",
} as const;
