import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(FRONTEND, "..");
const IMAGES = join(REPO, "docs", "images");
const FRAMES = join(FRONTEND, "test-results", "docs-frames");
const IMAGE = "mcr.microsoft.com/playwright:v1.64.1-noble";
const MAX_BYTES = 2 * 1024 * 1024;
const ANIMATIONS = {
  live: { fps: 5, width: 720 },
  wall: { fps: 8, width: 720 },
  wizard: { fps: 3, width: 320 },
};
const FLAGS = ["--docs", "--check", "--docker", "--no-assemble", "--assemble"];

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const rest = args.filter((a) => !FLAGS.includes(a));
const mode = has("--check") ? "check" : has("--docs") ? "write" : null;

function run(command, argv, env = {}) {
  const result = spawnSync(command, argv, { cwd: FRONTEND, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.error) {
    console.error(`shots: ${command}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function playwright(extra, env) {
  return run("npx", ["playwright", "test", ...extra, ...rest], env);
}

function assemble() {
  if (!existsSync(FRAMES)) {
    console.error("shots: no animation frames; run with --docs first");
    return 1;
  }
  mkdirSync(IMAGES, { recursive: true });
  let status = 0;
  for (const [name, { fps, width }] of Object.entries(ANIMATIONS)) {
    const dir = join(FRAMES, name);
    if (!existsSync(dir) || readdirSync(dir).length === 0) {
      console.error(`shots: no frames for ${name}`);
      status = 1;
      continue;
    }
    const out = join(IMAGES, `${name}.gif`);
    const filter = `scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
    const code = run("ffmpeg", ["-v", "error", "-y", "-framerate", String(fps), "-i", join(dir, "%04d.png"), "-vf", filter, "-loop", "0", out]);
    if (code !== 0) {
      console.error("shots: ffmpeg failed; install it (e.g. nix shell nixpkgs#ffmpeg) and run npm run shots -- --assemble");
      return code;
    }
    const size = statSync(out).size;
    console.log(`shots: wrote ${out} (${Math.round(size / 1024)} KB)`);
    if (size > MAX_BYTES) {
      console.error(`shots: ${name}.gif is larger than ${MAX_BYTES / 1024 / 1024} MB`);
      status = 1;
    }
  }
  return status;
}

function docker() {
  const inner = mode === "check" ? "--check" : "--docs --no-assemble";
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const script = [
    "npm ci --no-audit --no-fund --loglevel=error",
    `node scripts/shots.mjs ${inner} ${rest.join(" ")}`.trim(),
  ].join(" && ");
  const code = run("docker", [
    "run", "--rm", "--ipc=host", "--init",
    "-v", `${REPO}:/work`,
    "-v", "outglow-ha-node-modules:/work/frontend/node_modules",
    "-w", "/work/frontend",
    "-e", "CI=1", "-e", "PW_CHANNEL=chromium", "-e", "HOME=/tmp",
    IMAGE,
    "bash", "-c", `${script}; code=$?; chown -R ${uid}:${gid} /work/docs/images /work/frontend/test-results 2>/dev/null; exit $code`,
  ]);
  if (code !== 0 || mode === "check" || has("--no-assemble")) {
    return code;
  }
  return assemble();
}

function main() {
  if (has("--assemble")) {
    return assemble();
  }
  if (mode === null) {
    return playwright(["e2e/screenshots.spec.ts"]);
  }
  if (has("--docker")) {
    return docker();
  }
  if (mode === "write") {
    rmSync(FRAMES, { recursive: true, force: true });
  }
  const update = mode === "write" ? ["--update-snapshots=changed"] : [];
  const code = playwright(["e2e/docs.spec.ts", "--project=chrome", ...update], { OUTGLOW_DOCS: mode });
  if (code !== 0) {
    if (mode === "check") {
      console.error("shots: the documentation images are out of date; run make docs-images (or npm run shots -- --docs --docker)");
    }
    return code;
  }
  return mode === "write" && !has("--no-assemble") ? assemble() : 0;
}

process.exit(main());
