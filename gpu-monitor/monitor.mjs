import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GPU_FIELDS = [
  "index",
  "uuid",
  "name",
  "pci.bus_id",
  "temperature.gpu",
  "utilization.gpu",
  "utilization.memory",
  "memory.used",
  "memory.total",
  "power.draw",
  "power.limit",
  "fan.speed",
  "pstate",
];
const PROCESS_FIELDS = ["gpu_uuid", "pid", "process_name", "used_gpu_memory"];

async function run(command, args, timeout = 2_000) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout,
  });
  return stdout;
}

export function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }

  values.push(value.trim());
  return values;
}

function parseRows(output, fields) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const values = parseCsvLine(line);
      return Object.fromEntries(fields.map((field, index) => [field, values[index] ?? ""]));
    });
}

function asNumber(value) {
  if (!value || value === "N/A" || value === "[Not Supported]") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseGpuRows(output) {
  return parseRows(output, GPU_FIELDS).map((row) => ({
    index: Number.parseInt(row.index, 10),
    uuid: row.uuid,
    name: row.name,
    busId: row["pci.bus_id"],
    temperatureC: asNumber(row["temperature.gpu"]),
    utilizationPercent: asNumber(row["utilization.gpu"]),
    memoryUtilizationPercent: asNumber(row["utilization.memory"]),
    memoryUsedMiB: asNumber(row["memory.used"]),
    memoryTotalMiB: asNumber(row["memory.total"]),
    powerDrawW: asNumber(row["power.draw"]),
    powerLimitW: asNumber(row["power.limit"]),
    fanPercent: asNumber(row["fan.speed"]),
    performanceState: row.pstate,
    processes: [],
  }));
}

export function parseProcessRows(output) {
  return parseRows(output, PROCESS_FIELDS)
    .map((row) => ({
      gpuUuid: row.gpu_uuid,
      pid: Number.parseInt(row.pid, 10),
      executable: row.process_name,
      gpuMemoryMiB: asNumber(row.used_gpu_memory),
    }))
    .filter((process) => Number.isInteger(process.pid));
}

function parsePsLine(line) {
  const match = line.trim().match(
    /^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s*(.*)$/,
  );
  if (!match) return null;
  return {
    pid: Number.parseInt(match[1], 10),
    parentPid: Number.parseInt(match[2], 10),
    user: match[3],
    state: match[4],
    elapsed: match[5],
    cpuPercent: Number.parseFloat(match[6]),
    memoryPercent: Number.parseFloat(match[7]),
    residentMemoryKiB: Number.parseInt(match[8], 10),
    command: match[9],
  };
}

async function getProcessDetails(pids) {
  if (!pids.length) return new Map();
  const output = await run(
    "ps",
    ["-o", "pid=,ppid=,user=,stat=,etime=,%cpu=,%mem=,rss=,args=", "-p", pids.join(",")],
    1_500,
  );
  const details = new Map();

  await Promise.all(
    output
      .split("\n")
      .map(parsePsLine)
      .filter(Boolean)
      .map(async (process) => {
        try {
          process.cwd = await readlink(`/proc/${process.pid}/cwd`);
        } catch {
          process.cwd = null;
        }
        try {
          process.stdoutTarget = await readlink(`/proc/${process.pid}/fd/1`);
        } catch {
          process.stdoutTarget = null;
        }
        details.set(process.pid, process);
      }),
  );
  return details;
}

function parseProcStat(stat) {
  const closingParen = stat.lastIndexOf(")");
  if (closingParen < 0) return null;
  const fields = stat.slice(closingParen + 2).split(" ");
  return { parentPid: Number.parseInt(fields[1], 10) };
}

async function getParentMap() {
  const entries = await readdir("/proc", { withFileTypes: true });
  const parentMap = new Map();
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        try {
          const stat = parseProcStat(await readFile(`/proc/${entry.name}/stat`, "utf8"));
          if (stat) parentMap.set(Number.parseInt(entry.name, 10), stat.parentPid);
        } catch {
          // Processes can disappear while /proc is being sampled.
        }
      }),
  );
  return parentMap;
}

export function findOwningPane(pid, panes, parentMap) {
  const ancestors = new Set();
  let current = pid;
  while (current > 0 && !ancestors.has(current)) {
    ancestors.add(current);
    current = parentMap.get(current) ?? 0;
  }
  return panes.find((pane) => ancestors.has(pane.pid)) ?? null;
}

async function getTmuxPanes() {
  try {
    const output = await run(
      "tmux",
      [
        "list-panes",
        "-a",
        "-F",
        "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_title}",
      ],
      1_500,
    );
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [session, window, pane, id, pid, path, command, title] = line.split("\t");
        return {
          session,
          window: Number.parseInt(window, 10),
          pane: Number.parseInt(pane, 10),
          id,
          pid: Number.parseInt(pid, 10),
          path,
          command,
          title,
          label: `${session}:${window}.${pane}`,
        };
      });
  } catch {
    return [];
  }
}

async function capturePane(pane) {
  try {
    const output = await run("tmux", ["capture-pane", "-p", "-t", pane.id, "-S", "-180"], 1_500);
    return { ...pane, output: output.replace(/\s+$/u, "") };
  } catch (error) {
    return { ...pane, output: "", error: error.message };
  }
}

async function queryNvidia() {
  const [gpuOutput, processOutput] = await Promise.all([
    run("nvidia-smi", [`--query-gpu=${GPU_FIELDS.join(",")}`, "--format=csv,noheader,nounits"]),
    run("nvidia-smi", [`--query-compute-apps=${PROCESS_FIELDS.join(",")}`, "--format=csv,noheader,nounits"]),
  ]);
  return { gpus: parseGpuRows(gpuOutput), processes: parseProcessRows(processOutput) };
}

export async function collectSnapshot() {
  const collectedAt = new Date();
  const { gpus, processes } = await queryNvidia();
  const [details, panes, parentMap] = await Promise.all([
    getProcessDetails(processes.map((process) => process.pid)),
    getTmuxPanes(),
    getParentMap(),
  ]);

  const matchedPanes = new Map();
  for (const process of processes) {
    Object.assign(process, details.get(process.pid) ?? {});
    const pane = findOwningPane(process.pid, panes, parentMap);
    process.terminalId = pane?.id ?? null;
    process.terminalLabel = pane?.label ?? null;
    if (pane) matchedPanes.set(pane.id, pane);
    const gpu = gpus.find((candidate) => candidate.uuid === process.gpuUuid);
    if (gpu) gpu.processes.push(process);
  }

  const terminals = await Promise.all([...matchedPanes.values()].map(capturePane));
  const memoryUsedMiB = gpus.reduce((sum, gpu) => sum + (gpu.memoryUsedMiB ?? 0), 0);
  const memoryTotalMiB = gpus.reduce((sum, gpu) => sum + (gpu.memoryTotalMiB ?? 0), 0);

  return {
    collectedAt: collectedAt.toISOString(),
    host: os.hostname(),
    uptimeSeconds: Math.round(os.uptime()),
    summary: {
      gpuCount: gpus.length,
      busyGpuCount: gpus.filter((gpu) => gpu.processes.length > 0).length,
      activeGpuCount: gpus.filter((gpu) => (gpu.utilizationPercent ?? 0) >= 5).length,
      processCount: processes.length,
      memoryUsedMiB,
      memoryTotalMiB,
    },
    gpus,
    terminals,
  };
}
