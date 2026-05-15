const https = require("https");
const fs = require("fs");

const username = "Slaughterhouse-dev";
const token = process.env.GITHUB_TOKEN;

const S = {
    bg:     "#171517",
    bgCard: "#1d1b1d",
    border: "#212022",
    accent: "#91a1f1",
    text:   "#c8c8c8",
    muted:  "#8c8c8c",
    font:   `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"`,
};

function gql(query, variables) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ query, variables });
        const req = https.request({
            hostname: "api.github.com",
            path:     "/graphql",
            method:   "POST",
            headers:  {
                Authorization:    `Bearer ${token}`,
                "Content-Type":   "application/json",
                "Content-Length": Buffer.byteLength(body),
                "User-Agent":     "profile-card-generator",
            },
        }, (res) => {
            let raw = "";
            res.on("data", c => raw += c);
            res.on("end", () => {
                try   { resolve(JSON.parse(raw)); }
                catch (e) { reject(e); }
            });
        });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

async function fetchData() {
    const now = new Date();
    const years = [now.getFullYear(), now.getFullYear() - 1];

    const yearFragments = years.map((y, i) => `
        y${i}: contributionsCollection(
            from: "${y}-01-01T00:00:00Z"
            to:   "${y}-12-31T23:59:59Z"
        ) {
            totalCommitContributions
            totalPullRequestContributions
            totalIssueContributions
            restrictedContributionsCount
        }
    `).join("");

    const { data } = await gql(`
        query($login: String!) {
            user(login: $login) {
                repositories(ownerAffiliations: OWNER, first: 100) {
                    nodes {
                        stargazerCount
                        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
                            edges {
                                size node { name color }
                            }
                        }
                    }
                }
                contributionsCollection {
                    contributionCalendar {
                        totalContributions
                        weeks {
                            contributionDays { contributionCount date }
                        }
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
    `, { login: username });

    return data.user;
}

function calcStreak(weeks) {
    const days = weeks.flatMap(w => w.contributionDays).sort((a, b) => a.date < b.date ? 1 : -1);
    const today = new Date().toISOString().slice(0, 10);

    let current = 0, startCurrent = "", endCurrent = "";
    for (const day of days) {
        if (day.date > today) continue;
        if (current === 0 && day.contributionCount === 0 && day.date !== today) break;
        if (day.contributionCount > 0) {
            current++;
            if (!endCurrent) endCurrent = day.date;
            startCurrent = day.date;
        } else if (day.date !== today) break;
    }

    let longest = 0, temp = 0;
    for (const day of [...days].reverse()) {
        if (day.contributionCount > 0) {
            temp++;
            if (temp > longest) longest = temp;
        } else {
            temp = 0;
        }
    }

    return { current, longest, startCurrent, endCurrent };
}

function topLangs(repos) {
    const map = {};
    for (const repo of repos) {
        for (const { size, node } of repo.languages.edges) {
            if (!map[node.name]) map[node.name] = { size: 0, color: node.color || S.muted };
            map[node.name].size += size;
        }
    }
    const top = Object.entries(map).sort((a, b) => b[1].size - a[1].size).slice(0, 6);
    const topTotal = top.reduce((s, [, v]) => s + v.size, 0);
    return top.map(([name, { size, color }]) => ({
        name:  name.length > 13 ? name.slice(0, 12) + "." : name,
        color,
        pct:   ((size / topTotal) * 100).toFixed(1),
    }));
}

function fmtDate(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtNum(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

function calculateRank({ commits, prs, issues, stars, followers }) {
    const exponentialCdf = x => 1 - Math.pow(2, -x);
    const normalcdf = (mean, sigma, to) => {
        const z = (to - mean) / Math.sqrt(2 * sigma * sigma);
        const t = 1 / (1 + 0.3275911 * Math.abs(z));
        const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-z * z);
        return 0.5 * (1 + (z >= 0 ? erf : -erf));
    };
    const score = (
        2 * exponentialCdf(commits   / 250) +
        3 * exponentialCdf(prs       / 50)  +
        1 * exponentialCdf(issues    / 25)  +
        4 * exponentialCdf(stars     / 50)  +
        1 * exponentialCdf(followers / 10)
    ) / 11;
    return 100 - 100 * normalcdf(score, 1, 0.75);
}

function rankRingFill(percentile) {
    const THRESHOLDS = [1, 85, 92, 96, 98, 99, 99.5, 99.8, 100];
    const FILLS      = [0.92, 0.72, 0.57, 0.45, 0.35, 0.25, 0.18, 0.12, 0.08];
    for (let i = 0; i < THRESHOLDS.length; i++) {
        if (percentile <= THRESHOLDS[i]) return FILLS[i];
    }
    return FILLS[FILLS.length - 1];
}

function donut(langs, cx, cy, r) {
    const circ = 2 * Math.PI * r;
    let offset = 0;
    const segs = langs.map(({ color, pct }) => {
        const dash = (pct / 100) * circ;
        const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
            stroke="${color}" stroke-width="10"
            stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}"
            stroke-dashoffset="${(-offset).toFixed(2)}"
            transform="rotate(-90 ${cx} ${cy})"/>`;
        offset += dash;
        return seg;
    });
    return segs.join("\n") + `\n<circle cx="${cx}" cy="${cy}" r="${r - 14}" fill="${S.bgCard}"/>`;
}

function langLegend(langs, x, startY, gap) {
    return langs.map(({ name, color, pct }, i) => {
        const y = startY + i * gap;
        return `
            <circle cx="${x}" cy="${y - 4}" r="4" fill="${color}"/>
            <text x="${x + 11}" y="${y}" ${S.font} font-size="11" fill="${S.text}">${name} <tspan fill="${S.muted}">${pct}%</tspan></text>`;
    }).join("");
}

function generateSVG(user, streak, langs, stars, commits, prs, issues, rankPercentile) {
    const total = user.contributionsCollection.contributionCalendar.totalContributions;
    const circ = 2 * Math.PI * 38;
    const fill = rankRingFill(rankPercentile);
    const ringFill = fill * circ;
    const ringGap = circ - ringFill;

    const donutSVG = donut(langs, 685, 119, 34);
    const legendSVG = langLegend(langs, 506, 68, 22);

    // Streak section layout (card y=220..314, section x=259..501, center x=380)
    // Circle r=24, center cy=262 → top=238, bottom=286
    // Flame: two ellipses sitting on top of circle at cy=233
    // Number: cy=268 (inside circle)
    // Label: y=283
    // Dates: y=296
    const scx = 380, scy = 262, sr = 24;
    const streakCirc = 2 * Math.PI * sr;

    return `<svg width="760" height="330" viewBox="0 0 760 330" xmlns="http://www.w3.org/2000/svg" role="img">
        <title>Slaughterhouse-dev GitHub Stats</title>

        <rect width="760" height="330" rx="10" fill="${S.bg}" stroke="${S.border}" stroke-width="1"/>

        <rect x="16" y="16" width="454" height="188" rx="8" fill="${S.bgCard}" stroke="${S.border}" stroke-width="0.5"/>
        <text x="32" y="44" ${S.font} font-size="14" font-weight="600" fill="${S.accent}">Slaughterhouse's GitHub Stats</text>

        <text x="32"  y="78"  ${S.font} font-size="12" fill="${S.muted}">Total Stars Earned:</text>
        <text x="260" y="78"  ${S.font} font-size="12" font-weight="600" fill="${S.text}">${stars}</text>

        <text x="32"  y="102" ${S.font} font-size="12" fill="${S.muted}">Total Commits (last year):</text>
        <text x="260" y="102" ${S.font} font-size="12" font-weight="600" fill="${S.text}">${fmtNum(commits)}</text>

        <text x="32"  y="126" ${S.font} font-size="12" fill="${S.muted}">Total PRs:</text>
        <text x="260" y="126" ${S.font} font-size="12" font-weight="600" fill="${S.text}">${prs}</text>

        <text x="32"  y="150" ${S.font} font-size="12" fill="${S.muted}">Total Issues:</text>
        <text x="260" y="150" ${S.font} font-size="12" font-weight="600" fill="${S.text}">${issues}</text>

        <text x="32"  y="174" ${S.font} font-size="12" fill="${S.muted}">Contributed to (last year):</text>
        <text x="260" y="174" ${S.font} font-size="12" font-weight="600" fill="${S.text}">${user.repositoriesContributedTo.totalCount}</text>

        <circle cx="408" cy="112" r="38" fill="none" stroke="${S.border}" stroke-width="3"/>
        <circle cx="408" cy="112" r="38" fill="none" stroke="${S.accent}" stroke-width="3"
            stroke-dasharray="${ringFill.toFixed(1)} ${ringGap.toFixed(1)}"
            stroke-dashoffset="0"
            transform="rotate(-90 408 112)"/>
        <text x="408" y="119" ${S.font} font-size="17" font-weight="700" fill="${S.text}" text-anchor="middle">A+</text>

        <rect x="482" y="16" width="262" height="188" rx="8" fill="${S.bgCard}" stroke="${S.border}" stroke-width="0.5"/>
        <text x="506" y="44" ${S.font} font-size="14" font-weight="600" fill="${S.accent}">Most Used Languages</text>
        ${legendSVG}
        ${donutSVG}

        <rect x="16" y="220" width="728" height="94" rx="8" fill="${S.bgCard}" stroke="${S.border}" stroke-width="0.5"/>

        <text x="137" y="254" ${S.font} font-size="24" font-weight="700" fill="${S.text}" text-anchor="middle">${total.toLocaleString()}</text>
        <text x="137" y="270" ${S.font} font-size="11" fill="${S.muted}" text-anchor="middle">Total Contributions</text>
        <text x="137" y="284" ${S.font} font-size="10" fill="${S.muted}" text-anchor="middle">Apr 30, 2024 - Present</text>

        <line x1="259" y1="232" x2="259" y2="302" stroke="${S.border}" stroke-width="0.5"/>
        <line x1="501" y1="232" x2="501" y2="302" stroke="${S.border}" stroke-width="0.5"/>

        <circle cx="${scx}" cy="${scy}" r="${sr}" fill="none" stroke="${S.accent}" stroke-width="2.5"
            stroke-dasharray="${streakCirc.toFixed(1)} 0"/>
        <ellipse cx="${scx}" cy="${scy - sr - 6}" rx="5" ry="7" fill="#ff7b2c"/>
        <ellipse cx="${scx}" cy="${scy - sr - 4}" rx="3" ry="4" fill="#ffcc44"/>
        <text x="${scx}" y="${scy + 6}" ${S.font} font-size="18" font-weight="700" fill="${S.text}" text-anchor="middle">${streak.current}</text>
        <text x="${scx}" y="${scy + sr + 14}" ${S.font} font-size="11" fill="${S.accent}" text-anchor="middle">Current Streak</text>
        <text x="${scx}" y="${scy + sr + 26}" ${S.font} font-size="10" fill="${S.muted}" text-anchor="middle">${fmtDate(streak.startCurrent)} - ${fmtDate(streak.endCurrent)}</text>

        <text x="621" y="254" ${S.font} font-size="24" font-weight="700" fill="${S.text}" text-anchor="middle">${streak.longest}</text>
        <text x="621" y="270" ${S.font} font-size="11" fill="${S.muted}" text-anchor="middle">Longest Streak</text>
    </svg>`;
}

(async () => {
    console.log("Fetching GitHub data...");
    const user = await fetchData();

    const langs = topLangs(user.repositories.nodes);
    const streak = calcStreak(user.contributionsCollection.contributionCalendar.weeks);
    const stars = user.repositories.nodes.reduce((s, r) => s + r.stargazerCount, 0);

    const commits =
        (user.y0?.totalCommitContributions ?? 0) +
        (user.y1?.totalCommitContributions ?? 0) +
        (user.y0?.restrictedContributionsCount ?? 0) +
        (user.y1?.restrictedContributionsCount ?? 0);

    const prs =
        (user.y0?.totalPullRequestContributions ?? 0) +
        (user.y1?.totalPullRequestContributions ?? 0);

    const issues =
        (user.y0?.totalIssueContributions ?? 0) +
        (user.y1?.totalIssueContributions ?? 0);

    const followers = user.followers.totalCount;
    const commitsForRank = user.y0?.totalCommitContributions ?? 0;
    const rankPercentile = calculateRank({ commits: commitsForRank, prs, issues, stars, followers });

    const svg = generateSVG(user, streak, langs, stars, commits, prs, issues, rankPercentile);
    fs.writeFileSync("profile-card.svg", svg);
    console.log("Good: profile-card.svg saved");
})().catch(e => {
    console.error(e);
    process.exit(1);
});
