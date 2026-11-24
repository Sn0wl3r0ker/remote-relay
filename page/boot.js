const progress = document.getElementById('progress');
const retry = document.getElementById('retry');
retry.addEventListener('click', () => location.reload());

async function openControl() {
  const theme = await magpie.ready;
  const options = await magpie.options.get() ?? {};
  const hasKey = /^[a-f0-9]{64}$/.test(options.controlKey ?? '');
  const port = Number(options.port);
  const hasPort = Number.isInteger(port) && port >= 1025 && port <= 65535;
  if (!hasKey || !hasPort) {
    progress.textContent = '正在初始化模型轉發…';
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const controlKey = hasKey ? options.controlKey : Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const controlPort = hasPort ? port : 49152 + (crypto.getRandomValues(new Uint16Array(1))[0] % 16384);
    await magpie.options.set({ ...options, controlKey, port: controlPort });
    // Saving options restarts the Magpie plugin host. The fresh page starts it again.
    location.reload();
    return;
  }
  const url = new URL(magpie.service || `http://127.0.0.1:${port}/`);
  url.hash = new URLSearchParams({ key: options.controlKey, theme: theme.dark ? 'dark' : 'light' }).toString();
  location.replace(url);
  setTimeout(() => {
    progress.textContent = '模型轉發控制服務暫時無法連線。';
    retry.hidden = false;
  }, 5000);
}

openControl().catch(() => {
  progress.textContent = '無法讀取 Magpie 插件設定。';
  retry.hidden = false;
});
