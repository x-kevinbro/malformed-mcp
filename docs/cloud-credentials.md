# Cloud credentials without putting tokens in chat

Use the authenticated **Cloud Providers** web panel, not an MCP tool argument or a chat message.

1. Open the panel over HTTPS (or a trusted local SSH tunnel) and sign in.
2. Select a built-in provider, including **Koyeb**, or **Custom API (other provider)**.
3. For a custom API, enter a non-secret id, display name and the provider's official HTTPS API base URL. Check the hostname carefully: the credential will be sent to that origin.
4. Choose **Bearer access token**, or **API key / custom authentication header**. For example, `X-API-Key` with no prefix sends the raw key; `Authorization` with prefix `Token` sends `Token <credential>`. A `Basic` prefix requires an already-encoded Basic credential. Never put the secret in the URL, header prefix or account name.
5. Enter the token only in the password field. Accounts default to read-only. Save, then ask the agent to list `cloud_providers` and test a read-only API call. Enable writes only when needed.

The agent uses `cloud_request` with the provider id and optional account name. It does not receive the stored provider token. Custom APIs and the Koyeb preset are marked **unverified** on save; saving is not proof that a token is valid.

## Security and limits

- Custom credentials are restricted to one exact HTTPS origin, including its port. Redirects are refused, and an existing custom id cannot be silently pointed at a different API. Only a signed-in operator can configure this boundary.
- Provider secrets are not returned by account-listing or account-creation APIs, or rendered in panel HTML. Known provider credentials are always scrubbed from MCP text output, including newly added or rotated opaque tokens, even if heuristic output redaction is disabled. This is defense in depth, not a guarantee that every secret created by an API will be detected.
- Account MCP connection tokens are also secrets. They are retrieved only by an explicit signed-in **Copy MCP connection token** action. Paste them into the MCP client's connection settings, never into chat.
- State is stored in the server's runtime credential file with mode `0600`. **It is not encrypted at rest.** The server owner, a compromised server or an administrator with filesystem access can still read it. Secure the host and backups; do not commit runtime files.
- Custom configuration covers static Bearer tokens and API-key/header credentials. OAuth refresh, AWS-style request signing, client certificates, multi-secret authentication and similar schemes require dedicated implementations; “any provider” does not mean every authentication protocol is interchangeable.
- If a token has already been pasted into chat, revoke/rotate it at its issuer. Adding it to this panel does not undo the earlier exposure.

## Applying the change

Merge the code update, rebuild (`npm run build`), and restart/redeploy your MCP server. Existing account records remain compatible. The panel's new cloud-setting mutations require a same-origin browser request; scripts that previously posted directly must use the panel instead. This update does not deploy itself or change any running cloud service.
