import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell, shq } from "../exec.js";
import { assertWritable, fromExec, fromExecLenient } from "../result.js";
import { audit } from "../logger.js";
import { config } from "../config.js";

export function registerDatabaseTools(server: McpServer): void {
  server.registerTool(
    "db_query",
    {
      title: "Run SQL against Postgres",
      description:
        "Execute SQL inside the Postgres container with psql. Read queries are safe; anything that writes " +
        "should be reviewed with the user first. Wrap risky statements in a transaction.",
      inputSchema: {
        sql: z.string().min(1).describe("SQL statement to execute."),
        container: z.string().optional().describe(`Postgres container. Defaults to ${config.dbContainer}.`),
        database: z.string().optional().describe(`Database name. Defaults to ${config.dbName}.`),
        user: z.string().optional().describe(`Postgres role. Defaults to ${config.dbUser}.`),
        expanded: z.boolean().default(false).describe("Use psql expanded output for wide rows."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ sql, container, database, user, expanded }) => {
      const c = container ?? config.dbContainer;
      const db = database ?? config.dbName;
      const u = user ?? config.dbUser;
      const isWrite = /^\s*(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i.test(sql);
      if (isWrite) assertWritable("db_query");
      audit("db_query", { container: c, database: db, write: isWrite, sql: sql.slice(0, 500) });
      const flags = `-v ON_ERROR_STOP=1 ${expanded ? "-x" : ""}`;
      const result = await runShell(
        `docker exec -i ${shq(c)} psql -U ${shq(u)} -d ${shq(db)} ${flags} -c ${shq(sql)} 2>&1`,
        { timeoutMs: 180_000 },
      );
      return fromExec(result, `psql ${db} — ${sql.slice(0, 120)}`);
    },
  );

  server.registerTool(
    "db_schema",
    {
      title: "Inspect database schema",
      description: "List tables with row estimates and sizes, or describe the columns of one table.",
      inputSchema: {
        table: z.string().optional().describe("Table name. Omit to list every table."),
        container: z.string().optional().describe(`Postgres container. Defaults to ${config.dbContainer}.`),
        database: z.string().optional().describe(`Database name. Defaults to ${config.dbName}.`),
        user: z.string().optional().describe(`Postgres role. Defaults to ${config.dbUser}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ table, container, database, user }) => {
      const c = container ?? config.dbContainer;
      const db = database ?? config.dbName;
      const u = user ?? config.dbUser;
      const psqlCommand = table ? `\\d+ ${table}` : "\\dt+ public.*";
      const result = await runShell(
        `docker exec -i ${shq(c)} psql -U ${shq(u)} -d ${shq(db)} -c ${shq(psqlCommand)} 2>&1`,
        { timeoutMs: 60_000 },
      );
      return fromExecLenient(result, table ? `schema of ${table}` : `tables in ${db}`);
    },
  );

  server.registerTool(
    "db_backup",
    {
      title: "Dump the database",
      description:
        "Create a compressed pg_dump of the database on the host filesystem. Always run this before a migration " +
        "or any destructive SQL.",
      inputSchema: {
        output_path: z
          .string()
          .optional()
          .describe(
            `Where to write the dump. Defaults to ${config.backupDir}/<database>-<timestamp>.sql.gz.`,
          ),
        container: z.string().optional().describe(`Postgres container. Defaults to ${config.dbContainer}.`),
        database: z.string().optional().describe(`Database name. Defaults to ${config.dbName}.`),
        user: z.string().optional().describe(`Postgres role. Defaults to ${config.dbUser}.`),
      },
      annotations: { destructiveHint: false },
    },
    async ({ output_path, container, database, user }) => {
      assertWritable("db_backup");
      const c = container ?? config.dbContainer;
      const db = database ?? config.dbName;
      const u = user ?? config.dbUser;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const out = output_path ?? `${config.backupDir}/${db}-${stamp}.sql.gz`;
      audit("db_backup", { container: c, database: db, output: out });
      const script =
        `set -euo pipefail\n` +
        `mkdir -p "$(dirname ${shq(out)})"\n` +
        `docker exec -i ${shq(c)} pg_dump -U ${shq(u)} -d ${shq(db)} | gzip -9 > ${shq(out)}\n` +
        `ls -lh ${shq(out)}`;
      const result = await runShell(script, { timeoutMs: 1_800_000 });
      return fromExec(result, `pg_dump ${db} → ${out}`);
    },
  );
}
