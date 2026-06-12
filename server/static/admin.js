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
const commandBox = document.getElementById("command-box");
const commandText = document.getElementById("install-command");
const defaultServices = "广东电信:202.96.128.86:53,广东移动:211.136.192.6:53,广东联通:210.21.196.6:53,中国香港:1.1.1.1:443,美国洛杉矶:8.8.8.8:443";

serverUrlInput.value = window.location.origin;
servicesInput.value = servicesInput.value || defaultServices;

function setStatus(element, message, isError = false) {
    element.textContent = message;
    element.className = isError ? "admin-error" : "admin-ok";
}

function setLoggedIn(username) {
    loginPanel.hidden = true;
    agentPanel.hidden = false;
    document.getElementById("session-user").textContent = `已登录: ${username}`;
}

function setLoggedOut() {
    loginPanel.hidden = false;
    agentPanel.hidden = true;
    passwordInput.value = "";
    commandBox.hidden = true;
}

async function loadSession() {
    const response = await fetch("/api/admin/session");
    const data = await response.json();
    if (data.authenticated) {
        setLoggedIn(data.username);
    } else {
        setLoggedOut();
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
        const response = await fetch("/api/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "login failed");
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

document.getElementById("register-btn").addEventListener("click", async () => {
    const hostname = hostnameInput.value.trim();
    if (!hostname) {
        setStatus(statusEl, "请填写节点名称", true);
        return;
    }

    setStatus(statusEl, "生成中...");

    try {
        const response = await fetch("/api/admin/agents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                hostname,
                server_url: serverUrlInput.value.trim(),
                interval_seconds: Number(intervalInput.value || 60),
                services: servicesInput.value.trim() || "ssh:22",
                public_ip: publicIpInput.value.trim(),
                location: locationInput.value.trim(),
            }),
        });

        const data = await response.json();
        if (response.status === 401) {
            setLoggedOut();
        }
        if (!response.ok) throw new Error(data.detail || "request failed");

        commandText.value = data.install_command;
        commandBox.hidden = false;
        setStatus(statusEl, `已登记 ${data.hostname}`);
    } catch (error) {
        setStatus(statusEl, error.message, true);
    }
});

document.getElementById("copy-btn").addEventListener("click", async () => {
    await navigator.clipboard.writeText(commandText.value);
    setStatus(statusEl, "已复制");
});

loadSession().catch(() => setLoggedOut());
