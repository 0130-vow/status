const loginPanel = document.getElementById("login-panel");
const agentPanel = document.getElementById("agent-panel");
const createAgentPanel = document.getElementById("create-agent-panel");
const usernameInput = document.getElementById("admin-username");
const passwordInput = document.getElementById("admin-password");
const loginStatusEl = document.getElementById("login-status");
const hostnameInput = document.getElementById("hostname");
const serverUrlInput = document.getElementById("server-url");
const intervalInput = document.getElementById("interval");
const servicesInput = document.getElementById("services");
const publicIpInput = document.getElementById("public-ip");
const locationInput = document.getElementById("location");
const statusEl = document.getElementById("admin-status");
const agentTableBody = document.getElementById("agent-table-body");
const agentList = document.getElementById("agent-list");
const agentEmpty = document.getElementById("agent-empty");
const commandBox = document.getElementById("command-box");
const commandTitle = document.getElementById("command-title");
const commandText = document.getElementById("install-command");
const sessionUserEl = document.getElementById("session-user");
const logoutBtn = document.getElementById("logout-btn");
const defaultServices = "广东电信:202.96.128.86:53,广东移动:211.136.192.6:53,广东联通:210.21.196.6:53,中国香港:1.1.1.1:443,美国洛杉矶:8.8.8.8:443";

const state = {
    agents: [],
    editingHostname: "",
};

serverUrlInput.value = window.location.origin;
servicesInput.value = servicesInput.value || defaultServices;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
}[char]));

function setStatus(element, message, isError = false) {
    element.textContent = message;
    element.className = isError ? "admin-error" : "admin-ok";
}

function showCommand(title, command) {
    commandTitle.textContent = title;
    commandText.value = command;
    commandBox.hidden = false;
}

function setLoggedIn(username) {
    loginPanel.hidden = true;
    agentPanel.hidden = false;
    sessionUserEl.textContent = `已登录：${username}`;
    sessionUserEl.hidden = false;
    logoutBtn.hidden = false;
    loadAgents().catch((error) => setStatus(statusEl, error.message, true));
}

function setLoggedOut() {
    loginPanel.hidden = false;
    agentPanel.hidden = true;
    createAgentPanel.hidden = true;
    sessionUserEl.textContent = "";
    sessionUserEl.hidden = true;
    logoutBtn.hidden = true;
    passwordInput.value = "";
    commandBox.hidden = true;
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (response.status === 401) {
        setLoggedOut();
    }
    if (!response.ok) throw new Error(data.detail || "request failed");
    return data;
}

async function loadSession() {
    const data = await fetchJson("/api/admin/session");
    if (data.authenticated) {
        setLoggedIn(data.username);
    } else {
        setLoggedOut();
    }
}

function agentDisplayName(agent) {
    return agent.name || agent.hostname;
}

function nodeStatus(agent) {
    return agent.node?.status || "unknown";
}

function statusText(status) {
    if (status === "online") return "运行中";
    if (status === "offline") return "已离线";
    if (status === "warn") return "异常";
    return "未上报";
}

function agentLocation(agent) {
    return agent.location || agent.node?.location || "--";
}

function renderAgentRows() {
    agentTableBody.innerHTML = "";
    agentEmpty.hidden = state.agents.length > 0;

    state.agents.forEach((agent) => {
        const node = agent.node || {};
        const status = nodeStatus(agent);
        const row = document.createElement("tr");
        row.dataset.hostname = agent.hostname;
        row.innerHTML = `
            <td>
                <div class="node-name-cell">${escapeHtml(agentDisplayName(agent))}</div>
                ${agent.name && agent.name !== agent.hostname ? `<div class="node-hostname-cell">${escapeHtml(agent.hostname)}</div>` : ""}
            </td>
            <td>${escapeHtml(agent.public_ip || node.ip || "--")}</td>
            <td><span class="status-pill ${escapeHtml(status)}"><span></span>${escapeHtml(statusText(status))}</span></td>
            <td>${escapeHtml(node.os || "--")}</td>
            <td>${escapeHtml(agentLocation(agent))}</td>
            <td>
                <div class="table-actions">
                    <button class="link-btn agent-edit-btn" type="button">编辑</button>
                    <button class="link-btn danger-link agent-delete-btn" type="button">删除</button>
                </div>
            </td>
        `;
        row.querySelector(".agent-edit-btn").addEventListener("click", () => editAgent(agent.hostname));
        row.querySelector(".agent-delete-btn").addEventListener("click", () => deleteAgent(agent.hostname));
        agentTableBody.appendChild(row);
    });
}

function renderEditForm() {
    agentList.innerHTML = "";
    agentList.hidden = !state.editingHostname;
    if (!state.editingHostname) return;

    const agent = state.agents.find((item) => item.hostname === state.editingHostname);
    if (!agent) {
        state.editingHostname = "";
        agentList.hidden = true;
        return;
    }

    const card = document.createElement("div");
    card.className = "agent-card";
    card.dataset.hostname = agent.hostname;
    const servicesValue = agent.services || defaultServices;
    card.innerHTML = `
        <div class="agent-card-header">
            <div>
                <div class="agent-name">${escapeHtml(agentDisplayName(agent))}</div>
                <div class="agent-meta">${escapeHtml(agent.hostname)} · ${escapeHtml(agent.node?.ip || "--")} · ${escapeHtml(agentLocation(agent))}</div>
            </div>
            <button class="ghost-btn agent-cleanup-btn" type="button">清理命令</button>
        </div>
        <div class="admin-grid agent-edit-grid">
            <label>
                <span>节点名称</span>
                <input class="agent-name-input" type="text" value="${escapeHtml(agentDisplayName(agent))}" placeholder="${escapeHtml(agent.hostname)}">
            </label>
            <label>
                <span>服务探活</span>
                <input class="agent-services-input" type="text" value="${escapeHtml(servicesValue)}" placeholder="${escapeHtml(defaultServices)}">
            </label>
            <label>
                <span>上报间隔</span>
                <input class="agent-interval-input" type="number" min="5" value="${Number(agent.interval_seconds || 60)}">
            </label>
            <label>
                <span>公网 IP</span>
                <input class="agent-public-ip-input" type="text" value="${escapeHtml(agent.public_ip || "")}" placeholder="可留空">
            </label>
            <label>
                <span>位置</span>
                <input class="agent-location-input" type="text" value="${escapeHtml(agent.location || "")}">
            </label>
        </div>
        <div class="admin-actions agent-row-actions">
            <button class="primary-btn agent-save-btn" type="button">保存</button>
            <button class="ghost-btn agent-upgrade-btn" type="button">升级命令</button>
            <button class="ghost-btn agent-cancel-btn" type="button">取消</button>
            <span class="agent-row-status"></span>
        </div>
    `;

    card.querySelector(".agent-save-btn").addEventListener("click", () => saveAgent(card));
    card.querySelector(".agent-upgrade-btn").addEventListener("click", () => {
        showCommand(`${agent.hostname} 升级/重装命令`, agent.install_command);
    });
    card.querySelector(".agent-cleanup-btn").addEventListener("click", () => {
        showCommand(`${agent.hostname} 探针清理命令`, agent.uninstall_command);
    });
    card.querySelector(".agent-cancel-btn").addEventListener("click", () => {
        state.editingHostname = "";
        renderEditForm();
    });
    agentList.appendChild(card);
}

function renderAgents(agents) {
    state.agents = agents;
    if (state.editingHostname && !agents.some((agent) => agent.hostname === state.editingHostname)) {
        state.editingHostname = "";
    }
    renderAgentRows();
    renderEditForm();
}

async function loadAgents() {
    const data = await fetchJson("/api/admin/agents");
    renderAgents(data.agents || []);
}

function editAgent(hostname) {
    state.editingHostname = hostname;
    renderEditForm();
    agentList.scrollIntoView({ behavior: "smooth", block: "start" });
}

function readAgentForm(card) {
    const servicesField = card.querySelector(".agent-services-input");
    return {
        name: card.querySelector(".agent-name-input").value.trim(),
        services: servicesField.value.trim() || servicesField.placeholder.trim() || defaultServices,
        interval_seconds: Number(card.querySelector(".agent-interval-input").value || 60),
        public_ip: card.querySelector(".agent-public-ip-input").value.trim(),
        location: card.querySelector(".agent-location-input").value.trim(),
    };
}

async function saveAgent(card) {
    const hostname = card.dataset.hostname;
    const rowStatus = card.querySelector(".agent-row-status");
    const payload = readAgentForm(card);
    setStatus(rowStatus, "保存中...");
    try {
        const data = await fetchJson(`/api/admin/agents/${encodeURIComponent(hostname)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const agent = state.agents.find((item) => item.hostname === hostname);
        if (agent) {
            Object.assign(agent, payload);
            card.querySelector(".agent-name").textContent = agentDisplayName(agent);
            renderAgentRows();
        }
        showCommand(`${hostname} 升级/重装命令`, data.install_command);
        setStatus(rowStatus, "已保存，新版 agent 下一轮上报自动生效");
    } catch (error) {
        setStatus(rowStatus, error.message, true);
    }
}

async function deleteAgent(hostname) {
    if (!window.confirm(`确认删除节点 ${hostname}？主控会移除凭据和历史数据。`)) return;

    try {
        const data = await fetchJson(`/api/admin/agents/${encodeURIComponent(hostname)}`, { method: "DELETE" });
        if (state.editingHostname === hostname) state.editingHostname = "";
        showCommand(`${hostname} 探针清理命令`, data.uninstall_command);
        setStatus(statusEl, `已删除 ${hostname}`);
        await loadAgents();
    } catch (error) {
        setStatus(statusEl, error.message, true);
    }
}

document.getElementById("login-btn").addEventListener("click", async () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) {
        setStatus(loginStatusEl, "请填写账号和密码", true);
        return;
    }

    setStatus(loginStatusEl, "登录中...");
    try {
        const data = await fetchJson("/api/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
        });
        setStatus(loginStatusEl, "");
        setLoggedIn(data.username);
    } catch (error) {
        setStatus(loginStatusEl, error.message, true);
    }
});

logoutBtn.addEventListener("click", async () => {
    await fetch("/api/admin/logout", { method: "POST" });
    setLoggedOut();
});

document.getElementById("open-create-btn").addEventListener("click", () => {
    createAgentPanel.hidden = false;
    createAgentPanel.scrollIntoView({ behavior: "smooth", block: "start" });
});

document.getElementById("close-create-btn").addEventListener("click", () => {
    createAgentPanel.hidden = true;
});

document.getElementById("refresh-agents-btn").addEventListener("click", () => {
    loadAgents().catch((error) => setStatus(statusEl, error.message, true));
});

document.getElementById("register-btn").addEventListener("click", async () => {
    const hostname = hostnameInput.value.trim();
    if (!hostname) {
        setStatus(statusEl, "请填写节点标识", true);
        return;
    }

    setStatus(statusEl, "生成中...");

    try {
        const data = await fetchJson("/api/admin/agents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                hostname,
                server_url: serverUrlInput.value.trim(),
                interval_seconds: Number(intervalInput.value || 60),
                services: servicesInput.value.trim() || defaultServices,
                public_ip: publicIpInput.value.trim(),
                location: locationInput.value.trim(),
            }),
        });

        showCommand(`${data.hostname} 安装命令`, data.install_command);
        setStatus(statusEl, `已登记 ${data.hostname}`);
        await loadAgents();
    } catch (error) {
        setStatus(statusEl, error.message, true);
    }
});

document.getElementById("copy-btn").addEventListener("click", async () => {
    await navigator.clipboard.writeText(commandText.value);
    setStatus(statusEl, "已复制");
});

loadSession().catch(() => setLoggedOut());
