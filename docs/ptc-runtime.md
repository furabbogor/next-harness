# PTC runtime

`runPtc` executes a model-authored program in a newly forked Node child and a newly created QuickJS WebAssembly runtime. The parent process communicates with the child using bounded, strict-JSON IPC only. The public API is exported from `src/lib/ptc/runtime.ts`:

- input: code, visible tool names, an abort signal, an async `invoke(name, args, signal)` bridge, optional log observer, and optional limits;
- output: a structured `completed` or `failed` result, captured log lines, duration, and the fixed sandbox descriptor.

Programs are placed in an async function body, so top-level `await` and `return` work. Node's `stripTypeScriptTypes` transforms only erasable TypeScript syntax before evaluation. Tools are async `tools.<name>(jsonArgs)` functions. Tool results and errors are settled back into QuickJS promises, allowing `try`/`catch`, loops, and `Promise.all`.

## Boundary and limits

Every tool argument, tool result, console value, IPC frame, and final return is strict JSON. The bridge rejects values JSON would silently change or omit: BigInts, functions, symbols, cycles, `undefined` properties, array holes, non-finite numbers, and `-0`. An `undefined` final return is represented by `null`.

Defaults are 120 seconds wall time, 5 seconds cumulative QuickJS CPU, 32 MiB QuickJS memory, 64 KiB output, 32 KiB code, 32 calls, and 8 pending calls. Termination aborts the derived bridge signal and kills the child (with a SIGKILL fallback); pending work is never replayed. A program that returns while a tool promise remains pending fails rather than allowing a background side effect.

QuickJS receives no Node globals, filesystem, network, `process`, `require`, or configured module loader. Dynamic imports therefore cannot load modules. This is capability isolation, **not an OS sandbox**: the child is intentionally not advertised as an OS-level containment boundary, and QuickJS is not compatible with the full Node or Python runtime.
