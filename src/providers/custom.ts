/** Non-secret API configuration accepted only through the authenticated panel. */
import net from "node:net";
import { isPrivateAddress } from "../net-guard.js";
import { allProviderSpecs, type ProviderSpec } from "./spec.js";

export function customProviderSpec(input: unknown): ProviderSpec {
  if (!input || typeof input !== "object")
    throw new Error("Custom API settings are required.");
  const body = input as Record<string, unknown>;
  const id = String(body.id ?? "")
    .trim()
    .toLowerCase();
  const name = String(body.name ?? "").trim();
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id)) {
    throw new Error(
      "Custom API id must start with a letter and contain only letters, digits and hyphens (max 48).",
    );
  }
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error("Enter a custom API display name (max 80 characters).");
  }
  let base: URL;
  try {
    base = new URL(String(body.baseUrl ?? ""));
  } catch {
    throw new Error("Enter the public HTTPS API base URL.");
  }
  const host = base.hostname.replace(/^\[|\]$/g, "");
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    (net.isIP(host) && isPrivateAddress(host))
  ) {
    throw new Error(
      "Use a public HTTPS base URL without credentials, query parameters or a fragment.",
    );
  }
  const auth = String(body.auth ?? "bearer");
  if (auth !== "bearer" && auth !== "header")
    throw new Error(
      "Choose Bearer token or API-key/custom header authentication.",
    );
  const header = String(body.header ?? "").trim();
  const prefix = String(body.prefix ?? "").trim();
  if (
    auth === "header" &&
    (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(header) ||
      /^(host|cookie|set-cookie|connection|content-length|transfer-encoding|proxy-authorization|accept|content-type|user-agent)$/i.test(
        header,
      ))
  ) {
    throw new Error(
      "Use an authentication header such as X-API-Key or Authorization, not a transport header.",
    );
  }
  if (prefix && !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(prefix))
    throw new Error(
      "Header prefix must be a short authentication scheme, or empty.",
    );
  const spec: ProviderSpec = {
    id: `custom-${id}`,
    name,
    baseUrl: base.href.replace(/\/+$/, ""),
    hosts: [base.hostname],
    origins: [base.origin],
    auth:
      auth === "bearer"
        ? [{ type: "bearer" }]
        : [{ type: "header", header, ...(prefix ? { prefix } : {}) }],
    tokenLabel: "Access token / API key",
  };
  const existing = allProviderSpecs().find((p) => p.id === spec.id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(spec)) {
    throw new Error(
      "That custom API id already has different settings. Use the existing settings or a new id; other accounts' credential destinations cannot be changed.",
    );
  }
  return spec;
}
