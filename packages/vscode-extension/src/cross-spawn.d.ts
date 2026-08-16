declare module "cross-spawn" {
  import type { ChildProcessWithoutNullStreams } from "node:child_process";

  interface CrossSpawn {
    (
      command: string,
      args: readonly string[],
      options: {
        shell: false;
        stdio: ["pipe", "pipe", "pipe"];
      },
    ): ChildProcessWithoutNullStreams;
    sync(
      command: string,
      args: readonly string[],
      options: { timeout: number },
    ): { status: number | null; error?: Error };
  }

  const crossSpawn: CrossSpawn;
  export default crossSpawn;
}
