import { describe, it, expect } from "vitest";
import { transform, MARKER } from "../../scripts/patch-next-flight-then.mjs";

// Shape of Next 15.5's vendored react-server-dom-webpack client (production).
const ORIGINAL = `function x() {}
ReactPromise.prototype.then = function (resolve, reject) {
  switch (this.status) {
    case "resolved_model":
      initializeModelChunk(this);
      break;
  }
  switch (this.status) {
    case "fulfilled":
      "function" === typeof resolve && resolve(this.value);
      break;
    case "pending":
      break;
  }
};
function readChunk(chunk) {}
`;

describe("patch-next-flight-then transform (#1995)", () => {
  it("defers the fulfilled resolve via queueMicrotask", () => {
    const { status, out } = transform(ORIGINAL);
    expect(status).toBe("patched");
    expect(out).toContain(MARKER);
    expect(out).toContain("queueMicrotask(function () {");
    expect(out).not.toContain('"function" === typeof resolve && resolve(this.value);');
    // The patched module still evaluates and resolves asynchronously.
    const ReactPromise = new Function(`function ReactPromise(v) { this.status = "fulfilled"; this.value = v; }
      ${out}; return ReactPromise;`)();
    const calls: unknown[] = [];
    new ReactPromise(42).then((v: unknown) => calls.push(v));
    expect(calls).toEqual([]);
    return Promise.resolve().then(() => expect(calls).toEqual([42]));
  });

  it("is idempotent", () => {
    const once = transform(ORIGINAL).out;
    const twice = transform(once);
    expect(twice.status).toBe("already-patched");
    expect(twice.out).toBe(once);
  });

  it("throws on an unrecognized Flight client", () => {
    const changed = ORIGINAL.replace("resolve(this.value);", "resolveSomehow(this.value);");
    expect(() => transform(changed)).toThrow(/not found/);
    expect(() => transform("no flight here")).toThrow(/not found/);
  });
});
