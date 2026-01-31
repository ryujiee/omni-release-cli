const logEl = document.getElementById("log");

const modeEl = document.getElementById("mode");
const refsRawEl = document.getElementById("refsRaw");
const srcsRawEl = document.getElementById("srcsRaw");
const dstsRawEl = document.getElementById("dstsRaw");
const cntBugEl = document.getElementById("cntBug");
const cntFeatEl = document.getElementById("cntFeat");
const cntImprEl = document.getElementById("cntImpr");
const breakCompatEl = document.getElementById("breakCompat");

const btnRun = document.getElementById("btnRun");
const btnStatus = document.getElementById("btnStatus");
const btnClear = document.getElementById("btnClear");

// modal
const backdrop = document.getElementById("backdrop");
const pillKind = document.getElementById("pillKind");
const pillMode = document.getElementById("pillMode");
const kv = document.getElementById("kv");

const btnReloadStatus = document.getElementById("btnReloadStatus");
const btnContinue = document.getElementById("btnContinue");
const btnSkip = document.getElementById("btnSkip");
const btnAbort = document.getElementById("btnAbort");

function appendLog(line) {
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function setModal(open) {
  backdrop.style.display = open ? "flex" : "none";
}

function renderPauseState(p) {
  if (!p) {
    setModal(false);
    return;
  }

  pillKind.textContent = p.kind || "-";
  pillMode.textContent = p.mode || "-";

  const entries = [
    ["Destino", p.dst ?? "-"],
    ["Versão", p.fullVer ?? "-"],
    ["dstIndex", p.dstIndex ?? "-"],
    ["commitIndex", p.commitIndex ?? "-"],
    ["src", p.src ?? "-"],
    ["srcIndex", p.srcIndex ?? "-"],
  ];

  kv.innerHTML = entries
    .map(([k, v]) => `<div><b>${k}</b></div><div>${String(v)}</div>`)
    .join("");

  // só mostra Skip quando for cherry-pick/hotfix
  const showSkip = p.kind === "cherry-pick";
  btnSkip.style.display = showSkip ? "inline-block" : "none";

  setModal(true);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error ? `API ${path}: ${json.error}` : `API ${path} falhou`;
    throw new Error(msg);
  }
  return json;
}

async function getStatus() {
  const res = await fetch("/status");
  const json = await res.json();
  if (json?.paused) renderPauseState(json.pauseState);
  else setModal(false);
  return json;
}

// SSE
const ev = new EventSource("/events");
ev.onmessage = (e) => {
  try {
    const data = JSON.parse(e.data);
    if (data?.line) appendLog(data.line);
  } catch {
    // ignore
  }
};

// Actions
btnRun.addEventListener("click", async () => {
  try {
    const payload = {
      mode: modeEl.value,
      refsRaw: refsRawEl.value.trim(),
      srcsRaw: srcsRawEl.value.trim(),
      dstsRaw: dstsRawEl.value.trim(),
      cntBug: Number(cntBugEl.value || 0),
      cntFeat: Number(cntFeatEl.value || 0),
      cntImpr: Number(cntImprEl.value || 0),
      breakCompat: !!breakCompatEl.checked,
    };

    appendLog("▶️ /run disparado...");
    await api("/run", payload);
    await getStatus();
  } catch (e) {
    appendLog("❌ " + (e?.message || String(e)));
    await getStatus();
  }
});

btnStatus.addEventListener("click", async () => {
  try {
    const s = await getStatus();
    appendLog(`ℹ status: running=${s.running} paused=${s.paused}`);
  } catch (e) {
    appendLog("❌ " + (e?.message || String(e)));
  }
});

btnClear.addEventListener("click", () => {
  logEl.textContent = "";
});

btnReloadStatus.addEventListener("click", async () => {
  try {
    await getStatus();
  } catch (e) {
    appendLog("❌ " + (e?.message || String(e)));
  }
});

btnContinue.addEventListener("click", async () => {
  try {
    appendLog("▶️ /continue...");
    await api("/continue");
    await getStatus();
  } catch (e) {
    appendLog("❌ " + (e?.message || String(e)));
    await getStatus();
  }
});

btnSkip.addEventListener("click", async () => {
  try {
    appendLog("⏭ /skip...");
    await api("/skip");
    await getStatus();
  } catch (e) {
    appendLog("❌ " + (e?.message || String(e)));
    await getStatus();
  }
});

btnAbort.addEventListener("click", async () => {
  try {
    appendLog("🛑 /abort...");
    await api("/abort");
    await getStatus();
  } catch (e) {
    appendLog("❌ " + (e?.message || String(e)));
    await getStatus();
  }
});

// carregamento inicial
getStatus().catch(() => {});
