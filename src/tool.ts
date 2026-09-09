import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { errorText, fail, ok } from "./result.js";

/**
 * Every tool used to repeat the same shape by hand: registerTool, a try/catch,
 * and a bespoke ok()/fail() wrapper. That boilerplate is where the bugs hid and
 * why adding a tool felt expensive enough to avoid.
 *
 * A tool is now a plain object whose run() returns a string or throws. The
 * plumbing lives here exactly once, so a new tool costs a schema and a body.
 */
export type ToolSpec<S extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  input: S;
  /** Safe to call freely; never mutates the box. */
  readOnly?: boolean;
  /** Can overwrite or remove things. */
  destructive?: boolean;
  run: (args: any) => Promise<string> | string;
};

/**
 * Identity function whose only job is to infer the argument type of run() from
 * the zod shape, so tool bodies get real types without any annotation.
 */
export function defineTool<S extends z.ZodRawShape>(
  spec: Omit<ToolSpec<S>, "run"> & {
    run: (args: z.infer<z.ZodObject<S>>) => Promise<string> | string;
  },
): ToolSpec<S> {
  return spec as ToolSpec<S>;
}

/** Register a list of tools, applying the error handling to all of them. */
export function registerTools(server: McpServer, specs: Array<ToolSpec<any>>): void {
  for (const spec of specs) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.input,
        annotations: {
          readOnlyHint: spec.readOnly ?? false,
          destructiveHint: spec.destructive ?? false,
        },
      } as any,
      (async (args: unknown) => {
        try {
          return ok(await spec.run(args as any));
        } catch (error) {
          return fail(`${spec.name} failed: ${errorText(error)}`);
        }
      }) as any,
    );
  }
}
