
## Local Development

Add the following to your `.dev.vars` file:

```
AWS_DSQL_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"
AWS_DSQL_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"

AWS_DSQL_ENDPOINT_PRIMARY = "REMOVED.dsql.us-east-2.on.aws"
AWS_DSQL_ENDPOINT_SECONDARY = "REMOVED.dsql.us-east-1.on.aws"

CLOUDFLARE_API_KEY_HYPERDRIVE = "CLOUDFLARE_API_KEY_HYPERDRIVE"

CLOUDFLARE_ACCOUNT_ID = "REMOVED"

```

# Local Testing

Visit the following URL:

```
http://localhost:60345/__scheduled?cron=30+15+*+*+*
```
