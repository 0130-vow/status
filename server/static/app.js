const state = {
    nodes: [],
    activeNode: null,
    chart: null,
    refreshTimer: null,
};

const statusClass = (status) => {
    if (status === "warn") return "warn";
    if (status === "offline") return "offline";
    return "";
};

const pctClass = (value) => {
    if (value >= 90) return "danger";
    if (value >= 80) return "warn";
    return "";
};

const fmtPct = (value) => `${Number(value || 0).toFixed(1)}%`;

const fmtBytes = (bytes) => {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Number(bytes || 0);
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
};

const fmtRate = (bytesPerSecond) => `${fmtBytes(bytesPerSecond)}/s`;

const fmtUptime = (seconds) => {
    const total = Number(seconds || 0);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    if (days > 0) return `${days}d ${hours}h`;
    const minutes = Math.floor((total % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
}[char]));

function renderProgress(label, value) {
    const safeValue = Math.max(0, Math.min(100, Number(value || 0)));
    return `
        <div class="stat-row">
            <div class="stat-label"><span>${label}</span><span class="stat-value">${fmtPct(safeValue)}</span></div>
            <div class="progress-bar"><div class="progress-fill ${pctClass(safeValue)}" style="width: ${safeValue}%"></div></div>
        </div>
    `;
}

function renderCards() {
    const grid = document.getElementById("server-grid");
    const empty = document.getElementById("empty-state");
    grid.innerHTML = "";
    empty.style.display = state.nodes.length ? "none" : "block";

    state.nodes.forEach((node) => {
        const isOffline = node.status === "offline";
        const card = document.createElement("div");
        card.className = `card ${isOffline ? "offline-card" : ""}`;
        card.addEventListener("click", () => openModal(node.hostname));
        card.innerHTML = `
            <div class="card-header">
                <div class="server-name"><div class="status-dot ${statusClass(node.status)}"></div><span>${escapeHtml(node.name)}</span></div>
                <div class="uptime">${isOffline ? "Offline" : fmtUptime(node.uptime_seconds)}</div>
            </div>
            ${renderProgress("CPU", node.cpu_percent)}
            ${renderProgress("内存", node.memory_percent)}
            ${renderProgress("磁盘", node.disk_percent)}
            <div class="network-speeds">
                <span>↑ <b>${fmtRate(node.net_up_bps)}</b></span>
                <span>↓ <b>${fmtRate(node.net_down_bps)}</b></span>
            </div>
            <div class="traffic-total">
                <span>总出: ${fmtBytes(node.net_sent)}</span>
                <span>总入: ${fmtBytes(node.net_recv)}</span>
            </div>
        `;
        grid.appendChild(card);
    });
}

async function refreshNodes() {
    const response = await fetch("/api/nodes");
    if (!response.ok) throw new Error(`nodes request failed: ${response.status}`);
    const data = await response.json();
    state.nodes = data.nodes || [];
    renderCards();

    if (state.activeNode) {
        const fresh = state.nodes.find((node) => node.hostname === state.activeNode.hostname);
        if (fresh) {
            state.activeNode = fresh;
            renderModal(fresh);
        }
    }

    document.getElementById("clock").textContent = `Last sync: ${new Date().toLocaleTimeString("en-US", { hour12: false })}`;
}

function renderModal(node) {
    document.getElementById("m-title").innerHTML = `<div class="status-dot ${statusClass(node.status)}"></div>${escapeHtml(node.name)}`;
    document.getElementById("m-os").textContent = node.os || "--";
    document.getElementById("m-ip").textContent = node.ip || "--";
    document.getElementById("m-cpu").textContent = node.cpu_model || "--";
    document.getElementById("m-loc").textContent = node.location || "--";
    renderServices(node.services || []);
}

function renderServices(services) {
    const container = document.getElementById("m-services");
    container.innerHTML = `
        <div class="ping-row ping-header">
            <div>服务</div><div>状态</div><div>目标</div><div style="text-align:right;">延迟</div>
        </div>
    `;

    if (!services.length) {
        container.innerHTML += `<div class="ping-row"><div>--</div><div>--</div><div>--</div><div class="p-val">--</div></div>`;
        return;
    }

    services.forEach((service) => {
        const ok = ["running", "ok"].includes(service.status);
        const latency = typeof service.latency_ms === "number" ? `${service.latency_ms.toFixed(1)} ms` : "--";
        container.innerHTML += `
            <div class="ping-row">
                <div>${escapeHtml(service.name)}</div>
                <div><span class="p-type">${escapeHtml(service.status)}</span></div>
                <div class="p-region">${escapeHtml(service.target || "--")}</div>
                <div class="p-val ${ok ? "ping-good" : "ping-down"}">${latency}</div>
            </div>
        `;
    });
}

async function openModal(hostname) {
    const node = state.nodes.find((item) => item.hostname === hostname);
    if (!node) return;
    state.activeNode = node;
    renderModal(node);
    document.querySelectorAll(".time-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.hours === "1"));
    document.getElementById("modal-overlay").classList.add("active");
    await renderHistory(hostname, 1);
}

function closeModal() {
    document.getElementById("modal-overlay").classList.remove("active");
    state.activeNode = null;
}

async function renderHistory(hostname, hours) {
    const response = await fetch(`/api/nodes/${encodeURIComponent(hostname)}/history?hours=${hours}`);
    if (!response.ok) throw new Error(`history request failed: ${response.status}`);
    const data = await response.json();
    const points = data.points || [];
    const labels = points.map((point) => new Date(point.timestamp).toLocaleTimeString("en-US", { hour12: false }));

    const datasets = [
        { label: "CPU", data: points.map((p) => p.cpu_percent), borderColor: "#10b981" },
        { label: "内存", data: points.map((p) => p.memory_percent), borderColor: "#3b82f6" },
        { label: "磁盘", data: points.map((p) => p.disk_percent), borderColor: "#f59e0b" },
    ].map((item) => ({
        ...item,
        backgroundColor: "transparent",
        borderWidth: 2,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 4,
    }));

    const ctx = document.getElementById("metricChart").getContext("2d");
    if (state.chart) state.chart.destroy();
    state.chart = new Chart(ctx, {
        type: "line",
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: "top",
                    align: "end",
                    labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, font: { size: 10 } },
                },
                tooltip: { mode: "index", intersect: false },
            },
            scales: {
                x: { display: false },
                y: {
                    min: 0,
                    max: 100,
                    border: { display: false },
                    grid: { color: "#f3f4f6" },
                    ticks: { font: { size: 10 }, color: "#9ca3af", maxTicksLimit: 5 },
                },
            },
            interaction: { mode: "nearest", axis: "x", intersect: false },
        },
    });
}

document.getElementById("modal-overlay").addEventListener("click", closeModal);
document.querySelector(".modal-content").addEventListener("click", (event) => event.stopPropagation());
document.getElementById("modal-close").addEventListener("click", closeModal);
document.querySelectorAll(".time-btn").forEach((button) => {
    button.addEventListener("click", async () => {
        if (!state.activeNode) return;
        document.querySelectorAll(".time-btn").forEach((btn) => btn.classList.remove("active"));
        button.classList.add("active");
        await renderHistory(state.activeNode.hostname, Number(button.dataset.hours));
    });
});

refreshNodes().catch((error) => {
    console.error(error);
    document.getElementById("clock").textContent = "Sync failed";
});
state.refreshTimer = setInterval(() => refreshNodes().catch(console.error), 5000);
