const progress = document.getElementById('progress');
const retry = document.getElementById('retry');
retry.addEventListener('click', () => location.reload());

async function openControl() {
  const theme = await magpie.ready;
  const options = await magpie.options.get();
  if (!/^[a-f0-9]{64}$/.test(options?.controlKey ?? '')) {
    progress.textContent = '請執行 node relayctl.mjs install 完成一次性安裝，再重開此頁。';
    return;
  }
  const port = Number(options.port ?? 3495);
  if (!Number.isInteger(port) || port < 1025 || port > 65535) throw new Error('控制連接埠無效。');
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
