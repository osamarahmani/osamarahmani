import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  fs.readFileSync(path.join(ROOT, "profile.json"), "utf8")
);
const asciiPortrait = fs
  .readFileSync(path.join(ROOT, "ascii.txt"), "utf8")
  .replace(/\r/g, "")
  .trimEnd();

const username = config.username;
function resolveGitHubToken() {
  const environmentToken =
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN ??
    process.env.GITHUB_PAT;

  if (environmentToken) return environmentToken;

  const modernCli = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  const modernToken = modernCli.status === 0 ? modernCli.stdout.trim() : "";
  if (modernToken) return modernToken;

  const legacyCli = spawnSync(
    "gh",
    ["auth", "status", "--hostname", "github.com", "--show-token"],
    { encoding: "utf8" }
  );
  const legacyOutput = `${legacyCli.stdout ?? ""}\n${legacyCli.stderr ?? ""}`;
  const legacyToken = legacyOutput.match(/Token:\s*(\S+)/)?.[1];
  if (legacyToken && !/^\*+$/.test(legacyToken)) return legacyToken;

  const configDirectory =
    process.env.GH_CONFIG_DIR ??
    path.join(
      process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
      "gh"
    );

  try {
    const hosts = fs.readFileSync(path.join(configDirectory, "hosts.yml"), "utf8");
    return hosts.match(/^\s*oauth_token:\s*(\S+)\s*$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

const token = resolveGitHubToken();

const themes = {
  light: {
    background: "#ffffff",
    ascii: "#111111",
    keyword: "#6f42c1",
    key: "#005cc5",
    string: "#b91c1c",
    number: "#e36209",
    punctuation: "#24292e",
    comment: "#6a737d"
  },
  dark: {
    background: "#0d1117",
    ascii: "#c9d1d9",
    keyword: "#d2a8ff",
    key: "#79c0ff",
    string: "#ff7b72",
    number: "#ffa657",
    punctuation: "#c9d1d9",
    comment: "#8b949e"
  }
};

function getApiHeaders() {
  if (!token) {
    throw new Error(
      "Missing GitHub token. Set GITHUB_TOKEN, GH_TOKEN, or GITHUB_PAT."
    );
  }

  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": `${username}-profile-generator`
  };
}

async function githubFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...getApiHeaders(),
      ...(options.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText}\n` +
        `${url}\n${body}`
    );
  }

  return response;
}

function getLink(linkHeader, relation) {
  if (!linkHeader) return null;

  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === relation) return match[1];
  }

  return null;
}

async function fetchAllPages(url) {
  const results = [];
  let nextUrl = url;

  while (nextUrl) {
    const response = await githubFetch(nextUrl);
    const page = await response.json();
    if (!Array.isArray(page)) {
      throw new Error(`Expected an array from ${nextUrl}`);
    }
    results.push(...page);
    nextUrl = getLink(response.headers.get("link"), "next");
  }

  return results;
}

async function fetchUser() {
  const response = await githubFetch(
    `https://api.github.com/users/${encodeURIComponent(username)}`
  );
  return response.json();
}

async function fetchRepositories() {
  return fetchAllPages(
    `https://api.github.com/users/${encodeURIComponent(username)}/repos` +
      "?type=owner&sort=updated&direction=desc&per_page=100"
  );
}

async function fetchPinnedRepositories() {
  const query = `
    query ProfilePinnedRepositories($login: String!) {
      user(login: $login) {
        pinnedItems(first: 6, types: REPOSITORY) {
          nodes {
            ... on Repository {
              name
              url
              stargazerCount
              primaryLanguage { name }
            }
          }
        }
      }
    }
  `;

  const response = await githubFetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { login: username } })
  });
  const result = await response.json();

  if (result.errors) {
    throw new Error(
      `GraphQL request failed:\n${JSON.stringify(result.errors, null, 2)}`
    );
  }
  if (!result.data?.user) {
    throw new Error(`GitHub user not found: ${username}`);
  }

  return result.data.user.pinnedItems.nodes;
}

async function fetchRepositoryLanguages(repository) {
  const response = await githubFetch(repository.languages_url);
  return response.json();
}

async function fetchCommitCount(repository) {
  if (repository.fork || repository.archived || repository.size === 0) return 0;

  const owner = encodeURIComponent(repository.owner.login);
  const repo = encodeURIComponent(repository.name);
  const author = encodeURIComponent(username);
  const url =
    `https://api.github.com/repos/${owner}/${repo}/commits` +
    `?author=${author}&per_page=1`;
  const response = await fetch(url, { headers: getApiHeaders() });

  if (response.status === 409) return 0;
  if (!response.ok) {
    console.warn(
      `Could not count commits for ${repository.full_name}: ${response.status}`
    );
    return 0;
  }

  const commits = await response.json();
  const lastPageUrl = getLink(response.headers.get("link"), "last");
  if (!lastPageUrl) return commits.length;

  const lastPage = Number(new URL(lastPageUrl).searchParams.get("page"));
  return Number.isFinite(lastPage) ? lastPage : commits.length;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runner)
  );
  return results;
}

function aggregateLanguages(languageMaps) {
  const totals = new Map();
  for (const languages of languageMaps) {
    for (const [language, bytes] of Object.entries(languages)) {
      totals.set(language, (totals.get(language) ?? 0) + bytes);
    }
  }

  const totalBytes = [...totals.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (totalBytes === 0) return [];

  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, bytes]) => ({
      name,
      percentage: (bytes / totalBytes) * 100
    }));
}

async function fetchGitHubStatistics() {
  const [user, allRepositories, pinnedRepositories] = await Promise.all([
    fetchUser(),
    fetchRepositories(),
    fetchPinnedRepositories()
  ]);
  const repositories = allRepositories.filter((repository) => !repository.fork);
  const totalStars = repositories.reduce(
    (sum, repository) => sum + repository.stargazers_count,
    0
  );

  const [languageMaps, commitCounts] = await Promise.all([
    mapWithConcurrency(repositories, 5, fetchRepositoryLanguages),
    mapWithConcurrency(repositories, 5, fetchCommitCount)
  ]);

  return {
    publicRepos: user.public_repos,
    followers: user.followers,
    following: user.following,
    totalStars,
    totalCommits: commitCounts.reduce((sum, count) => sum + count, 0),
    languages: aggregateLanguages(languageMaps),
    pinnedRepositories
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatLanguages(languages) {
  if (languages.length === 0) return "No language data";
  return languages
    .map(({ name, percentage }) => `${name} ${percentage.toFixed(1)}%`)
    .join(", ");
}

function formatPinnedRepositories(repositories) {
  if (repositories.length === 0) return ["No pinned repositories"];
  return repositories.map((repository) => {
    const language = repository.primaryLanguage?.name ?? "Unknown";
    return `${repository.name} [${language}] ★${repository.stargazerCount}`;
  });
}

function createCodeLines(stats) {
  return [
    { type: "comment", value: "// profile.ts — generated automatically" },
    { type: "statement", keyword: "const", name: "profile", value: "{" },
    { type: "string", key: "username", value: config.displayUsername },
    { type: "string", key: "role", value: config.role },
    { type: "string", key: "focus", value: config.focus },
    { type: "string", key: "status", value: config.status },
    { type: "statement", value: "};" },
    { type: "blank" },
    { type: "statement", keyword: "const", name: "github", value: "{" },
    { type: "number", key: "publicRepos", value: stats.publicRepos },
    { type: "number", key: "followers", value: stats.followers },
    { type: "number", key: "following", value: stats.following },
    { type: "number", key: "starsReceived", value: stats.totalStars },
    { type: "number", key: "publicCommits", value: stats.totalCommits },
    {
      type: "string",
      key: "profile",
      value: `https://github.com/${username}`
    },
    { type: "statement", value: "};" },
    { type: "blank" },
    { type: "statement", keyword: "const", name: "languages", value: "=" },
    { type: "stringValue", value: formatLanguages(stats.languages) },
    { type: "blank" },
    {
      type: "statement",
      keyword: "const",
      name: "pinnedRepositories",
      value: "= ["
    },
    ...formatPinnedRepositories(stats.pinnedRepositories).map((value) => ({
      type: "arrayString",
      value
    })),
    { type: "statement", value: "];" }
  ];
}

function renderCodeLine(line, x, y, theme) {
  const characterWidth = 14.4;
  const atColumn = (column) => x + column * characterWidth;
  if (line.type === "blank") return "";

  if (line.type === "comment") {
    return `<text x="${x}" y="${y}" fill="${theme.comment}">${escapeXml(line.value)}</text>`;
  }

  if (line.type === "statement") {
    if (!line.keyword) {
      return `<text x="${x}" y="${y}" fill="${theme.punctuation}">${escapeXml(line.value)}</text>`;
    }
    return `<text y="${y}"><tspan x="${x}" fill="${theme.keyword}" font-weight="700">${escapeXml(line.keyword)}</tspan><tspan x="${atColumn(line.keyword.length)}" fill="${theme.punctuation}"> ${escapeXml(`${line.name} ${line.value}`)}</tspan></text>`;
  }

  if (line.type === "stringValue" || line.type === "arrayString") {
    const suffix = line.type === "stringValue" ? ";" : ",";
    return `<text x="${x}" y="${y}" fill="${theme.string}">${escapeXml(`  "${line.value}"${suffix}`)}</text>`;
  }

  const keyEnd = 2 + line.key.length;
  const value = String(line.value);
  const valueStart = keyEnd + 2;
  const isNumber = line.type === "number";
  const displayedValue = isNumber ? value : `"${value}"`;
  const valueColor = isNumber ? theme.number : theme.string;

  return `<text y="${y}"><tspan x="${x}" fill="${theme.key}">  ${escapeXml(line.key)}</tspan><tspan x="${atColumn(keyEnd)}" fill="${theme.punctuation}">: </tspan><tspan x="${atColumn(valueStart)}" fill="${valueColor}">${escapeXml(displayedValue)}</tspan><tspan x="${atColumn(valueStart + displayedValue.length)}" fill="${theme.punctuation}">,</tspan></text>`;
}

function generateSvg(themeName, theme, stats) {
  const width = 2000;
  const height = 1050;
  const asciiX = 24;
  const asciiY = 35;
  const asciiFontSize = 14;
  const asciiLineHeight = 17;
  const codeX = 660;
  const codeY = 55;
  const codeFontSize = 24;
  const codeLineHeight = 34;

  const asciiElements = asciiPortrait
    .split("\n")
    .map(
      (line, index) =>
        `<text x="${asciiX}" y="${asciiY + index * asciiLineHeight}" fill="${theme.ascii}">${escapeXml(line)}</text>`
    )
    .join("\n");

  let currentY = codeY;
  const codeElements = createCodeLines(stats)
    .map((line) => {
      if (line.type === "blank") {
        currentY += 15;
        return "";
      }
      const rendered = renderCodeLine(line, codeX, currentY, theme);
      currentY += codeLineHeight;
      return rendered;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
     role="img" aria-label="Osama Rahmani GitHub profile in ${themeName} mode">
  <rect width="100%" height="100%" fill="${theme.background}"/>
  <g font-family="JetBrains Mono, Fira Code, Cascadia Code, Consolas, monospace"
     font-size="${asciiFontSize}" xml:space="preserve">
    ${asciiElements}
  </g>
  <g font-family="JetBrains Mono, Fira Code, Cascadia Code, Consolas, monospace"
     font-size="${codeFontSize}" xml:space="preserve">
    ${codeElements}
  </g>
</svg>
`;
}

async function loadStatistics() {
  const fixture = process.env.PROFILE_STATS_FILE;
  if (fixture) {
    return JSON.parse(fs.readFileSync(path.resolve(fixture), "utf8"));
  }
  return fetchGitHubStatistics();
}

async function main() {
  console.log(`Fetching GitHub data for ${username}...`);
  const stats = await loadStatistics();
  console.log(
    `Found ${stats.publicRepos} public repositories, ${stats.totalStars} stars, ` +
      `${stats.totalCommits} authored commits, and ` +
      `${stats.pinnedRepositories.length} pinned repositories.`
  );

  const dist = path.join(ROOT, "dist");
  fs.mkdirSync(dist, { recursive: true });

  for (const [themeName, theme] of Object.entries(themes)) {
    const svg = generateSvg(themeName, theme, stats);
    for (const destination of [
      path.join(ROOT, `profile-${themeName}.svg`),
      path.join(dist, `profile-${themeName}.svg`)
    ]) {
      fs.writeFileSync(destination, svg, "utf8");
      console.log(`Generated ${path.relative(ROOT, destination)}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
