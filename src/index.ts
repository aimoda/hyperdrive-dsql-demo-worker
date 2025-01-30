import Cloudflare from 'cloudflare';
import { AwsV4Signer } from "aws4fetch";

export interface Env {
  ENVIRONMENT: string;
  AWS_DSQL_REGION_PRIMARY: string;
  AWS_DSQL_REGION_SECONDARY: string;
  AWS_DSQL_ACCESS_KEY_ID: string;
  AWS_DSQL_SECRET_ACCESS_KEY: string;
  AWS_DSQL_ENDPOINT_PRIMARY: string;
  AWS_DSQL_ENDPOINT_SECONDARY: string;
  CLOUDFLARE_API_KEY_HYPERDRIVE: string;
  CLOUDFLARE_API_KEY: string;
  CLOUDFLARE_ACCOUNT_ID: string;
}

interface EndpointConfig {
  configName: string;
  host: string;
  region: string;
}

interface HyperdriveOrigin {
  scheme: "postgres" | "postgresql";
  database: string;
  user: string;
  host: string;
  port: number;
  password: string;
}

/**
 * Generate a presigned "dsql" connection URL (minus the "https://" prefix)
 */
export async function generateDbConnectAdminAuthToken(
  yourClusterEndpoint: string,
  region: string,
  action: string,
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken?: string
): Promise<string> {
  const url = new URL(`https://${yourClusterEndpoint}`);
  url.searchParams.set('Action', action);
  url.searchParams.set('X-Amz-Expires', '604800'); // 1 week is the max accepted.

  const signer = new AwsV4Signer({
    url: url.toString(),
    method: 'GET',
    service: 'dsql',
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    signQuery: true, // puts the signature in the query string
  });

  const { url: signedUrl } = await signer.sign();
  return signedUrl.toString().substring('https://'.length);
}

async function upsertConfig(
  client: Cloudflare,
  accountId: string,
  endpoint: EndpointConfig,
  existingConfig: any | undefined,
  password: string
) {
  const origin: HyperdriveOrigin = {
    scheme: 'postgres',
    database: 'postgres',
    user: 'admin',
    host: endpoint.host,
    port: 5432,
    password,
  };

  if (existingConfig) {
    console.log(`Found existing endpoint config "${endpoint.configName}" ... updating`);
    const response = await client.hyperdrive.configs.edit(existingConfig.id, {
      account_id: accountId,
      origin,
    });
    console.log(`Updated configuration: ${endpoint.configName}`);
    return response;
  }

  console.log(`Creating configuration for endpoint "${endpoint.configName}"`);
  const response = await client.hyperdrive.configs.create({
    account_id: accountId,
    name: endpoint.configName,
    origin,
  });
  console.log(`Created new configuration: ${endpoint.configName}`);
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return new Response(null, { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    console.log("Starting Hyperdrive configuration update...");

    const client = new Cloudflare({
      apiToken: env.CLOUDFLARE_API_KEY_HYPERDRIVE,
    });

    const endpoints: EndpointConfig[] = [
      {
        configName: "dsql-demo-primary",
        host: env.AWS_DSQL_ENDPOINT_PRIMARY,
        region: env.AWS_DSQL_REGION_PRIMARY,
      },
      {
        configName: "dsql-demo-secondary",
        host: env.AWS_DSQL_ENDPOINT_SECONDARY,
        region: env.AWS_DSQL_REGION_SECONDARY,
      },
    ];

    // Generate tokens in parallel
    console.log("Generating authentication tokens...");
    const tokenPromises = endpoints.map((ep) =>
      generateDbConnectAdminAuthToken(
        ep.host,
        ep.region,
        "DbConnectAdmin",
        env.AWS_DSQL_ACCESS_KEY_ID,
        env.AWS_DSQL_SECRET_ACCESS_KEY
      )
    );

    // Collect all existing configs in one pass
    console.log("Collecting existing configurations...");
    const existingConfigs: Record<string, any> = {};
    for await (const config of client.hyperdrive.configs.list({
      account_id: env.CLOUDFLARE_ACCOUNT_ID,
    })) {
      existingConfigs[config.name] = config;
    }
    const tokens = await Promise.all(tokenPromises);

    // Upsert configs in parallel
    console.log("Updating Hyperdrive configurations...");
    await Promise.all(
      endpoints.map((ep, index) =>
        upsertConfig(
          client,
          env.CLOUDFLARE_ACCOUNT_ID,
          ep,
          existingConfigs[ep.configName],
          tokens[index]
        )
      )
    );

    console.log("Hyperdrive configuration update complete!");
  },
};