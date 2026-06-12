const state = {
    hostname: document.body.dataset.hostname || "",
    node: null,
    chart: null,
    activeHours: 1,
    refreshTimer: null,
};

const CHART_COLORS = ["#14b8a6", "#818cf8", "#22c55e", "#7dd3fc", "#a78bfa", "#f59e0b"];

const statusClass = (status) => {
    if (status === "warn") return "warn";
    if (status === "offline") return "offline";
    return "";
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
}[char]));

function setMissing(isMissing) {
    document.getElementById("missing-state").hidden = !isMissing;
    document.getElementById("detail-content").hidden = isMissing;
}

function renderNode(node) {
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

async function refreshNode() {
    const response = await fetch("/api/nodes");
    if (!response.ok) throw new Error(`nodes request failed: ${response.status}`);
    const data = await response.json();
    const node = (data.nodes || []).find((item) => item.hostname === state.hostname);
    setMissing(!node);
    if (!node) return;

    state.node = node;
    renderNode(node);
    document.getElementById("clock").textContent = `Last sync: ${new Date().toLocaleTimeString("en-US", { hour12: false })}`;
}

async function renderHistory(hours) {
    const response = await fetch(`/api/nodes/${encodeURIComponent(state.hostname)}/history?hours=${hours}`);
    if (!response.ok) throw new Error(`history request failed: ${response.status}`);
    const data = await response.json();
    const points = data.points || [];
    const labels = points.map((point) => new Date(point.timestamp).toLocaleTimeString("en-US", { hour12: false }));
    const serviceNames = Array.from(new Set(points.flatMap((point) => (point.services || []).map((service) => service.name))));
    const datasets = serviceNames.map((name, index) => {
        const color = CHART_COLORS[index % CHART_COLORS.length];
        return {
            label: name,
            data: points.map((point) => {
                const service = (point.services || []).find((item) => item.name === name);
                return typeof service?.latency_ms === "number" ? service.latency_ms : null;
            }),
            borderColor: color,
            backgroundColor: "transparent",
            borderWidth: 2,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 4,
            spanGaps: true,
        };
    });

    const ctx = document.getElementById("metricChart").getContext("2d");
    if (state.chart) state.chart.destroy();
    const noDataPlugin = {
        id: "noLatencyData",
        afterDraw: (chart) => {
            if (datasets.length) return;
            const { ctx: chartCtx, chartArea } = chart;
            chartCtx.save();
            chartCtx.fillStyle = "#9ca3af";
            chartCtx.font = "13px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif";
            chartCtx.textAlign = "center";
            chartCtx.fillText("暂无延迟历史数据", (chartArea.left + chartArea.right) / 2, (chartArea.top + chartArea.bottom) / 2);
            chartCtx.restore();
        },
    };
    state.chart = new Chart(ctx, {
        type: "line",
        data: { labels, datasets },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: "top",
                    align: "end",
                    labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, font: { size: 10 } },
                },
                tooltip: {
                    mode: "index",
                    intersect: false,
                    callbacks: {
                        label: (context) => {
                            const value = context.parsed.y;
                            return `${context.dataset.label}: ${value == null ? "--" : value.toFixed(1)} ms`;
                        },
                    },
                },
            },
            scales: {
                x: { display: false },
                y: {
                    min: 0,
                    border: { display: false },
                    grid: { color: "#f3f4f6" },
                    ticks: {
                        font: { size: 10 },
                        color: "#9ca3af",
                        maxTicksLimit: 5,
                        callback: (value) => `${value} ms`,
                    },
                },
            },
            interaction: { mode: "nearest", axis: "x", intersect: false },
        },
        plugins: [noDataPlugin],
    });
}

document.querySelectorAll(".time-btn").forEach((button) => {
    button.addEventListener("click", async () => {
        document.querySelectorAll(".time-btn").forEach((btn) => btn.classList.remove("active"));
        button.classList.add("active");
        state.activeHours = Number(button.dataset.hours);
        await renderHistory(state.activeHours);
    });
});

Promise.all([refreshNode(), renderHistory(state.activeHours)]).catch((error) => {
    console.error(error);
    document.getElementById("clock").textContent = "Sync failed";
});

state.refreshTimer = setInterval(async () => {
    await refreshNode();
    await renderHistory(state.activeHours);
}, 5000);
