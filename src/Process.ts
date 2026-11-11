/**
 * Run an external program (java, apksigner, aapt2, docker) and collect its output.
 */
import { Data, Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly command: string
  readonly exitCode: number
  readonly output: string
}> {
  override get message() {
    const tail = this.output.trim().split("\n").slice(-15).join("\n")
    return `${this.command} exited with ${this.exitCode}\n${tail}`
  }
}

export interface RunResult {
  readonly exitCode: number
  /** stdout and stderr, interleaved. */
  readonly output: string
}

/** Run a program to completion. Never fails on a non-zero exit; see `runOk`. */
export const run = Effect.fn("run")(function* (
  program: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const command = ChildProcess.make(program, [...args], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env, extendEnv: true } : {}),
  })
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command)
      const [output, exitCode] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
        { concurrency: 2 },
      )
      return { exitCode: Number(exitCode), output } satisfies RunResult
    }),
  )
})

/** Run a program and fail with `CommandFailed` unless it exits 0. */
export const runOk = Effect.fn("runOk")(function* (
  program: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
) {
  const result = yield* run(program, args, options)
  if (result.exitCode !== 0) {
    return yield* new CommandFailed({
      command: [program, ...args].join(" "),
      exitCode: result.exitCode,
      output: result.output,
    })
  }
  return result
})
