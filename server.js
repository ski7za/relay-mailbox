import express from "express";
import cors from "cors";

// In-memory store (swap for Redis/DB in production)
const devices = new Map(); // device_id -> { secret, lastSeen, state:{}, queue:[] }

const app = express();
app.use(cors());
app.use(express.json());

// Helper
function requireDevice(req, res) {
  const { device_id, secret } = req.query.device_id ? req.query : req.body;
  if (!device_id || !secret) {
    res.status(400).json({ error: "device_id and secret required" });
    return null;
  }
  const d = devices.get(device_id);
  if (!d || d.secret !== secret) {
    res.status(401).json({ error: "invalid device or secret" });
    return null;
  }
  return d;
}

// Register or rotate secret
app.post("/register", (req, res) => {
  const { device_id, secret } = req.body;
  if (!device_id || !secret) return res.status(400).json({ error: "device_id and secret required" });
  if (!devices.has(device_id)) {
    devices.set(device_id, { secret, lastSeen: Date.now(), state: {}, queue: [] });
  } else {
    // rotate secret or update
    const d = devices.get(device_id);
    d.secret = secret;
    d.lastSeen = Date.now();
  }
  res.json({ ok: true });
});

// Device heartbeat + state update (called by the device every N seconds)
app.post("/state", (req, res) => {
  const d = requireDevice(req, res); if (!d) return;
  const { relays, timers, info } = req.body; // optional fields
  d.state = { relays, timers, info };
  d.lastSeen = Date.now();
  res.json({ ok: true, serverTime: Date.now() });
});

// Device pulls queued commands
app.get("/pull", (req, res) => {
  const d = requireDevice(req, res); if (!d) return;
  d.lastSeen = Date.now();
  const cmds = d.queue.splice(0, d.queue.length); // drain
  res.json({ commands: cmds, serverTime: Date.now() });
});

// Phone/app pushes a command to a device (auth by a simple admin token in ENV)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-admin-token";
app.post("/push", (req, res) => {
  const { admin_token, device_id, command } = req.body;
  if (admin_token !== ADMIN_TOKEN) return res.status(401).json({ error: "bad admin_token" });
  if (!devices.has(device_id)) return res.status(404).json({ error: "unknown device_id" });
  if (!command || typeof command !== "object") return res.status(400).json({ error: "command object required" });
  // Command format suggestion:
  // { type: "set", ch:1, state:"on" } or { type:"timer", ch:1, action:"start" }
  devices.get(device_id).queue.push({ ...command, ts: Date.now() });
  res.json({ ok: true });
});

// Lightweight directory for your UI (list devices/last seen/state)
app.get("/devices", (req, res) => {
  const out = [];
  for (const [id, d] of devices) {
    out.push({ device_id: id, lastSeen: d.lastSeen, state: d.state || {} , queueLen: d.queue.length });
  }
  res.json(out);
});

// Static HTML control (very simple)
app.get("/", (_, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay Cloud Control</title>
<style>
body{font-family:system-ui;margin:16px}
table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ddd;padding:8px}
.card{border:1px solid #ddd;border-radius:12px;padding:12px;margin:12px 0}
input,button{font-size:16px;padding:6px 10px;border-radius:8px;border:1px solid #bbb}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
</style>
</head>
<body>
<h2>Relay Cloud Control</h2>
<div class="card">
  <div><b>Admin token</b> (set ADMIN_TOKEN env var in server):</div>
  <input id="adm" placeholder="admin token">
</div>

<div class="card">
  <div class="row">
    <button onclick="refresh()">Refresh devices</button>
  </div>
  <div id="list"></div>
</div>

<div class="card">
  <h3>Send Command</h3>
  <div class="row">
    <input id="dev" placeholder="device_id">
    <select id="type">
      <option value="set">set (on/off/toggle)</option>
      <option value="timer">timer (start/stop)</option>
    </select>
    <input id="ch" type="number" min="1" value="1" style="width:80px" placeholder="ch">
    <input id="arg" placeholder="state:on|off|toggle or action:start|stop">
    <button onclick="send()">Send</button>
  </div>
  <div id="out"></div>
</div>

<script>
async function refresh(){
  const r = await fetch('/devices');
  const js = await r.json();
  let html = '<table><tr><th>Device</th><th>Last seen</th><th>State</th><th>Queue</th></tr>';
  for(const d of js){
    const age = ((Date.now()-d.lastSeen)/1000).toFixed(1)+'s';
    html += '<tr><td>'+d.device_id+'</td><td>'+age+' ago</td><td><pre>'+JSON.stringify(d.state,null,2)+'</pre></td><td>'+d.queueLen+'</td></tr>';
  }
  html += '</table>';
  document.getElementById('list').innerHTML = html;
}
async function send(){
  const admin = document.getElementById('adm').value;
  const device_id = document.getElementById('dev').value.trim();
  const type = document.getElementById('type').value;
  const ch = parseInt(document.getElementById('ch').value||'1');
  const arg = document.getElementById('arg').value.trim();
  let command = null;
  if(type==='set'){
    // arg like "on"|"off"|"toggle"
    command = { type:'set', ch, state: arg||'toggle' };
  } else {
    // arg like "start"|"stop"
    command = { type:'timer', ch, action: arg||'start' };
  }
  const r = await fetch('/push',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ admin_token: admin, device_id, command })});
  const js = await r.json();
  document.getElementById('out').textContent = JSON.stringify(js,null,2);
}
refresh();
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Relay server listening on", PORT));
