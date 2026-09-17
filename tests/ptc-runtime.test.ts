import { describe, expect, it } from "vitest";
import { runPtc } from "@/lib/ptc/runtime";

const run = (code: string, extra: Partial<Parameters<typeof runPtc>[0]> = {}) => runPtc({
  code,
  toolNames: ["double", "wait"],
  signal: new AbortController().signal,
  invoke: async (name, args, signal) => {
    signal.throwIfAborted();
    if (name === "double") return (args as { value: number }).value * 2;
    if (name === "wait") return args;
    throw { code: "UNKNOWN_TOOL", message: "Unknown tool" };
  },
  ...extra,
});

describe("PTC QuickJS runtime", () => {
  it("runs isolated JS with erasable TypeScript and loops", async () => {
    const result = await run("let total: number = 0; for (let i = 0; i < 4; i++) total += i; return total;");
    expect(result).toMatchObject({ status: "completed", value: 6, sandbox: { engine: "quickjs-wasm", process: "child", directHostAccess: false } });
  });

  it("bridges sequential and concurrent awaited tools in submission order", async () => {
    const calls: number[] = [];
    const result = await run("const one = tools.double({value: 2}); const two = tools.double({value: 3}); return await Promise.all([one, two]);", {
      invoke: async (_name, args) => { calls.push((args as { value: number }).value); return (args as { value: number }).value * 2; },
    });
    expect(result).toMatchObject({ status: "completed", value: [4, 6] });
    expect(calls).toEqual([2, 3]);
  });

  it("makes binding errors catchable while hiding host exception details", async () => {
    const result = await run("try { await tools.double({value: 1}); } catch (error) { return {code: error.code, readable: String(error).includes('DENIED')}; }", {
      invoke: async () => { throw { code: "DENIED", message: "Not permitted" }; },
    });
    expect(result).toMatchObject({ status: "completed", value: { code: "DENIED", readable: true } });
    await expect(run("try { await tools.double({value: 1}); } catch (error) { return {code: error.code, message: error.message}; }", {
      invoke: async () => { throw new Error("private host credential must not escape"); },
    })).resolves.toMatchObject({ status: "completed", value: { code: "TOOL_ERROR", message: "TOOL_ERROR: The tool failed." } });
  });

  it("captures console output and excludes Node globals", async () => {
    const result = await run("console.log('hello', { count: 2 }); return [typeof process, typeof require, typeof fetch];");
    expect(result).toMatchObject({ status: "completed", value: ["undefined", "undefined", "undefined"], logs: ["hello {\"count\":2}"] });
  });

  it("rejects lossy values and unavailable imports", async () => {
    await expect(run("return { missing: undefined }; ")).resolves.toMatchObject({ status: "failed", error: { code: "LOSSY_DATA" } });
    await expect(run("await import('node:fs'); return 1;")).resolves.toMatchObject({ status: "failed" });
  });

  it("enforces code, CPU, memory/output, call and pending-call limits", async () => {
    await expect(run("return 1", { limits: { maxCodeBytes: 4 } })).resolves.toMatchObject({ status: "failed", error: { code: "CODE_LIMIT" } });
    await expect(run("while (true) {}", { limits: { cpuMs: 20 } })).resolves.toMatchObject({ status: "failed", error: { code: "CPU_LIMIT" } });
    await expect(run("console.log('x'.repeat(100)); return 1", { limits: { maxOutputBytes: 10 } })).resolves.toMatchObject({ status: "failed", error: { code: "OUTPUT_LIMIT" } });
    await expect(run("return await Promise.all([tools.wait(1), tools.wait(2)])", { limits: { maxPendingCalls: 1 } })).resolves.toMatchObject({ status: "failed", error: { code: "PENDING_CALL_LIMIT" } });
    await expect(run("await tools.wait(1); await tools.wait(2); return 0", { limits: { maxCalls: 1 } })).resolves.toMatchObject({ status: "failed", error: { code: "CALL_LIMIT" } });
  });

  it("aborts a pending bridge call and does not permit background calls", async () => {
    const controller = new AbortController();
    let invoked = 0;
    const pending = runPtc({
      code: "tools.wait({ work: true }); return 'done';",
      toolNames: ["wait"], signal: controller.signal,
      invoke: async (_name, _args, signal) => {
        invoked += 1;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return "late";
      },
    });
    const result = await pending;
    expect(result).toMatchObject({ status: "failed", error: { code: "UNAWAITED_TOOL_CALL" } });
    expect(invoked).toBe(1);
  });

  it("cancels a bridge wait using the caller abort signal", async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const bridgeEntered = new Promise<void>((resolve) => { entered = resolve; });
    const resultPromise = runPtc({
      code: "return await tools.wait({ approval: true });",
      toolNames: ["wait"], signal: controller.signal,
      invoke: async (_name, _args, signal) => {
        entered();
        return await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    });
    await bridgeEntered;
    controller.abort();
    await expect(resultPromise).resolves.toMatchObject({ status: "failed", error: { code: "CANCELLED" } });
  });

  it("enforces the VM memory ceiling", async () => {
    await expect(run("const items = []; for (let i = 0; i < 200000; i++) items.push('0123456789'); return items.length;", { limits: { memoryBytes: 1_048_576 } }))
      .resolves.toMatchObject({ status: "failed" });
  });

  it("uses fresh VM state for each run", async () => {
    await expect(run("globalThis.leaked = 9; return leaked;")).resolves.toMatchObject({ status: "completed", value: 9 });
    await expect(run("return typeof leaked;")).resolves.toMatchObject({ status: "completed", value: "undefined" });
  });
});
