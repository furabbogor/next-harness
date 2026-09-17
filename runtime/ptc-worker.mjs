import { stripTypeScriptTypes } from "node:module";
import { newQuickJSWASMModule, RELEASE_SYNC } from "quickjs-emscripten";

const MAX_FRAME_BYTES = 128 * 1024;
let terminated = false;
let started = false;
let runtime;
let context;
let pending = new Map();
let rootPromise;
let strictCheck;
let limits;
let cpuUsed = 0;
let executionStarted = 0;
let outputBytes = 0;
let terminalFailure;

function isStrictJson(value) {
  const seen = new Set();
  const visit = (candidate, depth) => {
    if (depth > 100) return false;
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return true;
    if (typeof candidate === "number") return Number.isFinite(candidate) && !Object.is(candidate, -0);
    if (typeof candidate !== "object" || seen.has(candidate)) return false;
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        for (let index = 0; index < candidate.length; index += 1) if (!(index in candidate) || !visit(candidate[index], depth + 1)) return false;
        return Object.keys(candidate).length === candidate.length && Object.getOwnPropertySymbols(candidate).length === 0;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(candidate).length !== 0) return false;
      return Object.keys(candidate).every((key) => visit(candidate[key], depth + 1));
    } catch {
      return false;
    } finally {
      seen.delete(candidate);
    }
  };
  return visit(value, 0);
}

function frame(value) {
  if (!isStrictJson(value)) return false;
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_FRAME_BYTES; } catch { return false; }
}

function post(value) {
  if (terminated || !frame(value) || typeof process.send !== "function") return false;
  try { process.send(value); return true; } catch { return false; }
}

function clean() {
  for (const entry of pending.values()) entry.deferred.dispose();
  pending.clear();
  try { strictCheck?.dispose(); } catch {}
  try { rootPromise?.dispose(); } catch {}
  try { context?.dispose(); } catch {}
  try { runtime?.dispose(); } catch {}
}

function finish(status, valueOrCode, message) {
  if (terminated) return;
  const result = status === "completed"
    ? { type: "result", status, value: valueOrCode }
    : { type: "result", status, code: valueOrCode, message };
  post(result); // post deliberately happens before disposal and disconnect.
  terminated = true;
  clean();
  if (process.connected) process.disconnect();
  setTimeout(() => process.exit(0), 10).unref();
}

function fail(code, message) {
  finish("failed", code, message);
}

function now() { return performance.now(); }
function runVm(fn) {
  executionStarted = now();
  try { return fn(); } finally { cpuUsed += now() - executionStarted; executionStarted = 0; }
}

function executeJobs() {
  if (terminated) return;
  const result = runVm(() => runtime.executePendingJobs());
  if ("error" in result) result.error.dispose();
}

function checkedDump(handle, allowUndefined = false) {
  if (allowUndefined && context.typeof(handle) === "undefined") return undefined;
  const checked = runVm(() => context.callFunction(strictCheck, context.undefined, handle));
  if ("error" in checked) { checked.error.dispose(); throw new Error("lossy"); }
  const valid = context.getNumber(checked.value);
  checked.value.dispose();
  if (valid !== 1) throw new Error("lossy");
  const value = context.dump(handle);
  if (!isStrictJson(value)) throw new Error("lossy");
  return value;
}

function guestError(code, message) {
  const error = context.newError({ name: "Error", message: `${code}: ${message}` });
  const codeValue = context.newString(code);
  context.setProp(error, "code", codeValue);
  codeValue.dispose();
  return error;
}

function rejectImmediately(code, message) {
  const deferred = context.newPromise();
  const error = guestError(code, message);
  deferred.reject(error);
  error.dispose();
  return deferred.handle;
}

function log(...handles) {
  try {
    const values = handles.map((handle) => checkedDump(handle));
    const line = values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ");
    const bytes = Buffer.byteLength(line, "utf8");
    outputBytes += bytes;
    if (outputBytes > limits.maxOutputBytes) {
      terminalFailure = ["OUTPUT_LIMIT", "The script exceeded its output limit."];
      throw new Error("output limit");
    }
    if (!post({ type: "log", line })) throw new Error("bridge");
    return context.undefined;
  } catch {
    return guestError("LOSSY_DATA", "Console output must be strict JSON data.");
  }
}

function makeTool(name, visibleNames) {
  return context.newFunction(name, (...handles) => {
    if (terminated) return rejectImmediately("RUNTIME_STOPPED", "The script runtime has stopped.");
    if (!visibleNames.has(name)) return rejectImmediately("TOOL_UNAVAILABLE", "This tool is not available to the script.");
    if (handles.length !== 1) return rejectImmediately("TOOL_ARGUMENTS", "Tools accept exactly one JSON argument.");
    let args;
    try { args = checkedDump(handles[0]); } catch { return rejectImmediately("LOSSY_DATA", "Tool arguments must be strict JSON data."); }
    if (pending.size >= limits.maxPendingCalls) {
      terminalFailure = ["PENDING_CALL_LIMIT", "The script exceeded its pending-call limit."];
      return rejectImmediately("PENDING_CALL_LIMIT", "Too many tool calls are pending.");
    }
    if (pending.callCount >= limits.maxCalls) {
      terminalFailure = ["CALL_LIMIT", "The script exceeded its host-call limit."];
      return rejectImmediately("CALL_LIMIT", "The host-call limit was reached.");
    }
    pending.callCount += 1;
    const id = String(pending.nextId++);
    const deferred = context.newPromise();
    pending.set(id, { deferred });
    if (!post({ type: "call", id, name, args })) {
      pending.delete(id);
      deferred.dispose();
      return rejectImmediately("BRIDGE_ERROR", "The tool bridge is unavailable.");
    }
    return deferred.handle;
  });
}

function installGlobals(toolNames) {
  // A guest-side test prevents ctx.dump from silently dropping undefined fields,
  // holes, BigInts, symbols, cycles, non-finite numbers, or -0.
  const checkSource = `(function(v){
    var seen=[];
    function visit(x){
      if(x===null||typeof x==='string'||typeof x==='boolean') return true;
      if(typeof x==='number') return isFinite(x)&&!Object.is(x,-0);
      if(typeof x!=='object'||seen.indexOf(x)!==-1) return false;
      seen.push(x);
      try {
        if(Array.isArray(x)) {
          for(var i=0;i<x.length;i++) if(!(i in x)||!visit(x[i])) return false;
          return Object.keys(x).length===x.length&&Object.getOwnPropertySymbols(x).length===0;
        }
        var p=Object.getPrototypeOf(x);
        if(p!==Object.prototype&&p!==null||Object.getOwnPropertySymbols(x).length) return false;
        var keys=Object.keys(x); for(var j=0;j<keys.length;j++) if(!visit(x[keys[j]])) return false;
        return true;
      } finally { seen.pop(); }
    }
    return visit(v)?1:0;
  })`;
  const checkResult = runVm(() => context.evalCode(checkSource, "ptc-internal.js"));
  if ("error" in checkResult) throw new Error("internal");
  strictCheck = checkResult.value;
  const tools = context.newObject();
  const names = new Set(toolNames);
  for (const name of toolNames) {
    const fn = makeTool(name, names);
    context.setProp(tools, name, fn);
    fn.dispose();
  }
  context.setProp(context.global, "tools", tools);
  tools.dispose();
  const consoleObject = context.newObject();
  const logFunction = context.newFunction("log", log);
  context.setProp(consoleObject, "log", logFunction);
  context.setProp(context.global, "console", consoleObject);
  logFunction.dispose();
  consoleObject.dispose();
}

async function start(message) {
  limits = message.limits;
  pending.callCount = 0;
  pending.nextId = 1;
  try {
    // Strip inside a function so TypeScript's parser accepts the documented top-level return.
    const strippedFunction = stripTypeScriptTypes(`async function __ptc_main__() {\n${message.code}\n}`, { mode: "transform", sourceMap: false });
    const quickjs = await newQuickJSWASMModule(RELEASE_SYNC);
    if (terminated) return;
    runtime = quickjs.newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(Math.min(1024 * 1024, Math.max(64 * 1024, Math.floor(limits.memoryBytes / 8))));
    runtime.setInterruptHandler(() => {
      const exceeded = cpuUsed + (executionStarted ? now() - executionStarted : 0) > limits.cpuMs;
      if (exceeded) terminalFailure = ["CPU_LIMIT", "The script exceeded its CPU limit."];
      return exceeded;
    });
    context = runtime.newContext();
    installGlobals(message.toolNames);
    const evaluated = runVm(() => context.evalCode(`(${strippedFunction})()`, "ptc.ts"));
    if ("error" in evaluated) { evaluated.error.dispose(); return fail(terminalFailure?.[0] ?? "SCRIPT_ERROR", terminalFailure?.[1] ?? "The script failed."); }
    rootPromise = evaluated.value;
    const completion = context.resolvePromise(rootPromise);
    executeJobs();
    completion.then((result) => {
      if (terminated) { if ("value" in result) result.value.dispose(); else result.error.dispose(); return; }
      if ("error" in result) { result.error.dispose(); return fail(terminalFailure?.[0] ?? "SCRIPT_ERROR", terminalFailure?.[1] ?? "The script failed."); }
      let value;
      try { value = checkedDump(result.value, true); } catch { result.value.dispose(); return fail("LOSSY_DATA", "The script returned data that cannot cross the sandbox boundary."); }
      result.value.dispose();
      if (pending.size) return fail("UNAWAITED_TOOL_CALL", "The script ended with pending tool calls.");
      const bytes = Buffer.byteLength(JSON.stringify(value === undefined ? null : value), "utf8");
      if (outputBytes + bytes > limits.maxOutputBytes) return fail("OUTPUT_LIMIT", "The script exceeded its output limit.");
      finish("completed", value === undefined ? null : value);
    }).catch(() => fail("SCRIPT_ERROR", "The script failed."));
  } catch {
    fail("INITIALIZATION_ERROR", "The script runtime could not execute the script.");
  }
}

function validStart(message) {
  const l = message?.limits;
  return message && message.type === "start" && typeof message.code === "string" && Array.isArray(message.toolNames)
    && message.toolNames.every((name) => typeof name === "string" && name.length > 0 && name.length <= 128)
    && l && ["timeoutMs", "cpuMs", "memoryBytes", "maxOutputBytes", "maxCodeBytes", "maxCalls", "maxPendingCalls"].every((key) => Number.isSafeInteger(l[key]));
}

process.on("message", (message) => {
  if (terminated) return;
  if (!frame(message)) return fail("IPC_PROTOCOL", "The script runtime received an invalid request.");
  if (!started) {
    if (!validStart(message)) return fail("IPC_PROTOCOL", "The script runtime received an invalid request.");
    started = true;
    void start(message);
    return;
  }
  if (message.type === "terminate") return fail("CANCELLED", "The run was stopped.");
  if (message.type !== "tool_result" || typeof message.id !== "string" || typeof message.ok !== "boolean") return fail("IPC_PROTOCOL", "The script runtime received an invalid bridge message.");
  const entry = pending.get(message.id);
  if (!entry) return fail("IPC_PROTOCOL", "The script runtime received an unknown tool result.");
  pending.delete(message.id);
  try {
    if (message.ok) {
      if (!isStrictJson(message.value)) throw new Error("bad value");
      const json = JSON.stringify(message.value);
      const valueResult = runVm(() => context.evalCode(`JSON.parse(${JSON.stringify(json)})`, "ptc-bridge.json"));
      if ("error" in valueResult) { valueResult.error.dispose(); throw new Error("bad value"); }
      entry.deferred.resolve(valueResult.value);
      valueResult.value.dispose();
    } else {
      if (!message.error || typeof message.error.code !== "string" || typeof message.error.message !== "string") throw new Error("bad error");
      const error = guestError(message.error.code.slice(0, 64), message.error.message.slice(0, 500));
      entry.deferred.reject(error);
      error.dispose();
    }
    executeJobs();
  } catch {
    entry.deferred.dispose();
    fail("IPC_PROTOCOL", "The script runtime received an invalid tool result.");
  }
});
