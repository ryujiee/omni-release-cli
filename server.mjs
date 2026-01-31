import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const app = express();

const PROJECT_DIR = "/New-Omni";
const VERSION_FILE = "frontend/public/VERSION";
const VER_FILES = ["frontend/public/VERSION", "VERSION", "frontend/.env.version"];

const RELEASE_NOTES_FILES = [
  "frontend/public/release-notes.en-US.json",
  "frontend/public/release-notes.es-ES.json",
  "frontend/public/release-notes.pt-BR.json",
];

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

let clients = new Set();
let isRunning = false;

// =====================
// Pause / Resume support
// =====================
class PauseForConflict extends Error {
  constructor(message) {
    super(message);
    this.name = "PauseForConflict";
  }
}

/**
 * pauseState pode representar:
 * - hotfix cherry-pick
 * - merge (beta/prod/manual)
 *
 * Hotfix shape:
 * {
 *   kind: "cherry-pick",
 *   mode: "hotfix",
 *   fullVer, notesVer,
 *   refs, destinations,
 *   dstIndex,
 *   dst,
 *   commits,
 *   commitIndex
 * }
 *
 * Merge shape:
 * {
 *   kind: "merge",
 *   mode: "manual"|"beta"|"prod",
 *   fullVer, notesVer,
 *   // manual:
 *   destinations, dstIndex, dst,
 *   srcs, srcIndex, src,
 *   // beta/prod:
 *   brSrc, brDst
 * }
 */
let pauseState = null;

// ===============
// SSE broadcast
// ===============
function broadcast(line) {
  for (const res of clients) {
    res.write(`data: ${JSON.stringify({ line })}\n\n`);
  }
}

function runCmd(cmd, args, { cwd = PROJECT_DIR } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    let err = "";

    p.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      s.split(/\r?\n/)
        .filter(Boolean)
        .forEach((l) => broadcast(l));
    });

    p.stderr.on("data", (d) => {
      const s = d.toString();
      err += s;
      s.split(/\r?\n/)
        .filter(Boolean)
        .forEach((l) => broadcast(l));
    });

    p.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${cmd} ${args.join(" ")} (exit=${code})\n${err || out}`));
    });
  });
}

async function ensureCleanTree() {
  const st = await runCmd("git", ["status", "--porcelain"]);
  if (st) {
    throw new Error("Working tree não está limpo. Faça commit/stash antes.\n" + st);
  }
}

async function tagExistsRemote(tag) {
  try {
    const out = await runCmd("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
    return !!out;
  } catch {
    return false;
  }
}

async function tagExistsLocal(tag) {
  try {
    await runCmd("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
}

async function getLatestSemverTag() {
  const raw = await runCmd("bash", ["-lc", `git tag -l "v[0-9]*.[0-9]*.[0-9]*"`]).catch(() => "");
  const tags = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!tags.length) return "0.0.0";

  const versions = tags
    .map((t) => t.match(/^v(\d+\.\d+\.\d+)$/)?.[1])
    .filter(Boolean);

  if (!versions.length) return "0.0.0";

  versions.sort((a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    if (pa[0] !== pb[0]) return pb[0] - pa[0];
    if (pa[1] !== pb[1]) return pb[1] - pa[1];
    return pb[2] - pa[2];
  });

  return versions[0];
}

function bumpSemver(base, type) {
  const [M, m, p] = base.split(".").map((x) => parseInt(x, 10));
  let major = M, minor = m, patch = p;

  if (type === "major") {
    major++;
    minor = 0;
    patch = 0;
  } else if (type === "minor") {
    minor++;
    patch = 0;
  } else if (type === "patch") {
    patch++;
  } else {
    throw new Error("Tipo inválido: " + type);
  }

  return `${major}.${minor}.${patch}`;
}

async function computeNextVersion({ cntBug, cntFeat, cntImpr, breakCompat }) {
  const base = await getLatestSemverTag();
  let type = null;

  if (breakCompat) type = "major";
  else if (cntFeat > 0 || cntImpr > 0) type = "minor";
  else if (cntBug > 0) type = "patch";
  else throw new Error("Nenhuma alteração registrada (bugs/features/melhorias = 0).");

  return { next: bumpSemver(base, type), versionType: type.toUpperCase() };
}

async function updateVersionFileIfNeeded(value) {
  await runCmd("bash", ["-lc", `mkdir -p "$(dirname "${VERSION_FILE}")"`]);
  const current = await runCmd("bash", ["-lc", `test -f "${VERSION_FILE}" && cat "${VERSION_FILE}" || true`]);

  if (current.trim() === value) {
    broadcast(`ℹ ${VERSION_FILE} já está em ${value} — nenhum commit necessário.`);
    return;
  }

  await runCmd("bash", ["-lc", `printf "%s" "${value}" > "${VERSION_FILE}"`]);
  await runCmd("git", ["add", VERSION_FILE]);

  try {
    await runCmd("git", ["diff", "--cached", "--quiet", "--", VERSION_FILE]);
  } catch {
    await runCmd("git", ["commit", "-m", `⬆ Atualiza ${VERSION_FILE} para ${value}`]);
  }
}

async function updateReleaseNotesIfNeeded(notesVer) {
  let changed = false;

  for (const file of RELEASE_NOTES_FILES) {
    let raw;
    try {
      raw = await fs.readFile(`${PROJECT_DIR}/${file}`, "utf8");
    } catch {
      broadcast(`⚠ Release notes não encontrado: ${file} (pulando)`);
      continue;
    }

    let json;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new Error(`JSON inválido em ${file}: ${e?.message || e}`);
    }

    if (json?.version === notesVer) {
      broadcast(`ℹ ${file} já está em ${notesVer}`);
      continue;
    }

    json.version = notesVer;
    await fs.writeFile(`${PROJECT_DIR}/${file}`, JSON.stringify(json, null, 2) + "\n", "utf8");
    changed = true;
    broadcast(`✅ Atualizado ${file} → version=${notesVer}`);
  }

  if (!changed) {
    broadcast("ℹ Nenhuma alteração em release-notes — nenhum commit necessário.");
    return;
  }

  await runCmd("git", ["add", ...RELEASE_NOTES_FILES]);

  try {
    await runCmd("git", ["diff", "--cached", "--quiet"]);
  } catch {
    await runCmd("git", ["commit", "-m", `📝 Atualiza release-notes para ${notesVer}`]);
  }
}

async function autoResolveVersionConflicts() {
  for (const f of VER_FILES) {
    try {
      await runCmd("git", ["ls-files", "--unmerged", "--", f]);
      await runCmd("git", ["checkout", "--ours", "--", f]).catch(() => {});
      await runCmd("git", ["add", "--", f]).catch(() => {});
    } catch {
      // not unmerged
    }
  }
}

async function hasUnmergedFiles() {
  try {
    const out = await runCmd("git", ["ls-files", "-u"]);
    return !!out;
  } catch {
    return false;
  }
}

async function isMergeInProgress() {
  try {
    await runCmd("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function isCherryPickInProgress() {
  try {
    await runCmd("git", ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function safePull(branch) {
  await runCmd("git", ["fetch", "origin", branch]);

  try {
    await runCmd("git", ["merge", "--ff-only", `origin/${branch}`]);
    return;
  } catch {}

  broadcast(`⚠ ${branch} divergiu; fazendo merge commit para sincronizar...`);
  try {
    await runCmd("git", ["merge", "--no-ff", `origin/${branch}`, "-m", `🔄 Sync ${branch} com origin/${branch}`]);
    return;
  } catch {
    broadcast("⚠ Conflitos no sync. Tentando resolver VERSION automaticamente...");
    await autoResolveVersionConflicts();

    if (await hasUnmergedFiles()) {
      throw new Error("Conflitos restantes no sync. Resolva manualmente e finalize o merge.");
    }

    await runCmd("git", ["commit", "--no-edit"]).catch(async () => {
      await runCmd("git", ["commit", "-m", `🔄 Sync ${branch} (auto-resolve VERSION)`]);
    });
  }
}

// =====================
// Merge with Pause
// =====================
function isMergeConflict(err) {
  const msg = (err?.message || "").toLowerCase();
  return msg.includes("conflict") || msg.includes("merge conflict");
}

async function safeMergeWithPause(srcRef, msg, ctxForPause) {
  try {
    await runCmd("git", ["merge", srcRef, "--no-ff", "-m", msg]);
    return;
  } catch (e) {
    broadcast("⚠ Merge com conflitos. Tentando resolver VERSION automaticamente...");
    await autoResolveVersionConflicts();

    if (await hasUnmergedFiles()) {
      pauseState = {
        kind: "merge",
        ...(ctxForPause || {}),
      };

      broadcast("⏸ Conflito detectado no MERGE!");
      broadcast("➡️ Resolva os conflitos no VSCode/terminal.");
      broadcast("➡️ Rode: git add <arquivos-resolvidos>");
      broadcast('➡️ Depois clique: "Conflitos resolvidos" (POST /continue)');
      broadcast('➡️ (Opcional) "Abortar" (POST /abort)');

      throw new PauseForConflict("PAUSED_FOR_CONFLICT_MERGE");
    }

    // se não sobrou conflito, tenta commitar
    await runCmd("git", ["commit", "--no-edit"]).catch(() => {});
  }
}

// =====================
// Hotfix cherry-pick support
// =====================
async function resolveHotfixCommits(input, dst) {
  // se for commit válido
  try {
    const c = await runCmd("git", ["rev-parse", "-q", "--verify", `${input}^{commit}`]);
    if (c) return [c];
  } catch {}

  // tenta origin/<input>
  try {
    await runCmd("git", ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${input}`]);
    input = `origin/${input}`;
  } catch {}

  const isRef = await runCmd("bash", [
    "-lc",
    `git show-ref --verify --quiet "refs/remotes/${input}" || git show-ref --verify --quiet "refs/heads/${input}" ; echo $?`,
  ]);
  if (isRef.trim() !== "0") throw new Error(`Não consegui resolver '${input}' como commit ou branch/ref.`);

  const list = await runCmd("git", ["rev-list", "--reverse", `${dst}..${input}`]).catch(() => "");
  return list ? list.split("\n").filter(Boolean) : [];
}

function isCherryPickConflict(err) {
  const msg = (err?.message || "").toLowerCase();
  return msg.includes("conflict") || msg.includes("could not apply") || msg.includes("merge conflict");
}

async function buildCommitsForDst(dst, refs) {
  const commits = [];
  for (const ref of refs) {
    broadcast(`🔎 Resolvendo '${ref}' para commits em '${dst}'...`);
    const list = await resolveHotfixCommits(ref, dst);
    for (const c of list) commits.push(c);
  }
  return commits;
}

async function applyCommitsWithPause({ dst, commits, startIndex = 0, ctx }) {
  for (let i = startIndex; i < commits.length; i++) {
    const c = commits[i];

    try {
      await runCmd("git", ["cherry-pick", c]);
    } catch (e) {
      const msg = (e?.message || "").toLowerCase();

      if (msg.includes("cherry-pick is now empty") || msg.includes("nothing to commit")) {
        broadcast(`ℹ Cherry-pick vazio (${c.slice(0, 8)}). Pulando...`);
        await runCmd("git", ["cherry-pick", "--skip"]);
        continue;
      }

      if (isCherryPickConflict(e)) {
        pauseState = {
          kind: "cherry-pick",
          ...(ctx || {}),
          mode: "hotfix",
          dst,
          commits,
          commitIndex: i,
        };

        broadcast("⏸ Conflito detectado no cherry-pick!");
        broadcast("➡️ Resolva os conflitos no VSCode/terminal.");
        broadcast("➡️ Rode: git add <arquivos-resolvidos>");
        broadcast('➡️ Depois clique: "Conflitos resolvidos" (POST /continue)');
        broadcast('➡️ (Opcional) "Pular commit" (POST /skip) ou "Abortar" (POST /abort)');

        throw new PauseForConflict("PAUSED_FOR_CONFLICT_CHERRYPICK");
      }

      throw e;
    }
  }
}

async function finalizeDstAfterCommits({ dst, fullVer, notesVer }) {
  await updateVersionFileIfNeeded(fullVer);
  await updateReleaseNotesIfNeeded(notesVer);

  if (!(await tagExistsRemote(fullVer))) {
    if (!(await tagExistsLocal(fullVer))) {
      await runCmd("git", ["tag", "-a", fullVer, "-m", `🔖 Versão ${fullVer} aplicada em ${dst}`]);
    }
    await runCmd("git", ["push", "origin", fullVer]);
  } else {
    broadcast(`⚠ Tag remota ${fullVer} já existe. Pulando tag.`);
  }

  await runCmd("git", ["push", "origin", dst]);
  broadcast(`✅ Hotfix aplicado em ${dst}`);
}

// =====================
// SSE
// =====================
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  clients.add(res);
  res.write(`data: ${JSON.stringify({ line: "✅ Conectado. Pronto para gerar versão." })}\n\n`);

  req.on("close", () => clients.delete(res));
});

// =====================
// Run
// =====================
app.post("/run", async (req, res) => {
  const payload = req.body;

  if (isRunning) return res.status(409).json({ ok: false, error: "already_running" });
  if (pauseState) return res.status(409).json({ ok: false, error: "paused_waiting_conflict_resolution" });

  isRunning = true;

  (async () => {
    try {
      broadcast("==> Iniciando processo...");
      await runCmd("git", ["fetch", "--all", "--prune"]);
      await ensureCleanTree();

      const {
        mode,
        refsRaw,
        srcsRaw,
        dstsRaw,
        cntBug,
        cntFeat,
        cntImpr,
        breakCompat,
      } = payload;

      const destinations = (dstsRaw || "").split(/\s+/).filter(Boolean);
      const refs = (refsRaw || "").split(/\s+/).filter(Boolean);
      const srcs = (srcsRaw || "").split(/\s+/).filter(Boolean);

      const { next, versionType } = await computeNextVersion({
        cntBug: Number(cntBug || 0),
        cntFeat: Number(cntFeat || 0),
        cntImpr: Number(cntImpr || 0),
        breakCompat: !!breakCompat,
      });

      let suffix = "";
      let brSrc = null;
      let brDst = null;
      let mergeMsg = null;

      if (mode === "beta") {
        brSrc = "develop";
        brDst = "release";
        suffix = "-beta";
        mergeMsg = "🔀 Merge develop → release";
      } else if (mode === "prod") {
        brSrc = "release";
        brDst = "main";
        mergeMsg = "🎯 Release";
      }

      const fullVer = `v${next}${suffix}`;
      const notesVer = fullVer.replace(/^v/, "");
      broadcast(`🔖 Próxima versão ${versionType} → ${fullVer}`);

      // ===== beta/prod (merge único) =====
      if (mode === "beta" || mode === "prod") {
        await runCmd("git", ["checkout", brSrc]);
        await safePull(brSrc);

        await runCmd("git", ["checkout", brDst]);
        await safePull(brDst);

        await safeMergeWithPause(brSrc, `${mergeMsg} ${fullVer}`, {
          mode,
          fullVer,
          notesVer,
          brSrc,
          brDst,
          dst: brDst,
        });

        await updateVersionFileIfNeeded(fullVer);
        await updateReleaseNotesIfNeeded(notesVer);

        if (await tagExistsRemote(fullVer)) {
          broadcast(`⚠ Tag remota ${fullVer} já existe. Pulando criação/push da tag.`);
        } else {
          if (!(await tagExistsLocal(fullVer))) {
            await runCmd("git", ["tag", "-a", fullVer, "-m", `${mergeMsg} ${fullVer}`]);
          }
          await runCmd("git", ["push", "origin", fullVer]);
        }

        await runCmd("git", ["push", "origin", brDst]);
        broadcast(`✅ Concluído: ${fullVer} em ${brDst}`);
      }

      // ===== manual (vários merges) =====
      if (mode === "manual") {
        for (let di = 0; di < destinations.length; di++) {
          const dst = destinations[di];

          await runCmd("git", ["checkout", dst]);
          await safePull(dst);

          for (let si = 0; si < srcs.length; si++) {
            const src = srcs[si];
            broadcast(`🔀 Merge ${src} → ${dst}...`);

            await safeMergeWithPause(`origin/${src}`, `🔀 Merge ${src} → ${dst} na versão ${fullVer}`, {
              mode,
              fullVer,
              notesVer,
              destinations,
              dstIndex: di,
              dst,
              srcs,
              srcIndex: si,
              src,
            });
          }

          await updateVersionFileIfNeeded(fullVer);
          await updateReleaseNotesIfNeeded(notesVer);

          if (!(await tagExistsRemote(fullVer))) {
            if (!(await tagExistsLocal(fullVer))) {
              await runCmd("git", ["tag", "-a", fullVer, "-m", `🔖 Versão ${fullVer} aplicada em ${dst}`]);
            }
            await runCmd("git", ["push", "origin", fullVer]);
          } else {
            broadcast(`⚠ Tag remota ${fullVer} já existe. Pulando tag.`);
          }

          await runCmd("git", ["push", "origin", dst]);
          broadcast(`✅ Manual aplicado em ${dst}`);
        }
      }

      // ===== hotfix (cherry-pick com pause) =====
      if (mode === "hotfix") {
        for (let di = 0; di < destinations.length; di++) {
          const dst = destinations[di];

          await runCmd("git", ["checkout", dst]);
          await safePull(dst);

          const commitsToApply = await buildCommitsForDst(dst, refs);

          if (!commitsToApply.length) {
            broadcast(`ℹ Nada novo para aplicar em '${dst}'.`);
          } else {
            broadcast(`🍒 Aplicando ${commitsToApply.length} commit(s) em '${dst}'...`);

            const ctx = { fullVer, notesVer, refs, destinations, dstIndex: di };
            await applyCommitsWithPause({ dst, commits: commitsToApply, startIndex: 0, ctx });
          }

          await finalizeDstAfterCommits({ dst, fullVer, notesVer });
        }
      }

      broadcast("🚀 Processo finalizado com sucesso.");
    } catch (e) {
      if (e?.name === "PauseForConflict") {
        broadcast("⏸ Processo pausado aguardando resolução de conflitos.");
        return;
      }
      broadcast("❌ ERRO: " + (e?.message || String(e)));
    } finally {
      // se pausou, mantém isRunning=true pra bloquear /run
      if (!pauseState) isRunning = false;
    }
  })();

  res.json({ ok: true });
});

// =====================
// Continue / Skip / Abort
// =====================
app.post("/continue", async (req, res) => {
  if (!pauseState) return res.status(409).json({ ok: false, error: "no_pause_state" });

  try {
    if (await hasUnmergedFiles()) {
      broadcast("⚠ Ainda existem conflitos pendentes. Resolva e rode: git add <arquivos>.");
      return res.status(409).json({ ok: false, error: "still_conflicts" });
    }

    // ========= MERGE =========
    if (pauseState.kind === "merge") {
      broadcast("▶️ Continuando MERGE após resolução...");

      // Finaliza merge (o git deixa MERGE_HEAD e exige commit)
      if (await isMergeInProgress()) {
        // em algumas versões existe git merge --continue, mas commit é universal
        await runCmd("git", ["commit", "--no-edit"]).catch(async () => {
          await runCmd("git", ["commit", "-m", "✅ Resolve conflitos do merge"]);
        });
      }

      const { mode } = pauseState;

      // ---- beta/prod: só finalizar e seguir push/tag
      if (mode === "beta" || mode === "prod") {
        const { fullVer, notesVer, brDst } = pauseState;

        await updateVersionFileIfNeeded(fullVer);
        await updateReleaseNotesIfNeeded(notesVer);

        if (await tagExistsRemote(fullVer)) {
          broadcast(`⚠ Tag remota ${fullVer} já existe. Pulando criação/push da tag.`);
        } else {
          if (!(await tagExistsLocal(fullVer))) {
            await runCmd("git", ["tag", "-a", fullVer, "-m", `🔖 ${fullVer}`]);
          }
          await runCmd("git", ["push", "origin", fullVer]);
        }

        await runCmd("git", ["push", "origin", brDst]);
        broadcast(`✅ Concluído: ${fullVer} em ${brDst}`);

        pauseState = null;
        isRunning = false;
        broadcast("🚀 Processo finalizado com sucesso.");
        return res.json({ ok: true });
      }

      // ---- manual: continuar loops do ponto onde parou
      if (mode === "manual") {
        const { fullVer, notesVer, destinations, dstIndex, dst, srcs, srcIndex } = pauseState;

        // continua srcs restantes no mesmo dst
        for (let si = srcIndex + 1; si < srcs.length; si++) {
          const src = srcs[si];
          broadcast(`🔀 Merge ${src} → ${dst}...`);

          await safeMergeWithPause(`origin/${src}`, `🔀 Merge ${src} → ${dst} na versão ${fullVer}`, {
            kind: "merge",
            mode,
            fullVer,
            notesVer,
            destinations,
            dstIndex,
            dst,
            srcs,
            srcIndex: si,
            src,
          });
        }

        // finaliza destino atual
        await updateVersionFileIfNeeded(fullVer);
        await updateReleaseNotesIfNeeded(notesVer);

        if (!(await tagExistsRemote(fullVer))) {
          if (!(await tagExistsLocal(fullVer))) {
            await runCmd("git", ["tag", "-a", fullVer, "-m", `🔖 Versão ${fullVer} aplicada em ${dst}`]);
          }
          await runCmd("git", ["push", "origin", fullVer]);
        } else {
          broadcast(`⚠ Tag remota ${fullVer} já existe. Pulando tag.`);
        }

        await runCmd("git", ["push", "origin", dst]);
        broadcast(`✅ Manual aplicado em ${dst}`);

        // continua próximos destinos
        for (let di = dstIndex + 1; di < destinations.length; di++) {
          const nextDst = destinations[di];

          await runCmd("git", ["checkout", nextDst]);
          await safePull(nextDst);

          for (let si = 0; si < srcs.length; si++) {
            const src = srcs[si];
            broadcast(`🔀 Merge ${src} → ${nextDst}...`);

            await safeMergeWithPause(`origin/${src}`, `🔀 Merge ${src} → ${nextDst} na versão ${fullVer}`, {
              kind: "merge",
              mode,
              fullVer,
              notesVer,
              destinations,
              dstIndex: di,
              dst: nextDst,
              srcs,
              srcIndex: si,
              src,
            });
          }

          await updateVersionFileIfNeeded(fullVer);
          await updateReleaseNotesIfNeeded(notesVer);

          if (!(await tagExistsRemote(fullVer))) {
            if (!(await tagExistsLocal(fullVer))) {
              await runCmd("git", ["tag", "-a", fullVer, "-m", `🔖 Versão ${fullVer} aplicada em ${nextDst}`]);
            }
            await runCmd("git", ["push", "origin", fullVer]);
          } else {
            broadcast(`⚠ Tag remota ${fullVer} já existe. Pulando tag.`);
          }

          await runCmd("git", ["push", "origin", nextDst]);
          broadcast(`✅ Manual aplicado em ${nextDst}`);
        }

        pauseState = null;
        isRunning = false;
        broadcast("🚀 Processo finalizado com sucesso.");
        return res.json({ ok: true });
      }
    }

    // ========= CHERRY-PICK (hotfix) =========
    if (pauseState.kind === "cherry-pick") {
      const { fullVer, notesVer, refs, destinations, dstIndex, dst, commits, commitIndex } = pauseState;

      broadcast("▶️ Continuando cherry-pick após resolução...");

      if (await isCherryPickInProgress()) {
        await runCmd("git", ["cherry-pick", "--continue"]);
      }

      await applyCommitsWithPause({
        dst,
        commits,
        startIndex: commitIndex + 1,
        ctx: { fullVer, notesVer, refs, destinations, dstIndex },
      });

      await finalizeDstAfterCommits({ dst, fullVer, notesVer });

      for (let di = dstIndex + 1; di < destinations.length; di++) {
        const nextDst = destinations[di];

        await runCmd("git", ["checkout", nextDst]);
        await safePull(nextDst);

        const commitsToApply = await buildCommitsForDst(nextDst, refs);

        if (!commitsToApply.length) {
          broadcast(`ℹ Nada novo para aplicar em '${nextDst}'.`);
        } else {
          broadcast(`🍒 Aplicando ${commitsToApply.length} commit(s) em '${nextDst}'...`);

          await applyCommitsWithPause({
            dst: nextDst,
            commits: commitsToApply,
            startIndex: 0,
            ctx: { fullVer, notesVer, refs, destinations, dstIndex: di },
          });
        }

        await finalizeDstAfterCommits({ dst: nextDst, fullVer, notesVer });
      }

      pauseState = null;
      isRunning = false;
      broadcast("🚀 Processo finalizado com sucesso.");
      return res.json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: "unknown_pause_kind" });
  } catch (e) {
    if (e?.name === "PauseForConflict") {
      return res.status(409).json({ ok: false, error: "paused_again" });
    }
    broadcast("❌ ERRO ao continuar: " + (e?.message || String(e)));
    return res.status(500).json({ ok: false, error: "continue_failed" });
  }
});

app.post("/skip", async (req, res) => {
  if (!pauseState) return res.status(409).json({ ok: false, error: "no_pause_state" });
  if (pauseState.kind !== "cherry-pick") {
    return res.status(409).json({ ok: false, error: "skip_only_for_cherrypick" });
  }

  try {
    broadcast("⏭ Pulando commit atual do cherry-pick...");
    await runCmd("git", ["cherry-pick", "--skip"]);
    return res.json({ ok: true });
  } catch (e) {
    broadcast("❌ ERRO ao pular: " + (e?.message || String(e)));
    return res.status(500).json({ ok: false, error: "skip_failed" });
  }
});

app.post("/abort", async (req, res) => {
  if (!pauseState) return res.status(409).json({ ok: false, error: "no_pause_state" });

  try {
    broadcast("🛑 Abortando operação e limpando estado...");

    // tenta abortar merge/cherry-pick (tanto faz qual estiver)
    await runCmd("git", ["merge", "--abort"]).catch(() => {});
    await runCmd("git", ["cherry-pick", "--abort"]).catch(() => {});

    pauseState = null;
    isRunning = false;

    broadcast("✅ Abort concluído. Estado limpo.");
    return res.json({ ok: true });
  } catch (e) {
    broadcast("❌ ERRO ao abortar: " + (e?.message || String(e)));
    return res.status(500).json({ ok: false, error: "abort_failed" });
  }
});

// status pra UI
app.get("/status", (req, res) => {
  res.json({
    ok: true,
    running: isRunning,
    paused: !!pauseState,
    pauseState: pauseState
      ? {
          kind: pauseState.kind,
          mode: pauseState.mode,
          dst: pauseState.dst || pauseState.brDst,
          dstIndex: pauseState.dstIndex ?? null,
          commitIndex: pauseState.commitIndex ?? null,
          src: pauseState.src ?? null,
          srcIndex: pauseState.srcIndex ?? null,
          fullVer: pauseState.fullVer ?? null,
        }
      : null,
  });
});

// Apenas localhost
const PORT = 3000;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`✅ UI local rodando em http://127.0.0.1:${PORT}`);
});
