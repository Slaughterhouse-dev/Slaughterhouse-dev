const https = require("https");
const fs    = require("fs");

const USERNAME = "Slaughterhouse-dev";
const TOKEN    = process.env.GITHUB_TOKEN;

const S = {
    bg:      "#171517",
    bgCard:  "#1d1b1d",
    border:  "#212022",
    accent:  "#91a1f1",
    text:    "#c8c8c8",
    muted:   "#8c8c8c",
};

// ── fetch ────────────────────────────────────────────────────────────────────

function gql(query, variables) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ query, variables });
        const req = https.request({
            hostname: "api.github.com",
            path: "/graphql",
            method: "POST",
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
                "User-Agent": "profile-card-generator",
            },
        }, (res) => {
            let raw = "";
            res.on("data", c => raw += c);
            res.on("end", () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
        });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

async function fetchData() {
    // Fetch contributions for multiple years to get accurate totals
    const now   = new Date();
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
                repositories(ownerAffiliations: OWNER, isFork: false, first: 100) {
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
                        weeks {
                            contributionDays { contributionCount date }
                        }
                    }
                }
                ${yearFragments}
                repositoriesContributedTo(
                    first: 1
                    contributionTypes: [COMMIT, PULL_REQUEST, REPOSITORY, PULL_REQUEST_REVIEW]
                ) { totalCount }
            }
        }
    `, { login: USERNAME });

    return data.user;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function calcStreak(weeks) {
    const days  = weeks.flatMap(w => w.contributionDays).sort((a, b) => a.date < b.date ? 1 : -1);
    const today = new Date().toISOString().slice(0, 10);

    let current = 0, startCurrent = "", endCurrent = "";
    for (const d of days) {
        if (d.date > today) continue;
        if (current === 0 && d.contributionCount === 0 && d.date !== today) break;
        if (d.contributionCount > 0) {
            current++;
            if (!endCurrent) endCurrent = d.date;
            startCurrent = d.date;
        } else if (d.date !== today) break;
    }

    let longest = 0, temp = 0;
    for (const d of [...days].reverse()) {
        temp = d.contributionCount > 0 ? temp + 1 : 0;
        if (temp > longest) longest = temp;
    }

    return { current, longest, startCurrent, endCurrent };
}

function topLangs(repos) {
    const map = {};
    let total = 0;
    for (const repo of repos) {
        for (const { size, node } of repo.languages.edges) {
            if (!map[node.name]) map[node.name] = { size: 0, color: node.color || S.muted };
            map[node.name].size += size;
            total += size;
        }
    }
    return Object.entries(map)
        .sort((a, b) => b[1].size - a[1].size)
        .slice(0, 6)
        .map(([name, { size, color }]) => ({
            name: name.length > 13 ? name.slice(0, 12) + "." : name,
            color,
            pct: ((size / total) * 100).toFixed(1),
        }));
}

function fmtDate(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtNum(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

// ── SVG pieces ───────────────────────────────────────────────────────────────

function donut(langs, cx, cy, r) {
    const circ = 2 * Math.PI * r;
    let offset = 0;
    const segs = langs.map(({ color, pct }) => {
        const dash = (pct / 100) * circ;
        const seg  = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
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
<text x="${x + 11}" y="${y}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="11" fill="${S.text}">${name} <tspan fill="${S.muted}">${pct}%</tspan></text>`;
    }).join("");
}

// ── main SVG ─────────────────────────────────────────────────────────────────

function generateSVG(user, streak, langs, stars, commits, prs, issues) {
    const total = user.contributionsCollection.contributionCalendar.totalContributions;

    // Language card: x=482, width=262, so right edge=744
    // Legend: x=490..620, Donut: cx=710, cy=110
    const donutSVG  = donut(langs, 685, 119, 34);
    const legendSVG = langLegend(langs, 498, 68, 22);

    return `<svg width="760" height="330" viewBox="0 0 760 330" xmlns="http://www.w3.org/2000/svg" role="img">
<title>Slaughterhouse-dev GitHub Stats</title>

<!-- bg -->
<rect width="760" height="330" rx="10" fill="${S.bg}" stroke="${S.border}" stroke-width="1"/>

<!-- stats card -->
<rect x="16" y="16" width="454" height="188" rx="8" fill="${S.bgCard}" stroke="${S.border}" stroke-width="0.5"/>
<text x="32" y="44" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="14" font-weight="600" fill="${S.accent}">Slaughterhouse's GitHub Stats</text>

<text x="32"  y="78"  font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" fill="${S.muted}">Total Stars Earned:</text>
<text x="260" y="78"  font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" font-weight="600" fill="${S.text}">${stars}</text>

<text x="32"  y="102" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" fill="${S.muted}">Total Commits (last year):</text>
<text x="260" y="102" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" font-weight="600" fill="${S.text}">${fmtNum(commits)}</text>

<text x="32"  y="126" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" fill="${S.muted}">Total PRs:</text>
<text x="260" y="126" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" font-weight="600" fill="${S.text}">${prs}</text>

<text x="32"  y="150" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" fill="${S.muted}">Total Issues:</text>
<text x="260" y="150" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" font-weight="600" fill="${S.text}">${issues}</text>

<text x="32"  y="174" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" fill="${S.muted}">Contributed to (last year):</text>
<text x="260" y="174" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" font-weight="600" fill="${S.text}">${user.repositoriesContributedTo.totalCount}</text>

<!-- rank ring -->
<circle cx="408" cy="112" r="38" fill="none" stroke="${S.border}" stroke-width="3"/>
<circle cx="408" cy="112" r="38" fill="none" stroke="${S.accent}" stroke-width="3" stroke-dasharray="190 50" stroke-dashoffset="47" transform="rotate(-90 408 112)"/>
<text x="408" y="119" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="17" font-weight="700" fill="${S.text}" text-anchor="middle">A+</text>

<!-- languages card -->
<rect x="482" y="16" width="262" height="188" rx="8" fill="${S.bgCard}" stroke="${S.border}" stroke-width="0.5"/>
<text x="498" y="44" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="14" font-weight="600" fill="${S.accent}">Most Used Languages</text>
${legendSVG}
${donutSVG}

<!-- streak card -->
<rect x="16" y="220" width="728" height="94" rx="8" fill="${S.bgCard}" stroke="${S.border}" stroke-width="0.5"/>

<text x="192" y="254" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="24" font-weight="700" fill="${S.text}" text-anchor="middle">${total.toLocaleString()}</text>
<text x="192" y="272" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="11" fill="${S.muted}" text-anchor="middle">Total Contributions</text>
<text x="192" y="288" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="10" fill="${S.muted}" text-anchor="middle">Apr 30, 2024 - Present</text>

<line x1="368" y1="232" x2="368" y2="302" stroke="${S.border}" stroke-width="0.5"/>
<line x1="558" y1="232" x2="558" y2="302" stroke="${S.border}" stroke-width="0.5"/>

<text x="464" y="254" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="24" font-weight="700" fill="${S.text}" text-anchor="middle">${streak.current}</text>
<text x="464" y="272" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="11" fill="${S.accent}" text-anchor="middle">Current Streak</text>
<text x="464" y="288" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="10" fill="${S.muted}" text-anchor="middle">${fmtDate(streak.startCurrent)} - ${fmtDate(streak.endCurrent)}</text>

<text x="654" y="254" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="24" font-weight="700" fill="${S.text}" text-anchor="middle">${streak.longest}</text>
<text x="654" y="272" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="11" fill="${S.muted}" text-anchor="middle">Longest Streak</text>
</svg>`;
}

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
    console.log("Fetching GitHub data...");
    const user = await fetchData();

    const langs  = topLangs(user.repositories.nodes);
    const streak = calcStreak(user.contributionsCollection.contributionCalendar.weeks);
    const stars  = user.repositories.nodes.reduce((s, r) => s + r.stargazerCount, 0);

    // Sum commits/PRs/issues across fetched years
    const commits = (user.y0?.totalCommitContributions ?? 0) + (user.y1?.totalCommitContributions ?? 0);
    const prs     = (user.y0?.totalPullRequestContributions ?? 0) + (user.y1?.totalPullRequestContributions ?? 0);
    const issues  = (user.y0?.totalIssueContributions ?? 0) + (user.y1?.totalIssueContributions ?? 0);

    const svg = generateSVG(user, streak, langs, stars, commits, prs, issues);
    fs.writeFileSync("profile-card.svg", svg);
    console.log("Good: profile-card.svg saved");
})().catch(e => { console.error(e); process.exit(1); });
