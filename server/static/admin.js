const loginPanel = document.getElementById("login-panel");
const agentPanel = document.getElementById("agent-panel");
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
const agentList = document.getElementById("agent-list");
const agentEmpty = document.getElementById("agent-empty");
const commandBox = document.getElementById("command-box");
const commandTitle = document.getElementById("command-title");
const commandText = document.getElementById("install-command");
const defaultServices = "广东电信:202.96.128.86:53,广东移动:211.136.192.6:53,广东联通:210.21.196.6:53,中国香港:1.1.1.1:443,美国洛杉矶:8.8.8.8:443";

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
    document.getElementById("session-user").textContent = `已登录：${username}`;
    loadAgents().catch((error) => setStatus(statusEl, error.message, true));
}

function setLoggedOut() {
    loginPanel.hidden = false;
    agentPanel.hidden = true;
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

function renderAgents(agents) {
    agentList.innerHTML = "";
    agentEmpty.hidden = agents.length > 0;

    agents.forEach((agent) => {
        const node = agent.node || {};
        const card = document.createElement("div");
        card.className = "agent-card";
        card.dataset.hostname = agent.hostname;
        card.innerHTML = `
            <div class="agent-card-header">
                <div>
                    <div class="agent-name">${escapeHtml(agent.hostname)}</div>
                    <div class="agent-meta">
                        ${escapeHtml(node.status || "未上报")} · ${escapeHtml(node.ip || "--")} · ${escapeHtml(agent.location || node.location || "--")}
                    </div>
                </div>
                <button class="ghost-btn agent-cleanup-btn" type="button">清理命令</button>
            </div>
            <div class="admin-grid agent-edit-grid">
                <label>
                    <span>服务探活</span>
                    <input class="agent-services-input" type="text" value="${escapeHtml(agent.services || "")}" placeholder="${escapeHtml(defaultServices)}">
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
                <button class="primary-btn agent-save-btn" type="button">保存探活</button>
                <button class="ghost-btn agent-upgrade-btn" type="button">升级命令</button>
                <button class="ghost-btn agent-delete-btn danger-btn" type="button">删除节点</button>
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
        card.querySelector(".agent-delete-btn").addEventListener("click", () => deleteAgent(card));
        agentList.appendChild(card);
    });
}

async function loadAgents() {
    const data = await fetchJson("/api/admin/agents");
    renderAgents(data.agents || []);
}

function readAgentForm(card) {
    return {
        services: card.querySelector(".agent-services-input").value.trim(),
        interval_seconds: Number(card.querySelector(".agent-interval-input").value || 60),
        public_ip: card.querySelector(".agent-public-ip-input").value.trim(),
        location: card.querySelector(".agent-location-input").value.trim(),
    };
}

async function saveAgent(card) {
    const hostname = card.dataset.hostname;
    const rowStatus = card.querySelector(".agent-row-status");
    setStatus(rowStatus, "保存中...");
    try {
        const data = await fetchJson(`/api/admin/agents/${encodeURIComponent(hostname)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(readAgentForm(card)),
        });
        showCommand(`${hostname} 升级/重装命令`, data.install_command);
        setStatus(rowStatus, "已保存，新版 agent 下一轮上报自动生效");
    } catch (error) {
        setStatus(rowStatus, error.message, true);
    }
}

async function deleteAgent(card) {
    const hostname = card.dataset.hostname;
    const rowStatus = card.querySelector(".agent-row-status");
    if (!window.confirm(`确认删除节点 ${hostname}？主控会移除凭据和历史数据。`)) return;

    setStatus(rowStatus, "删除中...");
    try {
        const data = await fetchJson(`/api/admin/agents/${encodeURIComponent(hostname)}`, { method: "DELETE" });
        showCommand(`${hostname} 探针清理命令`, data.uninstall_command);
        setStatus(statusEl, `已删除 ${hostname}`);
        await loadAgents();
    } catch (error) {
        setStatus(rowStatus, error.message, true);
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

document.getElementById("logout-btn").addEventListener("click", async () => {
    await fetch("/api/admin/logout", { method: "POST" });
    setLoggedOut();
});

document.getElementById("refresh-agents-btn").addEventListener("click", () => {
    loadAgents().catch((error) => setStatus(statusEl, error.message, true));
});

document.getElementById("register-btn").addEventListener("click", async () => {
    const hostname = hostnameInput.value.trim();
    if (!hostname) {
        setStatus(statusEl, "请填写节点名称", true);
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
