import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

let image = "myimg.jpeg";
let width = 70;

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];

  if (argument === "--width") {
    width = Number(args[index + 1]);
    index += 1;
  } else if (argument.startsWith("--width=")) {
    width = Number(argument.slice("--width=".length));
  } else if (!argument.startsWith("-")) {
    image = argument;
  } else {
    console.error(`Unknown option: ${argument}`);
    process.exit(1);
  }
}

if (!Number.isInteger(width) || width < 20 || width > 150) {
  console.error("Width must be a whole number between 20 and 150.");
  process.exit(1);
}

const imagePath = path.resolve(ROOT, image);
if (!fs.existsSync(imagePath)) {
  console.error(`Image not found: ${imagePath}`);
  console.error("Place myimg.jpeg in this folder or pass another image path.");
  process.exit(1);
}

const conversion = spawnSync(
  "jp2a",
  [`--width=${width}`, "--background=light", imagePath],
  { encoding: "utf8" }
);

if (conversion.error?.code === "ENOENT") {
  console.error("jp2a is required but was not found in PATH.");
  console.error("On Ubuntu/Debian, install it with: sudo apt install jp2a");
  process.exit(1);
}

if (conversion.status !== 0) {
  console.error(conversion.stderr || "Image conversion failed.");
  process.exit(conversion.status || 1);
}

const ascii = conversion.stdout.replace(/\r/g, "").trimEnd();
if (!ascii) {
  console.error("jp2a returned an empty portrait.");
  process.exit(1);
}

const asciiFile = path.join(ROOT, "ascii.txt");
fs.writeFileSync(asciiFile, `${ascii}\n`, "utf8");
console.log(`Converted ${path.basename(imagePath)} to ascii.txt at width ${width}`);

const buildEnvironment = { ...process.env };
const hasEnvironmentToken =
  buildEnvironment.GITHUB_TOKEN ||
  buildEnvironment.GH_TOKEN ||
  buildEnvironment.GITHUB_PAT;

if (!hasEnvironmentToken) {
  const modernCli = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  const modernToken = modernCli.status === 0 ? modernCli.stdout.trim() : "";
  const legacyCli = modernToken
    ? null
    : spawnSync(
        "gh",
        ["auth", "status", "--hostname", "github.com", "--show-token"],
        { encoding: "utf8" }
      );
  const legacyOutput = `${legacyCli?.stdout ?? ""}\n${legacyCli?.stderr ?? ""}`;
  const legacyToken = legacyOutput.match(/Token:\s*(\S+)/)?.[1];
  let cliToken =
    modernToken ||
    (legacyToken && !/^\*+$/.test(legacyToken) ? legacyToken : "");

  if (!cliToken) {
    const configDirectory =
      process.env.GH_CONFIG_DIR ??
      path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
        "gh"
      );

    try {
      const hosts = fs.readFileSync(
        path.join(configDirectory, "hosts.yml"),
        "utf8"
      );
      cliToken = hosts.match(/^\s*oauth_token:\s*(\S+)\s*$/m)?.[1] ?? "";
    } catch {
      cliToken = "";
    }
  }

  if (cliToken) {
    buildEnvironment.GH_TOKEN = cliToken;
  } else {
    console.log(
      "ASCII portrait updated. SVG generation was skipped because no valid " +
        "GitHub token was found."
    );
    console.log("Run `gh auth login`, then run `npm run generate`.");
    process.exit(0);
  }
}

const build = spawnSync(process.execPath, [path.join(ROOT, "generate.mjs")], {
  env: buildEnvironment,
  encoding: "utf8",
  stdio: "inherit"
});

if (build.error || build.status !== 0) {
  console.error(build.error?.message || "SVG build failed.");
  process.exit(build.status || 1);
}
