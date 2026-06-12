const tokenInput = document.getElementById("admin-token");
const hostnameInput = document.getElementById("hostname");
const serverUrlInput = document.getElementById("server-url");
const intervalInput = document.getElementById("interval");
const servicesInput = document.getElementById("services");
const locationInput = document.getElementById("location");
const statusEl = document.getElementById("admin-status");
const commandBox = document.getElementById("command-box");
const commandText = document.getElementById("install-command");

tokenInput.value = localStorage.getItem("probe_admin_token") || "";
serverUrlInput.value = window.location.origin;

function setStatus(message, isError = false) {
    statusEl.textContent = message;
    statusEl.className = isError ? "admin-error" : "admin-ok";
}

document.getElementById("register-btn").addEventListener("click", async () => {
    const adminToken = tokenInput.value.trim();
    const hostname = hostnameInput.value.trim();
    if (!adminToken || !hostname) {
        setStatus("请填写管理 token 和节点名称", true);
        return;
    }

    localStorage.setItem("probe_admin_token", adminToken);
    setStatus("生成中...");

    try {
        const response = await fetch("/api/admin/agents", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Admin-Token": adminToken,
            },
            body: JSON.stringify({
                hostname,
                server_url: serverUrlInput.value.trim(),
                interval_seconds: Number(intervalInput.value || 60),
                services: servicesInput.value.trim() || "ssh:22",
                location: locationInput.value.trim(),
            }),
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "request failed");

        commandText.value = data.install_command;
        commandBox.hidden = false;
        setStatus(`已登记 ${data.hostname}`);
    } catch (error) {
        setStatus(error.message, true);
    }
});

document.getElementById("copy-btn").addEventListener("click", async () => {
    await navigator.clipboard.writeText(commandText.value);
    setStatus("已复制");
});
