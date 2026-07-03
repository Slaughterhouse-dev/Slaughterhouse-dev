const https = require("https");

const username = "S0x2-dev";
const spotifyUserId = "31leep2d5rpspzgszzi6glolhul4";
const spotifyGreen = "#1db954";

const theme = {
    background: "#171517",
    cardBackground: "#1d1b1d",
    border: "#212022",
    accent: "#91a1f1",
    text: "#c8c8c8",
    muted: "#8c8c8c",
    font: `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"`,
};

// ── helpers ────────────────────────────────────────────────────────────────

function escapeXml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function formatDate(isoDate) {
    if (!isoDate) return "";
    return new Date(isoDate).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatNumber(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

function decodeEntities(text) {
    return text
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)));
}

// ── data fetchers ──────────────────────────────────────────────────────────

function executeGraphQL(query, variables, token) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ query, variables });
        const req = https.request({
            hostname: "api.github.com",
            path: "/graphql",
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
                "User-Agent": "profile-card-generator",
            },
        }, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

function httpGet(hostname, path) {
    return new Promise((resolve) => {
        const req = https.request(
            { hostname, path, method: "GET", headers: { "User-Agent": "profile-card-generator" } },
            (res) => {
                let data = "";
                res.on("data", (c) => (data += c));
                res.on("end", () => resolve(data));
            }
        );
        req.on("error", () => resolve(""));
        req.end();
    });
}

async function fetchGitHubData(token) {
    const now = new Date();
    const yearFragments = [now.getFullYear(), now.getFullYear() - 1].map((year, i) => `
        ${i === 0 ? "current" : "previous"}: contributionsCollection(
            from: "${year}-01-01T00:00:00Z" to: "${year}-12-31T23:59:59Z"
        ) {
            totalCommitContributions totalPullRequestContributions
            totalIssueContributions  restrictedContributionsCount
        }
    `).join("");

    const { data } = await executeGraphQL(`
        query($login: String!) {
          user(login: $login) {
            repositories(ownerAffiliations: OWNER, first: 100) {
              nodes {
                stargazerCount
                languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
                  edges { size node { name color } }
                }
              }
            }
            contributionsCollection {
              contributionCalendar {
                totalContributions
                weeks { contributionDays { contributionCount date } }
              }
            }
            ${yearFragments}
            followers { totalCount }
            repositoriesContributedTo(
              first: 1
              contributionTypes: [COMMIT, PULL_REQUEST, REPOSITORY, PULL_REQUEST_REVIEW]
            ) { totalCount }
          }
        }
    `, { login: username }, token);
    return data.user;
}

async function fetchSpotifyData() {
    const fallback = { trackName: null, trackColor: spotifyGreen };
    const data = await httpGet(
        "spotify-github-profile.kittinanx.com",
        `/api/view?uid=${spotifyUserId}`
    );
    if (!data || /class="not-play"/.test(data)) return fallback;
    const grab = (cls) => {
        const m = data.match(new RegExp(`class="${cls}"[^>]*>([^<]+)<`));
        return m ? decodeEntities(m[1]).trim() : null;
    };
    const song = grab("song");
    const artist = grab("artist");
    if (!song) return fallback;
    return { trackName: artist ? `${song} — ${artist}` : song, trackColor: spotifyGreen };
}

async function fetchProfileViews() {
    const data = await httpGet("komarev.com", "/ghpvc/?username=S0x2-dev&format=true&base=0");
    const vals = [...data.matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
        .map((m) => m[1].replace(/[,\s]/g, ""))
        .filter((v) => /^\d+$/.test(v));
    return vals.length ? parseInt(vals[vals.length - 1], 10) : 0;
}

// ── stat computation ───────────────────────────────────────────────────────

function calculateStreak(weeks) {
    const allDays = weeks.flatMap((w) => w.contributionDays)
        .sort((a, b) => (a.date < b.date ? 1 : -1));
    const today = new Date().toISOString().slice(0, 10);
    let current = 0, start = "", end = "";
    for (const day of allDays) {
        if (day.date > today) continue;
        if (current === 0 && day.contributionCount === 0 && day.date !== today) break;
        if (day.contributionCount > 0) { current++; if (!end) end = day.date; start = day.date; }
        else if (day.date !== today) break;
    }
    let longest = 0, tmp = 0;
    for (const day of [...allDays].reverse()) {
        tmp = day.contributionCount > 0 ? tmp + 1 : 0;
        if (tmp > longest) longest = tmp;
    }
    return { current, longest, startDate: start, endDate: end };
}

function getTopLanguages(repos) {
    const map = {};
    for (const repo of repos) {
        for (const { size, node } of repo.languages.edges) {
            if (!map[node.name]) map[node.name] = { size: 0, color: node.color || theme.muted };
            map[node.name].size += size;
        }
    }
    const top = Object.entries(map).sort((a, b) => b[1].size - a[1].size).slice(0, 6);
    const total = top.reduce((s, [, d]) => s + d.size, 0);
    return top.map(([name, { size, color }]) => ({
        name: name.length > 13 ? name.slice(0, 12) + "." : name,
        color,
        percentage: ((size / total) * 100).toFixed(1),
    }));
}

function calculateRank({ commits, pullRequests, issues, stars, followers }) {
    const eCdf = (x) => 1 - Math.pow(2, -x);
    const nCdf = (mean, sigma, value) => {
        const z = (value - mean) / Math.sqrt(2 * sigma * sigma);
        const t = 1 / (1 + 0.3275911 * Math.abs(z));
        const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-z * z);
        return 0.5 * (1 + (z >= 0 ? erf : -erf));
    };
    const score = (2 * eCdf(commits / 250) + 3 * eCdf(pullRequests / 50) + eCdf(issues / 25) + 4 * eCdf(stars / 50) + eCdf(followers / 10)) / 11;
    return 100 - 100 * nCdf(score, 1, 0.75);
}

// ── SVG builders ───────────────────────────────────────────────────────────

function createDonutChart(languages, cx, cy, r) {
    const circ = 2 * Math.PI * r;
    let offset = 0;
    const segs = languages.map(({ color, percentage }) => {
        const dash = (percentage / 100) * circ;
        const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="10"
            stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}"
            stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
        offset += dash;
        return seg;
    });
    return segs.join("\n") + `\n<circle cx="${cx}" cy="${cy}" r="${r - 14}" fill="${theme.cardBackground}"/>`;
}

function createLanguageLegend(languages, posX, startY, gap) {
    return languages.map(({ name, color, percentage }, i) => {
        const y = startY + i * gap;
        return `<circle cx="${posX}" cy="${y - 4}" r="4" fill="${color}"/>
            <text x="${posX + 11}" y="${y}" ${theme.font} font-size="12" fill="${theme.text}">${escapeXml(name)} <tspan fill="${theme.muted}">${percentage}%</tspan></text>`;
    }).join("\n");
}

function createFlame(cx, cy, size, color, ringStroke) {
    const scale = size / 24;
    const strokeWidth = (ringStroke / scale).toFixed(2);
    return `<g transform="translate(${cx - 12 * scale} ${cy - 12 * scale}) scale(${scale})">
      <path d="M 19.48 12.35 c -1.57 -4.08 -7.16 -4.3 -5.81 -10.23 c .1 -.44 -.37 -.78 -.75 -.55 C 9.29 3.71 6.68 8 8.87 13.62 c .18 .46 -.36 .89 -.75 .59 c -1.81 -1.37 -2 -3.34 -1.84 -4.75 c .06 -.52 -.62 -.77 -.91 -.34 C 4.69 10.16 4 11.84 4 14.37 c .38 5.6 5.11 7.32 6.81 7.54 c 2.43 .31 5.06 -.14 6.95 -1.87 c 2.08 -1.93 2.84 -5.01 1.72 -7.69 z"
            fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round"/>
    </g>`;
}

function createViewsBadge(viewCount, rightX, centerY) {
    const h = 34, pad = 15, fs = 14;
    const label = "Profile Views";
    const count = formatNumber(viewCount);
    const lw = Math.round(label.length * fs * 0.54) + pad * 2;
    const cw = Math.round(count.length * fs * 0.62) + pad * 2;
    const x = rightX - lw - cw;
    const y = centerY - h / 2;
    const ty = centerY + fs * 0.35;
    const r = 6;

    const leftPath = `M${x + r},${y} H${x + lw} V${y + h} H${x + r} Q${x},${y + h} ${x},${y + h - r} V${y + r} Q${x},${y} ${x + r},${y} Z`;
    const rightPath = `M${x + lw},${y} H${x + lw + cw - r} Q${x + lw + cw},${y} ${x + lw + cw},${y + r} V${y + h - r} Q${x + lw + cw},${y + h} ${x + lw + cw - r},${y + h} H${x + lw} Z`;

    return `
    <path d="${leftPath}" fill="${theme.accent}"/>
    <path d="${rightPath}" fill="${theme.background}" stroke="${theme.border}" stroke-width="0.5"/>
    <text x="${x + lw / 2}" y="${ty}" ${theme.font} font-size="${fs}" font-weight="600" fill="${theme.background}" text-anchor="middle">${label}</text>
    <text x="${x + lw + cw / 2}" y="${ty}" ${theme.font} font-size="${fs}" font-weight="700" fill="${theme.text}" text-anchor="middle">${count}</text>`;
}

function createBottomRow(trackName, trackColor, viewCount) {
    const leftX = 32;
    const rowY = 415;

    const views = createViewsBadge(viewCount, 728, rowY - 4);

    const music = !trackName
        ? `<text x="${leftX}" y="${rowY}" ${theme.font} font-size="12" fill="${theme.muted}">♫ Not playing</text>`
        : (() => {
            const maxLen = 36;
            const label = trackName.length > maxLen ? trackName.slice(0, maxLen - 1).trimEnd() + "…" : trackName;
            const bw = Math.min(300, 28 + label.length * 6.6);
            return `<rect x="${leftX}" y="${rowY - 14}" width="${bw.toFixed(0)}" height="26" rx="4" fill="${trackColor}22"/>
            <circle cx="${leftX + 12}" cy="${rowY}" r="4" fill="${trackColor}"/>
            <text x="${leftX + 24}" y="${rowY + 5}" ${theme.font} font-size="12" font-weight="600" fill="${theme.text}">${escapeXml(label)}</text>`;
        })();

    return `
    <line x1="16" y1="390" x2="744" y2="390" stroke="${theme.border}" stroke-width="0.5"/>
    ${music}
    ${views}`;
}

function generateSVG(userData, streak, languages, stars, commits, prs, issues, rankPct, spotify, viewCount) {
    const total = userData.contributionsCollection.contributionCalendar.totalContributions;
    const rankCirc = 2 * Math.PI * 38;
    const rankFill = (1 - rankPct / 100) * rankCirc;
    const sCX = 380, sCY = 280, sR = 34, sStroke = 2.5;

    return `<svg width="760" height="456" viewBox="0 0 760 456" xmlns="http://www.w3.org/2000/svg" role="img">
  <title>S0x2-dev GitHub Stats</title>
  <defs>
    <mask id="streak-ring-cut">
      <rect width="760" height="456" fill="white"/>
      <rect x="${sCX - 6}" y="${sCY - sR - 2}" width="12" height="5" fill="black"/>
    </mask>
  </defs>

  <rect width="760" height="456" rx="10" fill="${theme.background}" stroke="${theme.border}" stroke-width="1"/>

  <!-- Stats card -->
  <rect x="16" y="16" width="454" height="188" rx="8" fill="${theme.cardBackground}" stroke="${theme.border}" stroke-width="0.5"/>
  <text x="32" y="44" ${theme.font} font-size="15" font-weight="600" fill="${theme.accent}">S0x2-dev's GitHub Stats</text>
  <text x="32"  y="76"  ${theme.font} font-size="13" fill="${theme.muted}">Total Stars Earned:</text>
  <text x="260" y="76"  ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${stars}</text>
  <text x="32"  y="100" ${theme.font} font-size="13" fill="${theme.muted}">Total Commits (last year):</text>
  <text x="260" y="100" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${formatNumber(commits)}</text>
  <text x="32"  y="124" ${theme.font} font-size="13" fill="${theme.muted}">Total PRs:</text>
  <text x="260" y="124" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${prs}</text>
  <text x="32"  y="148" ${theme.font} font-size="13" fill="${theme.muted}">Total Issues:</text>
  <text x="260" y="148" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${issues}</text>
  <text x="32"  y="172" ${theme.font} font-size="13" fill="${theme.muted}">Contributed to (last year):</text>
  <text x="260" y="172" ${theme.font} font-size="13" font-weight="600" fill="${theme.text}">${userData.repositoriesContributedTo.totalCount}</text>
  <circle cx="408" cy="112" r="38" fill="none" stroke="${theme.border}" stroke-width="3"/>
  <circle cx="408" cy="112" r="38" fill="none" stroke="${theme.accent}" stroke-width="3"
    stroke-dasharray="${rankFill.toFixed(1)} ${(rankCirc - rankFill).toFixed(1)}"
    stroke-dashoffset="0" transform="rotate(-90 408 112)"/>
  <text x="408" y="118" ${theme.font} font-size="18" font-weight="700" fill="${theme.text}" text-anchor="middle">A+</text>

  <!-- Languages card -->
  <rect x="482" y="16" width="262" height="188" rx="8" fill="${theme.cardBackground}" stroke="${theme.border}" stroke-width="0.5"/>
  <text x="506" y="44" ${theme.font} font-size="15" font-weight="600" fill="${theme.accent}">Most Used Languages</text>
  ${createLanguageLegend(languages, 506, 64, 22)}
  ${createDonutChart(languages, 685, 119, 34)}

  <!-- Streak + contributions card -->
  <rect x="16" y="220" width="728" height="220" rx="8" fill="${theme.cardBackground}" stroke="${theme.border}" stroke-width="0.5"/>
  <text x="137" y="293" ${theme.font} font-size="25" font-weight="700" fill="${theme.text}" text-anchor="middle">${total.toLocaleString()}</text>
  <text x="137" y="311" ${theme.font} font-size="12" fill="${theme.muted}" text-anchor="middle">Total Contributions</text>
  <text x="137" y="324" ${theme.font} font-size="11" fill="${theme.muted}" text-anchor="middle">Apr 30, 2024 - Present</text>
  <line x1="259" y1="232" x2="259" y2="372" stroke="${theme.border}" stroke-width="0.5"/>
  <line x1="501" y1="232" x2="501" y2="372" stroke="${theme.border}" stroke-width="0.5"/>
  <circle cx="${sCX}" cy="${sCY}" r="${sR}" fill="none" stroke="${theme.accent}" stroke-width="${sStroke}" mask="url(#streak-ring-cut)"/>
  ${createFlame(sCX, sCY - sR - 1, 20, theme.accent, sStroke)}
  <text x="${sCX}" y="${sCY + 9}"       ${theme.font} font-size="25" font-weight="700" fill="${theme.text}"   text-anchor="middle">${streak.current}</text>
  <text x="${sCX}" y="${sCY + sR + 30}" ${theme.font} font-size="17" font-weight="700" fill="${theme.accent}" text-anchor="middle">Current Streak</text>
  <text x="${sCX}" y="${sCY + sR + 48}" ${theme.font} font-size="11"                   fill="${theme.muted}"  text-anchor="middle">${formatDate(streak.startDate)} - ${formatDate(streak.endDate)}</text>
  <text x="621" y="293" ${theme.font} font-size="25" font-weight="700" fill="${theme.text}"  text-anchor="middle">${streak.longest}</text>
  <text x="621" y="311" ${theme.font} font-size="12"                   fill="${theme.muted}" text-anchor="middle">Longest Streak</text>

  ${createBottomRow(spotify.trackName, spotify.trackColor, viewCount)}
</svg>`;
}

// ── Vercel handler ─────────────────────────────────────────────────────────

module.exports = async (req, res) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        res.status(500).send("GITHUB_TOKEN not set");
        return;
    }

    try {
        // Fetch all data in parallel — GitHub, Spotify, profile views.
        const [gitHubUser, spotify, viewCount] = await Promise.all([
            fetchGitHubData(token),
            fetchSpotifyData(),
            fetchProfileViews(),
        ]);

        const languages   = getTopLanguages(gitHubUser.repositories.nodes);
        const streak      = calculateStreak(gitHubUser.contributionsCollection.contributionCalendar.weeks);
        const stars       = gitHubUser.repositories.nodes.reduce((s, r) => s + r.stargazerCount, 0);
        const commits     = (gitHubUser.current?.totalCommitContributions ?? 0)
                          + (gitHubUser.previous?.totalCommitContributions ?? 0)
                          + (gitHubUser.current?.restrictedContributionsCount ?? 0)
                          + (gitHubUser.previous?.restrictedContributionsCount ?? 0);
        const prs         = (gitHubUser.current?.totalPullRequestContributions ?? 0)
                          + (gitHubUser.previous?.totalPullRequestContributions ?? 0);
        const issues      = (gitHubUser.current?.totalIssueContributions ?? 0)
                          + (gitHubUser.previous?.totalIssueContributions ?? 0);
        const rankPct     = calculateRank({
            commits: gitHubUser.current?.totalCommitContributions ?? 0,
            pullRequests: prs, issues, stars,
            followers: gitHubUser.followers.totalCount,
        });

        const svg = generateSVG(gitHubUser, streak, languages, stars, commits, prs, issues, rankPct, spotify, viewCount);

        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.status(200).send(svg);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error generating card");
    }
};
