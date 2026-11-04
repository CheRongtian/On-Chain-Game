import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, saveJson } from "./deployment.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const owner =
  process.env.ARENA_TEST_PROJECT_ROOT === projectRoot
    ? resolve(projectRoot, "../..")
    : projectRoot;
const dynamicFiles = new Set([
  "client/public/deployment.json",
  "client/public/legacy-deployment.json",
  "client/dist/deployment.json",
  "client/dist/legacy-deployment.json",
]);

async function cached(file) {
  return readJson(file).catch((error) => {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  });
}

// These digests replace expensive Vite/BuildKit runs and control whether they execute.
async function digest(paths, settings) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(settings));
  async function add(file) {
    const name = relative(projectRoot, file);
    if (dynamicFiles.has(name)) return;
    const info = await stat(file).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    hash.update(name + "\0");
    if (!info) {
      hash.update("missing\0");
      return;
    }
    if (info.isDirectory()) {
      for (const child of (await readdir(file)).sort())
        await add(resolve(file, child));
    } else {
      hash.update(await readFile(file));
      hash.update("\0");
    }
  }
  for (const file of [...paths].sort()) await add(resolve(projectRoot, file));
  return hash.digest("hex");
}

const compose = [
  "compose",
  "--project-name",
  process.env.ARENA_COMPOSE_PROJECT || "onchain-arena",
  "--project-directory",
  projectRoot,
  "-f",
  resolve(projectRoot, "compose.yaml"),
];
function inspectImage(name) {
  let text;
  try {
    text = execFileSync("docker", ["image", "inspect", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    if (error.status !== 1) throw error;
    return;
  }
  return JSON.parse(text)[0];
}

async function images() {
  const text = execFileSync(
    "docker",
    [...compose, "config", "--format", "json"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error("Compose did not return a valid build configuration.");
  }
  const file = resolve(owner, ".local/build-cache/images.json");
  const records = (await cached(file)) ?? {};
  for (const name of ["db", "api"]) {
    const service = config.services[name];
    const build = service.build;
    const recipe =
      build.dockerfile_inline ??
      (await readFile(
        resolve(build.context, build.dockerfile || "Dockerfile"),
        "utf8",
      ));
    const baseName = recipe.match(/^FROM\s+(\S+)/im)?.[1];
    const base = baseName && inspectImage(baseName);
    const previous = records[name];
    const baseId =
      base?.Id ??
      (previous?.baseName === baseName ? previous.baseId : undefined);
    const platform =
      service.platform ??
      (base ? `${base.Os}/${base.Architecture}` : previous?.platform);
    // The API Dockerfile copies the compiled binary and its process launcher.
    const inputs =
      name === "api"
        ? [
            "Dockerfile",
            ".dockerignore",
            ".local/bin/arena-server-linux",
            "scripts/container-backend.sh",
          ]
        : [];
    const signature = await digest(inputs, {
      recipe,
      base: baseId,
      platform,
      args: build.args,
      target: build.target,
    });
    const image = inspectImage(service.image);
    if (
      image &&
      records[name]?.signature === signature &&
      records[name].imageId === image.Id
    ) {
      console.log(
        `Reusing ${name} image: build inputs, base image and image ID match.`,
      );
      continue;
    }
    if (!base)
      throw new Error(
        `Required local base image is missing: ${baseName}. Prepare it with docker pull ${baseName} before rebuilding ${name}.`,
      );
    console.log(
      `Building ${name}: the image is missing or its recorded inputs no longer match.`,
    );
    execFileSync("docker", [...compose, "build", name], {
      cwd: projectRoot,
      stdio: "inherit",
    });
    const built = inspectImage(service.image);
    if (!built)
      throw new Error(`The ${name} build did not create ${service.image}.`);
    records[name] = {
      signature,
      imageId: built.Id,
      baseName,
      baseId,
      platform,
    };
    await saveJson(file, records);
  }
}

async function frontend() {
  const require = createRequire(resolve(projectRoot, "client/package.json"));
  const { loadEnv } = await import(require.resolve("vite"));
  const file = resolve(projectRoot, ".local/frontend-build.json");
  const inputs = await digest(
    [
      "client/src",
      "client/public",
      "client/index.html",
      "client/vite.config.js",
      "client/tsconfig.json",
      "client/package.json",
      "client/package-lock.json",
      "client/node_modules/.package-lock.json",
    ],
    {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      mode: "production",
      nodeEnvironment: process.env.NODE_ENV ?? "production",
      publicEnvironment: loadEnv("production", projectRoot, "VITE_"),
    },
  );
  const previous = await cached(file);
  if (
    previous?.inputs === inputs &&
    previous.outputs === (await digest(["client/dist"], {}))
  ) {
    console.log(
      "Reusing frontend production assets: sources, configuration, dependencies and output files match.",
    );
    return;
  }
  console.log(
    "Building frontend production assets: inputs changed or cached output is missing or damaged.",
  );
  execFileSync("npm", ["run", "build"], {
    cwd: resolve(projectRoot, "client"),
    stdio: "inherit",
  });
  await stat(resolve(projectRoot, "client/dist/index.html"));
  await saveJson(file, { inputs, outputs: await digest(["client/dist"], {}) });
}

try {
  if (process.argv[2] === "images") await images();
  else if (process.argv[2] === "frontend") await frontend();
  else
    throw new Error("Expected an internal image or frontend build operation.");
} catch (error) {
  console.error(`Build preparation failed: ${error.message}`);
  process.exitCode = 1;
}
