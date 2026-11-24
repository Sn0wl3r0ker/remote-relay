const args = new URLSearchParams(location.hash.slice(1));
const key = args.get('key');
if (args.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';

const statusText = document.getElementById('status');
const detail = document.getElementById('detail');
const errorText = document.getElementById('error');
const on = document.getElementById('on');
const off = document.getElementById('off');
const refresh = document.getElementById('refresh');
const messages = {
  off: '已停用', on: '轉發中', unmanaged: '偵測到現有的 Model Relay 設定',
  restoring: 'Claude 設定已復原，等待目前的請求結束', repair: '轉發需要重新啟用或復原',
};
let current;
let busy = false;
let poll;

function show(value) {
  current = value;
  statusText.textContent = messages[value.phase] ?? '狀態不明';
  statusText.dataset.phase = value.phase;
  const details = [];
  if (value.invalidConfig) details.push('model-relay.json 格式有誤。');
  else if (!value.configured) details.push('請先設定 Model Relay。');
  if (!value.installed) details.push('請先安裝 Claude Code 的 model-relay@model-relay 插件。');
  if (value.port && value.mode) details.push(`${value.mode === 'proxy' ? 'HTTPS 代理' : 'API 位址'} · 127.0.0.1:${value.port}`);
  if (value.router === 'unverified') details.push('無法辨識轉發連接埠上的服務。');
  if (value.activeRequests > 0) details.push(`${value.activeRequests} 個請求進行中。`);
  if (value.skipped?.length) details.push(`保留切換期間的外部變更：${value.skipped.join('、')}`);
  detail.textContent = details.join(' ');
  detail.hidden = details.length === 0;
  on.disabled = !value.configured || !value.installed || ['on', 'restoring'].includes(value.phase);
  off.disabled = value.phase === 'off';
}

async function action(name) {
  if (busy) return;
  busy = true;
  clearTimeout(poll);
  on.disabled = off.disabled = refresh.disabled = true;
  errorText.hidden = true;
  try {
    if (!key) throw new Error('請從 Magpie 的 Remote Relay 頁面開啟。');
    const res = await fetch(`api/${name}`, {
      method: name === 'status' ? 'GET' : 'POST', headers: { 'x-remote-relay-key': key }, credentials: 'omit',
    });
    const value = await res.json();
    if (!res.ok) throw new Error(value.error || '切換失敗。');
    show(value);
    if (value.phase === 'restoring') poll = setTimeout(() => action('status'), 1500);
  } catch (error) {
    if (current) show(current);
    else statusText.textContent = '無法讀取轉發狀態';
    errorText.textContent = error.message;
    errorText.hidden = false;
  } finally {
    busy = false;
    refresh.disabled = false;
  }
}

on.addEventListener('click', () => action('on'));
off.addEventListener('click', () => action('off'));
refresh.addEventListener('click', () => action('status'));
void action('status');
