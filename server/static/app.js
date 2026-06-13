const state = {
    nodes: [],
    refreshTimer: null,
    nodesEtag: "",
};

const VISIBLE_REFRESH_MS = 15000;
const HIDDEN_REFRESH_MS = 60000;

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
        const card = document.createElement("a");
        card.className = `card ${isOffline ? "offline-card" : ""}`;
        card.href = `/nodes/${encodeURIComponent(node.hostname)}`;
        card.innerHTML = `
            <div class="card-header">
                <div class="server-name"><div class="status-dot ${statusClass(node.status)}"></div><span>${escapeHtml(node.name)}</span></div>
                <div class="uptime">${isOffline ? "Offline" : fmtUptime(node.uptime_seconds)}</div>
            </div>
            ${renderProgress("CPU", node.cpu_percent)}
            ${renderProgress("内存", node.memory_percent)}
            ${renderProgress("磁盘", node.disk_percent)}
            <div class="network-speeds">
                <span>上行 <b>${fmtRate(node.net_up_bps)}</b></span>
                <span>下行 <b>${fmtRate(node.net_down_bps)}</b></span>
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
    const headers = state.nodesEtag ? { "If-None-Match": state.nodesEtag } : {};
    const response = await fetch("/api/nodes", { headers });
    if (response.status === 304) {
        document.getElementById("clock").textContent = `Last checked: ${new Date().toLocaleTimeString("en-US", { hour12: false })}`;
        return;
    }
    if (!response.ok) throw new Error(`nodes request failed: ${response.status}`);
    state.nodesEtag = response.headers.get("ETag") || "";
    const data = await response.json();
    state.nodes = data.nodes || [];
    renderCards();

    document.getElementById("clock").textContent = `Last sync: ${new Date().toLocaleTimeString("en-US", { hour12: false })}`;
}

refreshNodes().catch((error) => {
    console.error(error);
    document.getElementById("clock").textContent = "Sync failed";
});

function scheduleRefresh() {
    window.clearTimeout(state.refreshTimer);
    const delay = document.hidden ? HIDDEN_REFRESH_MS : VISIBLE_REFRESH_MS;
    state.refreshTimer = window.setTimeout(async () => {
        try {
            await refreshNodes();
        } catch (error) {
            console.error(error);
        } finally {
            scheduleRefresh();
        }
    }, delay);
}

document.addEventListener("visibilitychange", () => {
    scheduleRefresh();
    if (!document.hidden) refreshNodes().catch(console.error);
});

scheduleRefresh();
