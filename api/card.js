const https = require("https");
const { kv } = require("@vercel/kv");

const KV_KEY = "profile_views";

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
        .replace(/&#x([0-9a-fA-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
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
    // Mirrors github-readme-stats: commits are last-year only, while PRs and
    // issues are lifetime totals. `startTime` bounds the commit window.
    const startTime = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

    const { data } = await executeGraphQL(`
        query($login: String!, $startTime: DateTime!) {
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
            commits: contributionsCollection(from: $startTime) {
              totalCommitContributions
              restrictedContributionsCount
            }
            reviews: contributionsCollection {
              totalPullRequestReviewContributions
            }
            pullRequests(first: 1) { totalCount }
            openIssues: issues(states: OPEN) { totalCount }
            closedIssues: issues(states: CLOSED) { totalCount }
            followers { totalCount }
            repositoriesContributedTo(
              first: 1
              contributionTypes: [COMMIT, PULL_REQUEST, REPOSITORY, PULL_REQUEST_REVIEW]
            ) { totalCount }
          }
        }
    `, { login: username, startTime }, token);
    return data.user;
}

async function fetchSpotifyData() {
    const fallback = { trackName: null, artist: null, trackColor: theme.accent, albumArt: null };
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

    // Extract album cover from the <img class="cover"> element specifically.
    // The SVG has multiple base64 images (Spotify logo etc.) — we want only the cover.
    const coverEl = data.match(/<img\b[^>]+class="cover"[^>]*>/i)
                 || data.match(/<img\b[^>]+src="(data:image\/[^"]+)"[^>]*class="cover"/i);
    let albumArt = null;
    if (coverEl) {
        const srcM = coverEl[0].match(/src="(data:image\/[^"]+)"/i);
        if (srcM) albumArt = srcM[1];
    }
    // Fallback: grab the last (largest) base64 image — usually the album art
    if (!albumArt) {
        const all = [...data.matchAll(/data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]{200,})/g)];
        if (all.length) {
            const last = all[all.length - 1];
            albumArt = `data:${last[1]};base64,${last[2]}`;
        }
    }

    return { trackName: song, artist: artist || "", trackColor: theme.accent, albumArt };
}

async function fetchProfileViews() {
    // Increment the counter on every request (each card load = one profile view)
    // and return the updated value. Falls back to 0 if KV is not configured.
    try {
        const count = await kv.incr(KV_KEY);
        return count;
    } catch {
        return 0;
    }
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

// Mirrors github-readme-stats' rank algorithm (MIT).
// Returns { level: "S"|"A+"|... , percentile } where a lower percentile is better.
function calculateRank({ commits, pullRequests, issues, reviews, stars, followers }) {
    const expCdf = (x) => 1 - Math.pow(2, -x);
    const logNormalCdf = (x) => x / (1 + x);

    const COMMITS_MEDIAN = 250, COMMITS_WEIGHT = 2;
    const PRS_MEDIAN = 50, PRS_WEIGHT = 3;
    const ISSUES_MEDIAN = 25, ISSUES_WEIGHT = 1;
    const REVIEWS_MEDIAN = 2, REVIEWS_WEIGHT = 1;
    const STARS_MEDIAN = 50, STARS_WEIGHT = 4;
    const FOLLOWERS_MEDIAN = 10, FOLLOWERS_WEIGHT = 1;
    const TOTAL_WEIGHT = COMMITS_WEIGHT + PRS_WEIGHT + ISSUES_WEIGHT + REVIEWS_WEIGHT + STARS_WEIGHT + FOLLOWERS_WEIGHT;

    const THRESHOLDS = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
    const LEVELS = ["S", "A+", "A", "A-", "B+", "B", "B-", "C+", "C"];

    const rank = 1 - (
        COMMITS_WEIGHT * expCdf(commits / COMMITS_MEDIAN) +
        PRS_WEIGHT * expCdf(pullRequests / PRS_MEDIAN) +
        ISSUES_WEIGHT * expCdf(issues / ISSUES_MEDIAN) +
        REVIEWS_WEIGHT * expCdf(reviews / REVIEWS_MEDIAN) +
        STARS_WEIGHT * logNormalCdf(stars / STARS_MEDIAN) +
        FOLLOWERS_WEIGHT * logNormalCdf(followers / FOLLOWERS_MEDIAN)
    ) / TOTAL_WEIGHT;

    const percentile = rank * 100;
    const level = LEVELS[THRESHOLDS.findIndex((t) => percentile <= t)];
    return { level, percentile };
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

function createBottomRow(spotify, viewCount) {
    const { trackName, artist, albumArt } = spotify;
    const LINE_Y = 378;
    const views = createViewsBadge(viewCount, 728, 409);

    if (!trackName) {
        return `
    <line x1="16" y1="${LINE_Y}" x2="744" y2="${LINE_Y}" stroke="${theme.border}" stroke-width="0.5"/>
    <text x="32" y="415" ${theme.font} font-size="12" fill="${theme.muted}">♫ Not playing</text>
    ${views}`;
    }

    // Album art tile
    const AX = 32, AY = LINE_Y + 3, AS = 46, AR = 7;
    const artBlock = albumArt ? `
    <defs>
      <clipPath id="ac"><rect x="${AX}" y="${AY}" width="${AS}" height="${AS}" rx="${AR}"/></clipPath>
    </defs>
    <rect x="${AX - 1}" y="${AY - 1}" width="${AS + 2}" height="${AS + 2}" rx="${AR + 1}"
          fill="none" stroke="${theme.accent}" stroke-width="1.5" opacity="0.5"/>
    <image href="${albumArt}" x="${AX}" y="${AY}" width="${AS}" height="${AS}"
           clip-path="url(#ac)" preserveAspectRatio="xMidYMid slice"/>` : "";

    const TX = albumArt ? AX + AS + 12 : 32;
    // Clip width: from TX to equalizer start (TX+218), minus small padding
    const CLIP_W = 210;
    const AVG_CH_TRACK  = 7.5;  // px per char at font-size 13 bold
    const AVG_CH_ARTIST = 6.5;  // px per char at font-size 11
    const trackPx  = trackName.length  * AVG_CH_TRACK;
    const artistPx = artist.length     * AVG_CH_ARTIST;

    // Build scrolling or static text block
    const makeText = (text, x, y, fs, fw, fill, totalPx, id) => {
        const overflow = Math.round(totalPx - CLIP_W + 8);
        if (overflow <= 0) {
            return `<text x="${x}" y="${y}" ${theme.font} font-size="${fs}" font-weight="${fw}" fill="${fill}">${escapeXml(text)}</text>`;
        }
        // Smooth back-and-forth marquee:
        // pause → slide left (ease) → pause → slide right (ease) → pause
        const moveDur = Math.max(3, Math.round(overflow / 18));
        const pauseDur = 1.5;
        const total = (moveDur * 2 + pauseDur * 3).toFixed(1);
        const t1 = (pauseDur / total).toFixed(3);
        const t2 = ((pauseDur + moveDur) / total).toFixed(3);
        const t3 = ((pauseDur + moveDur + pauseDur) / total).toFixed(3);
        const t4 = ((pauseDur * 2 + moveDur * 2) / total).toFixed(3);
        return `
    <defs><clipPath id="cl${id}"><rect x="${x}" y="${y - fs}" width="${CLIP_W}" height="${fs + 4}"/></clipPath></defs>
    <g clip-path="url(#cl${id})">
      <text x="${x}" y="${y}" ${theme.font} font-size="${fs}" font-weight="${fw}" fill="${fill}">
        <animateTransform attributeName="transform" type="translate"
          values="0,0; 0,0; -${overflow},0; -${overflow},0; 0,0; 0,0"
          keyTimes="0; ${t1}; ${t2}; ${t3}; ${t4}; 1"
          keySplines="0 0 1 1; 0.42 0 0.58 1; 0 0 1 1; 0.42 0 0.58 1; 0 0 1 1"
          calcMode="spline" dur="${total}s" repeatCount="indefinite" begin="1s"/>
        ${escapeXml(text)}
      </text>
    </g>`;
    };

    const textBlock =
        makeText(trackName, TX, AY + 17, 13, "700", theme.text,  trackPx,  "t") +
        makeText(artist,    TX, AY + 33, 11, "400", theme.muted, artistPx, "a");

    // Animated equalizer (accent colour)
    const EQX = TX + 218, EQY = AY + 43, EQH = 18, BW = 3, BG = 3;
    const delays  = [0, 0.18, 0.07, 0.29, 0.12];
    const periods = [0.85, 0.70, 0.95, 0.75, 0.88];
    const eqBars = Array.from({ length: 5 }, (_, i) =>
        `<rect class="eq${i}" x="${EQX + i*(BW+BG)}" y="${EQY - EQH}" width="${BW}" height="${EQH}" rx="1.5" fill="${theme.accent}"/>`
    ).join("");
    const eqStyle = `<style>
${Array.from({ length: 5 }, (_, i) => {
    const lo = (0.2 + i * 0.05).toFixed(2);
    return `@keyframes eq${i}{0%,100%{transform:scaleY(${lo})}50%{transform:scaleY(1)}}` +
           `.eq${i}{transform-box:fill-box;transform-origin:bottom;animation:eq${i} ${periods[i]}s ease-in-out ${delays[i]}s infinite;}`;
}).join("")}
</style>`;

    return `
    <line x1="16" y1="${LINE_Y}" x2="744" y2="${LINE_Y}" stroke="${theme.border}" stroke-width="0.5"/>
    ${eqStyle}${artBlock}${textBlock}
    ${eqBars}
    ${views}`;
}

function generateSVG(userData, streak, languages, stars, commits, prs, issues, rank, spotify, viewCount) {
    const total = userData.contributionsCollection.contributionCalendar.totalContributions;
    const rankCirc = 2 * Math.PI * 38;
    // Lower percentile = better rank = fuller ring.
    const rankFill = (1 - rank.percentile / 100) * rankCirc;
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
  <text x="408" y="118" ${theme.font} font-size="18" font-weight="700" fill="${theme.text}" text-anchor="middle">${rank.level}</text>

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

  ${createBottomRow(spotify, viewCount)}
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
        const commits     = (gitHubUser.commits?.totalCommitContributions ?? 0)
                          + (gitHubUser.commits?.restrictedContributionsCount ?? 0);
        const prs         = gitHubUser.pullRequests?.totalCount ?? 0;
        const issues      = (gitHubUser.openIssues?.totalCount ?? 0)
                          + (gitHubUser.closedIssues?.totalCount ?? 0);
        const reviews     = gitHubUser.reviews?.totalPullRequestReviewContributions ?? 0;
        const rank        = calculateRank({
            commits, pullRequests: prs, issues, reviews, stars,
            followers: gitHubUser.followers.totalCount,
        });

        const svg = generateSVG(gitHubUser, streak, languages, stars, commits, prs, issues, rank, spotify, viewCount);

        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.setHeader("ETag", `"${Date.now()}"`);
        res.status(200).send(svg);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error generating card");
    }
};
