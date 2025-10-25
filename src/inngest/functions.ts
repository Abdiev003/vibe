import {
  openai,
  createAgent,
  createTool,
  createNetwork,
  type Tool,
} from "@inngest/agent-kit";
import { Sandbox } from "@e2b/code-interpreter";
import z from "zod";

import { inngest } from "./client";
import { getSandbox, lastAssistantTextMessageContent } from "./utils";
import { PROMPT } from "@/prompt";
import { prisma } from "@/lib/db";

/**
 * Agent state interface that maintains the summary and files throughout the agent's execution
 */
interface AgentState {
  /** Summary of the completed task */
  summary: string;
  /** Map of file paths to their content */
  files: { [path: string]: string };
}

/**
 * Code Agent Function
 *
 * This Inngest function creates and manages an AI coding agent that can:
 * - Execute terminal commands in a sandbox environment
 * - Create and modify files
 * - Read file contents
 * - Generate summaries of completed work
 *
 * The agent runs in an E2B sandbox and uses GPT-4o for intelligent code generation.
 */
export const codeAgentFunction = inngest.createFunction(
  { id: "code-agent" },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    // Step 1: Initialize a new E2B sandbox for isolated code execution
    const sandboxId = await step.run("get-sandbox-id", async () => {
      const sandbox = await Sandbox.create("vibe-nextjs-ali");
      return sandbox.sandboxId;
    });

    // Step 2: Configure the AI coding agent with tools and capabilities
    const codeAgent = createAgent<AgentState>({
      name: "code-agent",
      description: "An expert coding agent",
      system: PROMPT,
      model: openai({
        model: "gpt-4o",
        defaultParameters: {
          temperature: 0.1, // Low temperature for more deterministic code generation
        },
      }),
      tools: [
        /**
         * Terminal Tool
         * Allows the agent to execute shell commands in the sandbox environment
         */
        createTool({
          name: "terminal",
          description: "Use the terminal to run commands.",
          parameters: z.object({
            command: z.string(),
          }),
          handler: async ({ command }) => {
            return await step.run("terminal", async () => {
              // Buffer streams to capture all output for error reporting
              const buffers = { stdout: "", stderr: "" };

              try {
                const sandbox = await getSandbox(sandboxId);
                // Execute command and capture output streams
                const result = await sandbox.commands.run(command, {
                  onStdout: (data) => {
                    buffers.stdout += data;
                  },
                  onStderr: (data) => {
                    buffers.stderr += data;
                  },
                });
                return result.stdout;
              } catch (error) {
                // Log and return comprehensive error information
                console.error(
                  `Command failed: ${error} \nstdout: ${buffers.stdout} \nstderr: ${buffers.stderr}`
                );

                return `Command failed: ${error} \nstdout: ${buffers.stdout} \nstderr: ${buffers.stderr}`;
              }
            });
          },
        }),
        /**
         * Create or Update Files Tool
         * Writes multiple files to the sandbox and maintains state
         */
        createTool({
          name: "createOrUpdateFiles",
          description: "Create or update files in the sandbox",
          parameters: z.object({
            files: z.array(
              z.object({
                path: z.string(),
                content: z.string(),
              })
            ),
          }),
          handler: async (
            { files },
            { step, network }: Tool.Options<AgentState>
          ) => {
            const newFiles = await step?.run(
              "createOrUpdateFiles",
              async () => {
                try {
                  // Retrieve existing files from network state or initialize empty object
                  const updatedFiles = network.state.data.files || {};
                  const sandbox = await getSandbox(sandboxId);

                  // Write each file to sandbox and update state
                  for (const file of files) {
                    await sandbox.files.write(file.path, file.content);
                    updatedFiles[file.path] = file.content;
                  }

                  return updatedFiles;
                } catch (error) {
                  return `Error: ${error}`;
                }
              }
            );

            // Update network state with new file contents
            if (typeof newFiles === "object") {
              network.state.data.files = newFiles;
            }
          },
        }),
        /**
         * Read Files Tool
         * Reads multiple files from the sandbox and returns their contents as JSON
         */
        createTool({
          name: "readFiles",
          description: "Read files from the sandbox",
          parameters: z.object({
            files: z.array(z.string()),
          }),
          handler: async ({ files }, { step, network }) => {
            return await step?.run("readFiles", async () => {
              try {
                const sandbox = await getSandbox(sandboxId);
                const contents = [];

                // Read each file and collect its contents
                for (const file of files) {
                  const content = await sandbox.files.read(file);
                  contents.push({ path: file, content });
                }

                // Return as JSON string for agent consumption
                return JSON.stringify(contents);
              } catch (error) {
                return `Error: ${error}`;
              }
            });
          },
        }),
      ],
      lifecycle: {
        /**
         * onResponse Lifecycle Hook
         * Captures task summaries from agent responses and updates network state
         */
        onResponse: async ({ result, network }) => {
          const lastAssistantMessageText =
            await lastAssistantTextMessageContent(result);

          // Check if the agent has provided a task summary
          if (lastAssistantMessageText && network) {
            if (lastAssistantMessageText.includes("<task_summary>")) {
              // Store the summary in network state to signal task completion
              network.state.data.summary = lastAssistantMessageText;
            }
          }

          return result;
        },
      },
    });

    // Step 3: Create agent network with routing logic
    const network = createNetwork<AgentState>({
      name: "code-agent-network",
      agents: [codeAgent],
      maxIter: 15, // Maximum iterations to prevent infinite loops
      /**
       * Router function determines which agent to run next
       * Stops execution once a summary is present (task completed)
       */
      router: async ({ network }) => {
        const summary = network.state.data.summary;

        // If summary exists, task is complete - stop routing
        if (summary) {
          return;
        }

        // Continue with code agent
        return codeAgent;
      },
    });

    // Step 4: Execute the agent network with user input
    const result = await network.run(event.data.value);

    // Step 5: Validate the result - check if agent completed successfully
    const isError =
      !result.state.data.summary ||
      Object.keys(result.state.data.files || {}).length === 0;

    // Step 6: Get the sandbox URL for accessing the running application
    const sandboxUrl = await step.run("get-sandbox-url", async () => {
      const sandbox = await getSandbox(sandboxId);
      const host = sandbox.getHost(3000); // Default Next.js port
      return `https://${host}`;
    });

    // Step 7: Persist the result to database
    await step.run("save-result", async () => {
      // If task failed, save error message
      if (isError) {
        return await prisma.message.create({
          data: {
            content: "Something went wrong. Please try again.",
            role: "ASSISTANT",
            type: "ERROR",
          },
        });
      }

      // If task succeeded, save result with fragment details
      return await prisma.message.create({
        data: {
          content: result.state.data.summary,
          role: "ASSISTANT",
          type: "RESULT",
          fragment: {
            create: {
              sandboxUrl,
              files: result.state.data.files,
              title: "Fragment",
            },
          },
        },
      });
    });

    // Return final result for function response
    return {
      url: sandboxUrl,
      title: "Fragment",
      files: result.state.data.files,
      summary: result.state.data.summary,
    };
  }
);
