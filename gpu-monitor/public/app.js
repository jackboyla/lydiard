const elements = {
  connection: document.querySelector("#connection"),
  connectionLabel: document.querySelector("#connection-label"),
  lastUpdated: document.querySelector("#last-updated"),
  hostLabel: document.querySelector("#host-label"),
  summary: document.querySelector("#summary"),
  gpus: document.querySelector("#gpus"),
  processes: document.querySelector("#processes"),
  processNote: document.querySelector("#process-note"),
  terminals: document.querySelector("#terminals"),
  followToggle: document.querySelector("#follow-toggle"),
  toast: document.querySelector("#toast"),
};

const state = {
  follow: true,
  histories: new Map(),
  terminalScroll: new Map(),
  errorShown: false,
};

function text(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = content;
  return element;
}

function formatBytes(mib) {
  if (mib == null) return "—";
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GB` : `${Math.round(mib)} MB`;
}

function formatNumber(value, suffix = "") {
  return value == null ? "—" : `${Math.round(value)}${suffix}`;
}

function formatUptime(totalSeconds) {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  return days ? `${days}d ${hours}h uptime` : `${hours}h uptime`;
}

function makeSummary(label, value, detail, unit = "") {
  const card = document.createElement("article");
  card.className = "summary-card";
  card.append(text("div", "summary-label", label));
  const valueElement = text("div", "summary-value", value);
  if (unit) valueElement.append(text("span", "unit", unit));
  card.append(valueElement, text("div", "summary-detail", detail));
  return card;
}

function renderSummary(snapshot) {
  const { summary } = snapshot;
  const hottest = snapshot.gpus.reduce((max, gpu) => Math.max(max, gpu.temperatureC ?? 0), 0);
  elements.summary.replaceChildren(
    makeSummary("GPUs allocated", `${summary.busyGpuCount} / ${summary.gpuCount}`, `${summary.activeGpuCount} actively computing`),
    makeSummary("Compute processes", String(summary.processCount), summary.processCount === 1 ? "NVIDIA compute PID" : "NVIDIA compute PIDs"),
    makeSummary("VRAM allocated", formatBytes(summary.memoryUsedMiB), `${Math.round((summary.memoryUsedMiB / summary.memoryTotalMiB) * 100)}% of ${formatBytes(summary.memoryTotalMiB)}`),
    makeSummary("Peak temperature", String(Math.round(hottest)), "Across all installed GPUs", "°C"),
  );
}

function updateHistory(gpu) {
  const points = state.histories.get(gpu.index) ?? [];
  points.push(gpu.utilizationPercent ?? 0);
  if (points.length > 48) points.shift();
  state.histories.set(gpu.index, points);
  return points;
}

function sparkline(points) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("sparkline");
  svg.setAttribute("viewBox", "0 0 145 54");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Recent utilization: ${points.at(-1) ?? 0}%`);

  if (points.length < 2) {
    const line = document.createElementNS(svg.namespaceURI, "line");
    line.classList.add("spark-placeholder");
    line.setAttribute("x1", "0"); line.setAttribute("x2", "145"); line.setAttribute("y1", "52"); line.setAttribute("y2", "52");
    svg.append(line);
    return svg;
  }

  const coordinates = points.map((point, index) => {
    const x = (index / Math.max(points.length - 1, 1)) * 145;
    const y = 52 - (Math.min(100, Math.max(0, point)) / 100) * 48;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = document.createElementNS(svg.namespaceURI, "path");
  area.classList.add("area");
  area.setAttribute("d", `M ${coordinates.join(" L ")} L 145,54 L 0,54 Z`);
  const line = document.createElementNS(svg.namespaceURI, "polyline");
  line.classList.add("line");
  line.setAttribute("points", coordinates.join(" "));
  svg.append(area, line);
  return svg;
}

function meter(label, value, detail) {
  const wrapper = document.createElement("div");
  const heading = document.createElement("div");
  heading.className = "metric-heading";
  heading.append(text("span", "", label), text("strong", "", detail));
  const track = document.createElement("div");
  track.className = "meter";
  const fill = document.createElement("span");
  fill.style.width = `${Math.min(100, Math.max(0, value || 0))}%`;
  track.append(fill);
  wrapper.append(heading, track);
  return wrapper;
}

function miniMetric(label, value) {
  const item = document.createElement("div");
  item.className = "mini-metric";
  item.append(text("span", "", label), text("strong", "", value));
  return item;
}

function renderGpus(gpus) {
  const cards = gpus.map((gpu) => {
    const utilization = gpu.utilizationPercent ?? 0;
    const busy = gpu.processes.length > 0;
    const status = utilization >= 5 ? "Active" : busy ? "Allocated" : "Idle";
    const card = document.createElement("article");
    card.className = `gpu-card${busy ? " busy" : ""}`;

    const header = document.createElement("div");
    header.className = "gpu-card-header";
    const identity = document.createElement("div");
    identity.className = "gpu-identity";
    const identityText = document.createElement("div");
    identityText.style.minWidth = "0";
    identityText.append(text("p", "gpu-name", gpu.name), text("div", "gpu-meta", gpu.busId));
    identity.append(text("div", "gpu-index", `0${gpu.index}`.slice(-2)), identityText);
    header.append(identity, text("span", `activity-badge ${status.toLowerCase()}`, status));

    const utilizationRow = document.createElement("div");
    utilizationRow.className = "util-row";
    const utilizationText = document.createElement("div");
    const utilizationValue = text("div", "util-value", String(Math.round(utilization)));
    utilizationValue.append(text("span", "", "%"));
    utilizationText.append(utilizationValue, text("div", "util-caption", "GPU utilization now"));
    utilizationRow.append(utilizationText, sparkline(updateHistory(gpu)));

    const metrics = document.createElement("div");
    metrics.className = "metric-stack";
    const memoryPercent = gpu.memoryTotalMiB ? (gpu.memoryUsedMiB / gpu.memoryTotalMiB) * 100 : 0;
    const powerPercent = gpu.powerLimitW ? (gpu.powerDrawW / gpu.powerLimitW) * 100 : 0;
    metrics.append(
      meter("Memory", memoryPercent, `${formatBytes(gpu.memoryUsedMiB)} / ${formatBytes(gpu.memoryTotalMiB)}`),
      meter("Power", powerPercent, `${formatNumber(gpu.powerDrawW, " W")} / ${formatNumber(gpu.powerLimitW, " W")}`),
    );

    const foot = document.createElement("div");
    foot.className = "metric-foot";
    foot.append(
      miniMetric("Temperature", formatNumber(gpu.temperatureC, " °C")),
      miniMetric("Fan", formatNumber(gpu.fanPercent, "%")),
      miniMetric("Processes", String(gpu.processes.length)),
    );
    card.append(header, utilizationRow, metrics, foot);
    return card;
  });
  elements.gpus.replaceChildren(...cards);
}

function shortExecutable(process) {
  const source = process.command || process.executable || "Unknown process";
  const first = source.split(" ")[0];
  return first.split("/").at(-1) || first;
}

function renderProcesses(gpus) {
  const processes = gpus.flatMap((gpu) => gpu.processes.map((process) => ({ ...process, gpuIndex: gpu.index })));
  elements.processNote.textContent = `${processes.length} matching compute ${processes.length === 1 ? "PID" : "PIDs"}`;
  if (!processes.length) {
    elements.processes.replaceChildren(text("div", "empty-state", "No NVIDIA compute processes are currently attached."));
    return;
  }

  elements.processes.replaceChildren(...processes.map((process) => {
    const card = document.createElement("article");
    card.className = "process-card";
    const pid = document.createElement("div");
    pid.className = "process-pid";
    pid.append(text("span", "", "PID"), text("strong", "", String(process.pid)));
    const main = document.createElement("div");
    main.className = "process-main";
    main.append(
      text("p", "process-name", `${shortExecutable(process)} · GPU ${process.gpuIndex}${process.terminalLabel ? ` · ${process.terminalLabel}` : ""}`),
      text("p", "process-command", process.command || process.executable),
    );
    const stats = document.createElement("div");
    stats.className = "process-stats";
    for (const [label, value] of [
      ["GPU memory", formatBytes(process.gpuMemoryMiB)],
      ["CPU", formatNumber(process.cpuPercent, "%")],
      ["Elapsed", process.elapsed || "—"],
    ]) {
      const stat = document.createElement("div");
      stat.className = "process-stat";
      stat.append(text("span", "", label), text("strong", "", value));
      stats.append(stat);
    }
    card.append(pid, main, stats);
    return card;
  }));
}

function rememberScrollPositions() {
  for (const output of elements.terminals.querySelectorAll(".terminal-output")) {
    state.terminalScroll.set(output.dataset.id, output.scrollTop);
  }
}

function renderTerminals(terminals) {
  rememberScrollPositions();
  if (!terminals.length) {
    elements.terminals.replaceChildren(text("div", "empty-state", "No GPU process is currently mapped to a tmux pane. Start jobs in tmux to make their output available here."));
    return;
  }

  const cards = terminals.map((terminal) => {
    const card = document.createElement("article");
    card.className = "terminal-card";
    const bar = document.createElement("div");
    bar.className = "terminal-bar";
    const lights = document.createElement("div");
    lights.className = "terminal-lights";
    lights.setAttribute("aria-hidden", "true");
    lights.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
    const titleRow = document.createElement("div");
    titleRow.className = "terminal-title-row";
    titleRow.append(text("span", "terminal-title", terminal.label), text("span", "terminal-path", terminal.path));
    bar.append(lights, titleRow, text("span", "terminal-live", "Live"));

    const output = text("pre", "terminal-output", terminal.output || "No output captured yet.");
    output.dataset.id = terminal.id;
    card.append(bar, output);
    requestAnimationFrame(() => {
      output.scrollTop = state.follow ? output.scrollHeight : (state.terminalScroll.get(terminal.id) ?? 0);
    });
    return card;
  });
  elements.terminals.replaceChildren(...cards);
}

function render(snapshot) {
  elements.connection.dataset.state = "online";
  elements.connectionLabel.textContent = "Live";
  const sampleDate = new Date(snapshot.collectedAt);
  elements.lastUpdated.textContent = sampleDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  elements.hostLabel.textContent = `${snapshot.host} · ${formatUptime(snapshot.uptimeSeconds)}`;
  renderSummary(snapshot);
  renderGpus(snapshot.gpus);
  renderProcesses(snapshot.gpus);
  renderTerminals(snapshot.terminals);
}

function showError(message) {
  elements.connection.dataset.state = "offline";
  elements.connectionLabel.textContent = "Reconnecting";
  if (!state.errorShown) {
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    setTimeout(() => elements.toast.classList.remove("visible"), 4_000);
    state.errorShown = true;
  }
}

async function refresh() {
  if (document.hidden) return;
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store", signal: AbortSignal.timeout(4_500) });
    if (!response.ok) throw new Error(`Monitor returned ${response.status}`);
    render(await response.json());
    state.errorShown = false;
  } catch (error) {
    showError(error.message || "Unable to reach monitor");
  }
}

elements.followToggle.addEventListener("click", () => {
  state.follow = !state.follow;
  elements.followToggle.setAttribute("aria-pressed", String(state.follow));
  if (state.follow) {
    for (const output of elements.terminals.querySelectorAll(".terminal-output")) output.scrollTop = output.scrollHeight;
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});

refresh();
setInterval(refresh, 2_000);
