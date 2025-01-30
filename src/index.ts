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

/**
 * Generate a presigned “dsql” connection URL (minus the “https://” prefix)
 *
 * @param yourClusterEndpoint The domain portion of the cluster endpoint (e.g. "...dsql.us-east-1.on.aws")
 * @param region              The AWS Region (e.g. "us-east-1")
 * @param action              Either "DbConnectAdmin" or "DbConnect"
 * @param accessKeyId         Your AWS Access Key ID
 * @param secretAccessKey     Your AWS Secret Access Key
 * @param sessionToken        (Optional) Your AWS Session Token if using temporary credentials
 * @return                    The signed URL (minus the https:// prefix)
 */
export async function generateDbConnectAdminAuthToken(
    yourClusterEndpoint: string,
    region: string,
    action: string,
    accessKeyId: string,
    secretAccessKey: string,
    sessionToken?: string
  ): Promise<string> {
    // Build the base URL (the scheme is included for signing; we’ll slice it off later)
    const url = new URL(`https://${yourClusterEndpoint}`);
  
    // Add the required “Action” query parameter
    url.searchParams.set('Action', action);
  
    url.searchParams.set('X-Amz-Expires', '604800'); // 1 week is the max accepted.

    // Create a signer that will produce a presigned URL in the query string
    const signer = new AwsV4Signer({
        url: url.toString(),
        method: 'GET',
        service: 'dsql',
        region,
        accessKeyId,
        secretAccessKey,
        sessionToken,
        signQuery: true, // Important: this actually places the signature in the query string
    });
  
    // Sign and retrieve the final presigned URL
    const { url: signedUrl } = await signer.sign();
  
    // Return everything after "https://"
    return signedUrl.toString().substring('https://'.length);
  }

  export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
        return new Response(null, {status: 404});
    },
    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
        console.debug("invoking cron");

        const client = new Cloudflare({
            apiToken: env.CLOUDFLARE_API_KEY_HYPERDRIVE,
        });

        const CONFIG_NAMES = {
            PRIMARY: 'dsql-demo-primary',
            SECONDARY: 'dsql-demo-secondary'
        };

        // Track which configurations we find
        let foundPrimary = false;
        let foundSecondary = false;

        // Collect all configs
        for await (const config of client.hyperdrive.configs.list({
            account_id: env.CLOUDFLARE_ACCOUNT_ID,
        })) {
            if (config.name === CONFIG_NAMES.PRIMARY) {
                foundPrimary = true;
                console.log(`Found primary endpoint configuration: ${config.name}`);
            }
            if (config.name === CONFIG_NAMES.SECONDARY) {
                foundSecondary = true;
                console.log(`Found secondary endpoint configuration: ${config.name}`);
            }
        }

        // Check for missing configurations
        if (!foundPrimary) {
            console.log(`Creating configuration for primary endpoint: ${env.AWS_DSQL_ENDPOINT_PRIMARY}`);

            const password = await generateDbConnectAdminAuthToken(
                env.AWS_DSQL_ENDPOINT_PRIMARY,
                env.AWS_DSQL_REGION_PRIMARY,
                'DbConnectAdmin',
                env.AWS_DSQL_ACCESS_KEY_ID,
                env.AWS_DSQL_SECRET_ACCESS_KEY
            );
            const config = await client.hyperdrive.configs.create({
                account_id: env.CLOUDFLARE_ACCOUNT_ID,
                name: CONFIG_NAMES.PRIMARY,
                origin: {
                    database: 'postgres',
                    host: env.AWS_DSQL_ENDPOINT_PRIMARY,
                    password: password,
                    port: 5432,
                    scheme: 'postgres',
                    user: 'admin',
                },
            });
            console.debug(`Created primary configuration: ${config.name}`);
        }

        if (!foundSecondary) {
            console.log(`Creating configuration for secondary endpoint: ${env.AWS_DSQL_ENDPOINT_SECONDARY}`);

            const password = await generateDbConnectAdminAuthToken(
                env.AWS_DSQL_ENDPOINT_SECONDARY,
                env.AWS_DSQL_REGION_SECONDARY,
                'DbConnectAdmin',
                env.AWS_DSQL_ACCESS_KEY_ID,
                env.AWS_DSQL_SECRET_ACCESS_KEY
            );
            const config = await client.hyperdrive.configs.create({
                account_id: env.CLOUDFLARE_ACCOUNT_ID,
                name: CONFIG_NAMES.SECONDARY,
                origin: {
                    database: 'postgres',
                    host: env.AWS_DSQL_ENDPOINT_SECONDARY,
                    password: password,
                    port: 5432,
                    scheme: 'postgres',
                    user: 'admin',
                },
            });
            console.debug(`Created secondary configuration: ${config.name}`);
        }

        if (foundPrimary && foundSecondary) {
            console.log("All required endpoints are configured in Hyperdrive");
        }
    }
};