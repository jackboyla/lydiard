import assert from "node:assert/strict";
import test from "node:test";
import { findOwningPane, parseCsvLine, parseGpuRows, parseProcessRows } from "./monitor.mjs";

test("parseCsvLine handles quoted commas and escaped quotes", () => {
  assert.deepEqual(parseCsvLine('0, "GPU, Prototype", "a ""quoted"" name"'), ["0", "GPU, Prototype", 'a "quoted" name']);
});

test("GPU and process CSV rows become typed monitor data", () => {
  const gpu = parseGpuRows("0, GPU-a, NVIDIA GeForce RTX 5090, 00000000:01:00.0, 51, 98, 42, 19724, 32607, 510.2, 600.0, 42, P1")[0];
  assert.equal(gpu.index, 0);
  assert.equal(gpu.utilizationPercent, 98);
  assert.equal(gpu.memoryTotalMiB, 32607);

  const process = parseProcessRows("GPU-a, 851288, /tmp/python, 19714")[0];
  assert.deepEqual(process, { gpuUuid: "GPU-a", pid: 851288, executable: "/tmp/python", gpuMemoryMiB: 19714 });
});

test("findOwningPane follows the GPU process ancestry", () => {
  const panes = [{ id: "%0", pid: 100 }, { id: "%1", pid: 200 }];
  const parents = new Map([[420, 310], [310, 200], [200, 1]]);
  assert.equal(findOwningPane(420, panes, parents)?.id, "%1");
  assert.equal(findOwningPane(999, panes, parents), null);
});
