import { z } from "zod";
import { defineTool } from "../../tool.js";
import { assertGithubWritable } from "../../result.js";
import { DEFAULT_REPO, ghJson, ghSend, qs } from "../../github/api.js";
import { day, firstLine, pad } from "../../github/format.js";

/**
 * Security alerts: Dependabot, code scanning and secret scanning.
 *
 * Availability depends on the plan. On a private repository under GitHub Free,
 * code scanning and secret scanning are not enabled and answer 403 or 404. That
 * is a plan limitation rather than a broken token, so it is reported as such
 * instead of surfacing as a permissions error.
 */

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function planHint(error: unknown, feature: string): string {
  const message = (error as Error).message;
  if (/\b(403|404)\b/.test(message)) {
    return (
      `${feature} returned no data. On a private repository this usually means the feature is not ` +
      `enabled for the plan rather than a token problem — GitHub Free does not include it for ` +
      `private repos. Underlying error: ${message}`
    );
  }
  return message;
}

export const ghSecurity = defineTool({
  name: "gh_security",
  title: "Dependabot, code scanning and secret scanning alerts",
  description:
    "Read security alerts and dismiss Dependabot ones. Alerts are sorted with the most severe first. " +
    "Secret scanning findings should be treated as live credentials until proven otherwise: rotate " +
    "first, then close the alert.",
  input: {
    method: z.enum(["dependabot", "code_scanning", "secret_scanning", "dismiss_dependabot", "advisories"]),
    repo: z.string().default(DEFAULT_REPO),
    state: z.string().default("open").describe("open, dismissed, fixed, resolved."),
    severity: z.string().optional().describe("Filter, e.g. critical or high."),
    alert_number: z.number().int().optional(),
    reason: z
      .enum(["fix_started", "inaccurate", "no_bandwidth", "not_used", "tolerable_risk"])
      .optional()
      .describe("Required when dismissing."),
    comment: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(30),
  },
  async run({ method, repo, state, severity, alert_number, reason, comment, limit }) {
    switch (method) {
      case "dependabot": {
        try {
          const list: any[] = await ghJson(
            `/repos/${repo}/dependabot/alerts${qs({ state, severity, per_page: limit })}`,
          );
          if (!list.length) return `No ${state} Dependabot alerts.`;
          list.sort(
            (a, b) =>
              (SEVERITY_ORDER[a.security_advisory?.severity] ?? 9) -
              (SEVERITY_ORDER[b.security_advisory?.severity] ?? 9),
          );
          return list
            .map(
              (a) =>
                `#${pad(a.number, 5)} ${pad(a.security_advisory?.severity, 9)} ${pad(
                  a.dependency?.package?.name,
                  26,
                )} ${firstLine(a.security_advisory?.summary, 50)}`,
            )
            .join("\n");
        } catch (error) {
          return planHint(error, "Dependabot alerts");
        }
      }

      case "code_scanning": {
        try {
          const list: any[] = await ghJson(
            `/repos/${repo}/code-scanning/alerts${qs({ state, severity, per_page: limit })}`,
          );
          if (!list.length) return `No ${state} code scanning alerts.`;
          return list
            .map(
              (a) =>
                `#${pad(a.number, 5)} ${pad(a.rule?.security_severity_level ?? a.rule?.severity, 9)} ${pad(
                  a.most_recent_instance?.location?.path,
                  38,
                )} ${firstLine(a.rule?.description, 44)}`,
            )
            .join("\n");
        } catch (error) {
          return planHint(error, "Code scanning");
        }
      }

      case "secret_scanning": {
        try {
          const list: any[] = await ghJson(
            `/repos/${repo}/secret-scanning/alerts${qs({ state, per_page: limit })}`,
          );
          if (!list.length) return `No ${state} secret scanning alerts.`;
          return list
            .map(
              (a) =>
                `#${pad(a.number, 5)} ${pad(a.secret_type_display_name, 30)} ${pad(
                  a.validity ?? "unknown",
                  10,
                )} ${day(a.created_at)}  ${a.html_url}`,
            )
            .join("\n");
        } catch (error) {
          return planHint(error, "Secret scanning");
        }
      }

      case "dismiss_dependabot": {
        assertGithubWritable("gh_security");
        if (!alert_number || !reason) {
          throw new Error("dismiss_dependabot needs 'alert_number' and 'reason'.");
        }
        await ghSend(`/repos/${repo}/dependabot/alerts/${alert_number}`, "PATCH", {
          state: "dismissed",
          dismissed_reason: reason,
          ...(comment ? { dismissed_comment: comment } : {}),
        });
        return `Dismissed Dependabot alert #${alert_number} as ${reason}.`;
      }

      case "advisories": {
        const list: any[] = await ghJson(`/repos/${repo}/security-advisories${qs({ per_page: limit })}`);
        if (!list.length) return "No repository security advisories.";
        return list
          .map((a) => `${pad(a.ghsa_id, 22)} ${pad(a.severity, 9)} ${firstLine(a.summary, 50)}`)
          .join("\n");
      }
    }
  },
});

export const securityTools = [ghSecurity];
